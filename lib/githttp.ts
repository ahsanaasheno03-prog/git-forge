// Git smart HTTP: info/refs advertisements (protocol v0 and v2), v2 ls-refs and fetch, v0 fetch,
// and receive-pack with report-status. Objects move as packfiles; deltas are never sent (plain
// packs are always valid) but are accepted and resolved when a client sends them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, ZERO_SHA, type Repo } from './store.ts';
import {
  buildPack,
  parsePack,
  parseCommit,
  pktLine,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';

const PKT_DELIM = Buffer.from('0001', 'latin1');
const AGENT = 'makefun-forge/1.0.0';

interface Pkt {
  readonly type: 'data' | 'flush' | 'delim';
  readonly data: Buffer;
}

/** Read pkt-lines from `buf` starting at `start`; stops after the first flush packet. */
function readPkts(buf: Buffer, start: number): { pkts: Pkt[]; next: number } {
  const pkts: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      pkts.push({ type: 'flush', data: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (len === 1) {
      pkts.push({ type: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      pkts.push({ type: 'delim', data: Buffer.alloc(0) });
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > buf.length) break;
    pkts.push({ type: 'data', data: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { pkts, next: offset };
}

function lineText(data: Buffer): string {
  return data.toString('utf8').replace(/\n$/, '');
}

/** Frame a byte stream as sideband-64k pkt-lines on band 1. */
function sidebandFrames(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** The commit a tag object (chain) points at, or null. */
function peelToCommit(forge: Forge, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = forge.store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const match = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1] as string;
  }
  return null;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------------------------------------------------------------- advertisements

function advertisementV0(forge: Forge, repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  let first = true;
  const refLine = (sha: string, name: string): void => {
    if (first) {
      parts.push(pktLine(Buffer.concat([Buffer.from(`${sha} ${name}\0${caps}\n`, 'utf8')])));
      first = false;
    } else {
      parts.push(pktLine(`${sha} ${name}\n`));
    }
  };
  if (headTip !== undefined) refLine(headTip, 'HEAD');
  for (const [name, sha] of sortedRefs(repo)) {
    refLine(sha, name);
    const obj = forge.store.get(sha);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(forge, sha);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  if (first) {
    // Empty repository: the capabilities pseudo-ref.
    parts.push(pktLine(Buffer.from(`${ZERO_SHA} capabilities^{}\0${caps}\n`, 'utf8')));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const obj = forge.store.get(sha);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(forge, sha);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

function computeFetch(forge: Forge, req: FetchRequest): { objects: GitObject[]; shallowLines: string[] } {
  const delivered = new Set<string>();
  const shallowLines: string[] = [];
  if (req.deepen !== null && req.deepen > 0) {
    // Generation-limited walk from the wants: generation 1 is the wants themselves.
    const generation = new Map<string, number>();
    let frontier = [...new Set(req.wants)];
    for (const want of frontier) generation.set(want, 1);
    let gen = 1;
    const includedCommits: string[] = [];
    while (frontier.length > 0 && gen <= req.deepen) {
      const next: string[] = [];
      for (const sha of frontier) {
        const obj = forge.store.get(sha);
        if (obj === undefined) continue;
        if (obj.type === 'tag') {
          forge.closureFrom(sha, delivered);
          continue;
        }
        if (obj.type !== 'commit') continue;
        includedCommits.push(sha);
        const commit = parseCommit(obj.data);
        // The commit's tree and everything under it.
        forge.closureFrom(commit.tree, delivered);
        delivered.add(sha);
        if (gen === req.deepen) {
          if (commit.parents.length > 0) shallowLines.push(sha);
        } else {
          for (const parent of commit.parents) {
            if (!generation.has(parent)) {
              generation.set(parent, gen + 1);
              next.push(parent);
            }
          }
        }
      }
      frontier = next;
      gen += 1;
    }
    void includedCommits;
    // In a depth-limited fetch the client holds its shallow-boundary commits WITHOUT their
    // history: a shallow-listed commit excludes only itself and its tree closure, never its
    // ancestors (delivering those ancestors is the whole point of deepen). A have that is not
    // shallow-listed is held in full, so its whole closure is excluded.
    const excluded = new Set<string>();
    for (const shallowSha of req.shallow) {
      const obj = forge.store.get(shallowSha);
      if (obj !== undefined && obj.type === 'commit') {
        excluded.add(shallowSha);
        forge.closureFrom(parseCommit(obj.data).tree, excluded);
      } else if (obj !== undefined) {
        forge.closureFrom(shallowSha, excluded);
      }
    }
    for (const have of req.haves) {
      if (!req.shallow.includes(have)) forge.closureFrom(have, excluded);
    }
    for (const sha of excluded) delivered.delete(sha);
  } else {
    for (const want of req.wants) forge.closureFrom(want, delivered);
    const haveClosure = new Set<string>();
    for (const have of req.haves) forge.closureFrom(have, haveClosure);
    for (const sha of haveClosure) delivered.delete(sha);
  }
  const objects: GitObject[] = [];
  for (const sha of delivered) {
    const obj = forge.store.get(sha);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallowLines };
}

function fetchResponse(forge: Forge, repo: Repo, req: FetchRequest, version2: boolean): Buffer {
  void repo;
  const { objects, shallowLines } = computeFetch(forge, req);
  const pack = buildPack(objects);
  if (!version2) {
    const parts: Buffer[] = [];
    for (const sha of shallowLines) parts.push(pktLine(`shallow ${sha}\n`));
    parts.push(pktLine('NAK\n'));
    parts.push(sidebandFrames(pack));
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  if (req.wants.length === 0) {
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  if (shallowLines.length > 0) {
    parts.push(PKT_DELIM);
    parts.push(pktLine('shallow-info\n'));
    for (const sha of shallowLines) parts.push(pktLine(`shallow ${sha}\n`));
  }
  parts.push(PKT_DELIM);
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandFrames(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: readonly string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const line of lines) {
    if (line.startsWith('want ')) req.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) req.deepen = Number(line.slice(7).trim()) || null;
  }
  return req;
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { pkts, next } = readPkts(body, 0);
  const commands: RefCommand[] = [];
  let capabilities = '';
  for (const pkt of pkts) {
    if (pkt.type !== 'data') continue;
    let text = lineText(pkt.data);
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3) {
      commands.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = body.subarray(next);
  let unpackLine = 'unpack ok\n';
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const { objects } = parsePack(packBytes, forge.store);
      for (const obj of objects) forge.store.putKnown(obj.sha, obj.type, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackLine = `unpack ${err instanceof Error ? err.message : String(err)}\n`;
    }
  }
  const reportLines: string[] = [unpackLine];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const result = applyRefUpdate(forge, repo, command);
    reportLines.push(result === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${result}\n`);
  }
  const reportParts: Buffer[] = reportLines.map((line) => pktLine(line));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.includes('side-band-64k')) return sidebandFrames(report);
  return report;
}

/** Apply one ref update; returns null on success or the ng reason. */
function applyRefUpdate(forge: Forge, repo: Repo, command: RefCommand): string | null {
  const { oldSha, newSha, ref } = command;
  if (newSha === ZERO_SHA) {
    repo.refs.delete(ref);
    return null;
  }
  const obj = forge.store.get(newSha);
  if (obj === undefined) return 'not a valid object';
  if (ref.startsWith('refs/heads/') && obj.type !== 'commit') return 'not a commit';
  const current = repo.refs.get(ref);
  if (current !== undefined && oldSha !== ZERO_SHA && current !== oldSha) return 'reference is not current';
  if (ref.startsWith('refs/heads/') && current !== undefined && current !== newSha) {
    if (!forge.isAncestor(current, newSha)) return 'non-fast-forward';
  }
  repo.refs.set(ref, newSha);
  return null;
}

// ---------------------------------------------------------------- entry point

export async function handleGitRequest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  url: URL,
  readBody: (req: IncomingMessage) => Promise<Buffer>,
): Promise<void> {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
    return;
  }
  if (sub === '/info/refs' && req.method === 'GET') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'text/plain; charset=utf-8', Buffer.from('missing service\n'));
      return;
    }
    const protocol = req.headers['git-protocol'];
    const wantsV2 = service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2');
    const body = wantsV2 ? advertisementV2() : advertisementV0(forge, repo, service);
    sendBuffer(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }
  if (sub === '/git-upload-pack' && req.method === 'POST') {
    const body = await readBody(req);
    const { pkts } = readPkts(body, 0);
    const dataLines = pkts.filter((pkt) => pkt.type === 'data').map((pkt) => lineText(pkt.data));
    const first = dataLines[0] ?? '';
    if (first.startsWith('command=ls-refs')) {
      const delimIndex = pkts.findIndex((pkt) => pkt.type === 'delim');
      const argLines = (delimIndex >= 0 ? pkts.slice(delimIndex + 1) : pkts)
        .filter((pkt) => pkt.type === 'data')
        .map((pkt) => lineText(pkt.data));
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefs(forge, repo, argLines));
      return;
    }
    if (first.startsWith('command=fetch')) {
      const fetchReq = parseFetchArgs(dataLines);
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponse(forge, repo, fetchReq, true));
      return;
    }
    // Protocol v0 fetch: want lines (caps on the first), shallow/deepen, flush, haves, done.
    const fetchReq = parseFetchArgs(dataLines.map((line) => {
      const space = line.indexOf(' ');
      if (line.startsWith('want ') && line.includes(' ', 5)) {
        // strip capabilities that follow the oid on the first want line
        const oid = line.slice(5, 45);
        return `want ${oid}`;
      }
      void space;
      return line;
    }));
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', fetchResponse(forge, repo, fetchReq, false));
    return;
  }
  if (sub === '/git-receive-pack' && req.method === 'POST') {
    const body = await readBody(req);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', receivePack(forge, repo, body));
    return;
  }
  sendBuffer(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n'));
}
