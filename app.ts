// The forge's HTTP surface: git smart HTTP (lib/githttp.ts), GitHub REST v3, GraphQL v4
// (lib/graphql.ts) and an MCP endpoint over streamable HTTP, all served from one store
// (lib/store.ts). main.ts owns the entry <-> env lifecycle; this file is the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER, type Issue, type Pull, type Repo } from './lib/store.ts';
import { parseTree } from './lib/git.ts';
import { handleGitRequest } from './lib/githttp.ts';
import { executeGraphQL, nodeId } from './lib/graphql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

// ---------------------------------------------------------------- http helpers

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  sendText(res, status, `${JSON.stringify(body)}\n`, headers);
}

function sendText(res: ServerResponse, status: number, text: string, headers: Readonly<Record<string, string>> = {}): void {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, ...headers });
  res.end(buf);
}

function sendBufferJson(res: ServerResponse, status: number, buf: Buffer): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length });
  res.end(buf);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

interface Page<T> {
  readonly items: T[];
  readonly headers: Record<string, string>;
}

function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): Page<T> {
  const perPageRaw = Number(url.searchParams.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const linkUrl = (target: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(target));
    return `${baseUrlOf(req)}${url.pathname}?${params.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${linkUrl(page + 1)}>; rel="next"`, `<${linkUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${linkUrl(page - 1)}>; rel="prev"`, `<${linkUrl(1)}>; rel="first"`);
  }
  return { items: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------- JSON shapes

/** Node ids derive from immutable ids, so each is computed once per object. */
const repoNodeIds = new WeakMap<Repo, string>();
const issueNodeIds = new WeakMap<Issue, string>();

function repoNodeIdOf(repo: Repo): string {
  let id = repoNodeIds.get(repo);
  if (id === undefined) {
    id = nodeId('Repository', [repo.id]);
    repoNodeIds.set(repo, id);
  }
  return id;
}

function issueNodeIdOf(repo: Repo, issue: Issue): string {
  let id = issueNodeIds.get(issue);
  if (id === undefined) {
    id = nodeId('Issue', [repo.id, issue.number]);
    issueNodeIds.set(issue, id);
  }
  return id;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoNodeIdOf(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issueNodeIdOf(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/**
 * The serialised single-issue reply, cached per issue. The fingerprint covers every mutable
 * input of issueJson (title, body, state, label names and their colours, comment count and
 * updated_at; the rest derives from immutable ids), so a cached body is served only while it
 * is byte-for-byte what a fresh serialisation would produce.
 */
const issueTextCache = new WeakMap<Issue, { fp: string; buf: Buffer }>();

function issueFingerprint(repo: Repo, issue: Issue): string {
  let fp = `${issue.title}\0${issue.body}\0${issue.state}\0${issue.comments.length}\0${issue.updatedAt}`;
  for (const name of issue.labels) fp += `\0${name}:${repo.labels.get(name)?.color ?? 'ededed'}`;
  return fp;
}

function sendIssueJson(res: ServerResponse, repo: Repo, issue: Issue): void {
  const fp = issueFingerprint(repo, issue);
  const hit = issueTextCache.get(issue);
  if (hit !== undefined && hit.fp === fp) {
    sendBufferJson(res, 200, hit.buf);
    return;
  }
  const buf = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueTextCache.set(issue, { fp, buf });
  sendBufferJson(res, 200, buf);
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: nodeId('PullRequest', [repo.id, pull.number]),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

// ---------------------------------------------------------------- the server

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestSeq = 0;

  const authed = (req: IncomingMessage): boolean => {
    if (expectedToken === '') return true;
    return req.headers.authorization === `Bearer ${expectedToken}`;
  };

  const server = createServer((req, res) => {
    requestSeq += 1;
    res.setHeader('x-github-request-id', `req-${requestSeq}`);
    handle(forge, authed, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
      } else if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
  return server;
}

async function handle(
  forge: Forge,
  authed: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Fast paths for the two hottest REST shapes (single-issue read, issue create). Taken only
  // when the raw URL carries no '%' and no query string, so each segment is exactly what the
  // general path's decodeURIComponent would produce; the auth check, lookups, statuses, error
  // messages and reply builders below are the general path's own, in the same order.
  const rawUrl = req.url ?? '';
  if (!rawUrl.includes('%') && !rawUrl.includes('?')) {
    const fastMethod = req.method ?? 'GET';
    if (fastMethod === 'GET') {
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/([0-9]+)$/.exec(rawUrl);
      if (match !== null) {
        if (!authed(req)) throw new HttpError(401, 'Requires authentication');
        const owner = match[1] as string;
        const repo = owner === VIEWER.login ? forge.getRepo(owner, match[2] as string) : undefined;
        if (repo === undefined) throw new HttpError(404, 'Not Found');
        const issue = repo.issues.get(Number(match[3] as string));
        if (issue === undefined) throw new HttpError(404, 'Not Found');
        sendIssueJson(res, repo, issue);
        return;
      }
    } else if (fastMethod === 'POST') {
      const match = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(rawUrl);
      if (match !== null) {
        if (!authed(req)) throw new HttpError(401, 'Requires authentication');
        const owner = match[1] as string;
        const repo = owner === VIEWER.login ? forge.getRepo(owner, match[2] as string) : undefined;
        if (repo === undefined) throw new HttpError(404, 'Not Found');
        const body = await jsonBody(req);
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
        const labels = Array.isArray(body.labels) ? body.labels.map((label) => String(label)) : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label '${label}' does not exist`);
        }
        const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
    }
  }

  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') throw new HttpError(404, 'Not Found');
    if (!authed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    await handleGraphQL(forge, req, res);
    return;
  }

  if (path === '/mcp') {
    await handleMCP(forge, authed, req, res, method);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(forge, authed, req, res, method, url);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const sub = gitMatch[3] ?? '';
    await handleGitRequest(forge, req, res, owner, repoName, sub, url, readBody);
    return;
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL

async function handleGraphQL(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphQL(forge, (entry ?? {}) as Record<string, unknown>));
    sendJson(res, 200, results);
    return;
  }
  const result = executeGraphQL(forge, (parsed ?? {}) as Record<string, unknown>);
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------- REST v3

async function handleRest(
  forge: Forge,
  authed: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const rest = url.pathname.slice('/api/v3'.length);
  const segs = rest.split('/').filter((seg) => seg !== '').map((seg) => decodeURIComponent(seg));

  // The API root is served without auth (the starter's contract); everything else needs the token.
  if ((rest === '' || rest === '/') && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (!authed(req)) throw new HttpError(401, 'Requires authentication');

  if (segs[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: 'makefun-forge/1.0.0', github_services_sha: 'makefun-forge' });
    return;
  }

  if (segs[0] === 'user' && segs.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  if (segs[0] === 'user' && segs[1] === 'repos' && segs.length === 2) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      const created = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (created === 'exists') throw new HttpError(422, 'Repository creation failed: name already exists on this account');
      sendJson(res, 201, repoJson(created));
      return;
    }
    if (method === 'GET') {
      const page = paginate(req, url, forge.listRepos().map((repo) => repoJson(repo)));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
  }

  if (segs[0] === 'repos' && segs.length >= 3) {
    const owner = segs[1] as string;
    const repoName = segs[2] as string;
    const repo = owner === VIEWER.login ? forge.getRepo(owner, repoName) : undefined;
    if (repo === undefined) throw new HttpError(404, 'Not Found');
    const tail = segs.slice(3);
    await handleRepoRoutes(forge, req, res, method, url, repo, tail);
    return;
  }

  throw new HttpError(404, 'Not Found');
}

async function handleRepoRoutes(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  repo: Repo,
  tail: string[],
): Promise<void> {
  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) throw new HttpError(422, 'Validation Failed: renaming is not supported');
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendEmpty(res, 204);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // /branches and /branches/{name...}
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = paginate(req, url, branches);
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // /git/refs...
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = await jsonBody(req);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      const obj = forge.store.get(sha);
      if (ref === '' || obj === undefined) throw new HttpError(422, 'Validation Failed: object does not exist');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.refsVersion += 1;
      sendJson(res, 201, { ref, object: { sha, type: obj.type } });
      return;
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      const obj = forge.store.get(sha);
      sendJson(res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // /commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    let tip: string | undefined;
    if (shaParam !== null && shaParam !== '') {
      tip = forge.branchTip(repo, shaParam) ?? (forge.store.get(shaParam)?.type === 'commit' ? shaParam : undefined);
    } else {
      tip = forge.branchTip(repo, repo.defaultBranch);
    }
    if (tip === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const items = forge.listCommits(tip).map((commit) => ({
      sha: commit.sha,
      commit: {
        message: commit.message,
        author: authorJson(commit.author),
        committer: authorJson(commit.committer),
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    }));
    const page = paginate(req, url, items);
    sendJson(res, 200, page.items, page.headers);
    return;
  }

  // /contents/{path...}
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    await handleContents(forge, req, res, method, url, repo, path);
    return;
  }

  // /labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: label already exists');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { id: repo.labels.size, name, color, default: false });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // /issues...
  if (tail[0] === 'issues') {
    await handleIssues(forge, req, res, method, url, repo, tail.slice(1));
    return;
  }

  // /pulls...
  if (tail[0] === 'pulls') {
    await handlePulls(forge, req, res, method, url, repo, tail.slice(1));
    return;
  }

  throw new HttpError(404, 'Not Found');
}

function authorJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function handleContents(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  repo: Repo,
  path: string,
): Promise<void> {
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, ref) ?? (forge.store.get(ref)?.type === 'commit' ? ref : undefined);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const treeSha = forge.treeOfCommit(tip);
    if (treeSha === null) throw new HttpError(404, 'Not Found');
    const files = forge.flattenTree(treeSha);
    const file = path === '' ? undefined : files.get(path);
    if (file !== undefined) {
      const obj = forge.store.get(file.sha);
      const data = obj?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
      return;
    }
    // Directory listing (root when path is '').
    const prefix = path === '' ? '' : `${path}/`;
    if (path !== '' && ![...files.keys()].some((key) => key.startsWith(prefix))) throw new HttpError(404, 'Not Found');
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, info] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', name: rest, path: filePath, sha: info.sha });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          entries.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirTreeSha(forge, treeSha, `${prefix}${dirName}`) });
        }
      }
    }
    const list = [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, list);
    return;
  }

  if (method === 'PUT') {
    const body = await jsonBody(req);
    const message = typeof body.message === 'string' ? body.message : '';
    const contentBase64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const files = forge.filesAt(repo, branch);
    const existing = files.get(path);
    if (existing !== undefined) {
      if (typeof body.sha !== 'string') throw new HttpError(422, 'Validation Failed: sha is required when updating');
      if (body.sha !== existing.sha) throw new HttpError(409, 'Conflict: sha does not match the current blob');
    }
    const bytes = Buffer.from(contentBase64, 'base64');
    const { commitSha, blobShas } = forge.commitFiles(repo, branch, new Map([[path, bytes]]), message);
    sendJson(res, existing !== undefined ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobShas.get(path),
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitSha, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const body = await jsonBody(req);
    const message = typeof body.message === 'string' ? body.message : '';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const files = forge.filesAt(repo, branch);
    const existing = files.get(path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.sha) throw new HttpError(409, 'Conflict: sha does not match the current blob');
    const { commitSha } = forge.commitFiles(repo, branch, new Map([[path, null]]), message);
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    return;
  }

  throw new HttpError(404, 'Not Found');
}

/** The tree sha of a directory inside a root tree, walking path segments. */
function dirTreeSha(forge: Forge, rootTreeSha: string, dirPath: string): string {
  let current = rootTreeSha;
  for (const segment of dirPath.split('/').filter((seg) => seg !== '')) {
    const entries = treeEntries(forge, current);
    const next = entries.find((entry) => entry.name === segment);
    if (next === undefined) return current;
    current = next.sha;
  }
  return current;
}

function treeEntries(forge: Forge, treeSha: string): { name: string; sha: string; mode: string }[] {
  const obj = forge.store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

async function handleIssues(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  repo: Repo,
  tail: string[],
): Promise<void> {
  void forge;
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
      const labels = Array.isArray(body.labels) ? body.labels.map((label) => String(label)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) throw new HttpError(422, `Validation Failed: label '${label}' does not exist`);
      }
      const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const page = paginate(req, url, items.map((issue) => issueJson(repo, issue)));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) throw new HttpError(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') {
      sendIssueJson(res, repo, issue);
      return;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req);
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.updatedAt = forge.nowIso();
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  if (tail[1] === 'comments' && tail.length === 2) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      const comment = forge.addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
      sendJson(res, 201, commentJson(comment));
      return;
    }
    if (method === 'GET') {
      const page = paginate(req, url, issue.comments.map((comment) => commentJson(comment)));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
  }

  throw new HttpError(404, 'Not Found');
}

async function handlePulls(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  repo: Repo,
  tail: string[],
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await jsonBody(req);
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const baseRaw = typeof body.base === 'string' ? body.base : '';
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const pull = forge.createPull(
        repo,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '',
        head,
        base,
      );
      if (pull === 'no-branch') throw new HttpError(422, 'Validation Failed: head or base branch does not exist');
      if (pull === 'no-diff') throw new HttpError(422, 'Validation Failed: no commits between base and head');
      if (pull === 'exists') throw new HttpError(422, 'Validation Failed: a pull request already exists for this branch');
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed' || pull.merged);
      items.sort((a, b) => a.number - b.number);
      const page = paginate(req, url, items.map((pull) => pullJson(forge, repo, pull)));
      sendJson(res, 200, page.items, page.headers);
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) throw new HttpError(404, 'Not Found');

  if (tail.length === 1 && method === 'GET') {
    sendJson(res, 200, pullJson(forge, repo, pull));
    return;
  }

  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    const files = forge.pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
    }));
    const page = paginate(req, url, files);
    sendJson(res, 200, page.items, page.headers);
    return;
  }

  if (tail[1] === 'merge' && tail.length === 2 && method === 'PUT') {
    const body = await jsonBody(req);
    const methodText = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const mergeMethod = methodText === 'squash' ? 'squash' : methodText === 'rebase' ? 'rebase' : 'merge';
    const result = forge.mergePull(repo, pull, mergeMethod);
    if (result === 'conflict') throw new HttpError(405, 'Pull Request is not mergeable');
    if (result === 'not-open') throw new HttpError(405, 'Pull Request is not mergeable');
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  throw new HttpError(404, 'Not Found');
}

// ---------------------------------------------------------------- MCP

const MCP_ACCEPTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function stringProp(description: string): Record<string, unknown> {
  return { type: 'string', description };
}

const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner login (the authenticated user)'),
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner'), repo: stringProp('The repository name') },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
      },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        state: stringProp('Issue state filter: open, closed or all'),
      },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch'),
        base: stringProp('The base branch'),
      },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
      },
    },
  },
];

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleMCP(
  forge: Forge,
  authed: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
): Promise<void> {
  if (method === 'DELETE') {
    sendEmpty(res, 200);
    return;
  }
  if (method !== 'POST') throw new HttpError(404, 'Not Found');
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const message = (parsed ?? {}) as Record<string, unknown>;
  const id = message.id;
  const rpcMethod = typeof message.method === 'string' ? message.method : '';
  const params = (message.params !== null && typeof message.params === 'object' ? message.params : {}) as Record<string, unknown>;

  if (id === undefined) {
    // A notification: accepted, never answered.
    sendEmpty(res, 202);
    return;
  }

  if (rpcMethod === 'server/discover') {
    const meta = (params._meta !== null && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
    const declared = typeof meta['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? (meta['io.modelcontextprotocol/protocolVersion'] as string)
      : typeof meta.protocolVersion === 'string'
        ? (meta.protocolVersion as string)
        : null;
    if (declared !== null && !MCP_ACCEPTED_REVISIONS.includes(declared)) {
      sendJson(res, 200, rpcError(id, -32022, 'Unsupported protocol version', { supported: MCP_ACCEPTED_REVISIONS }));
      return;
    }
    sendJson(res, 200, rpcResult(id, {
      resultType: 'complete',
      supportedVersions: MCP_ACCEPTED_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    }));
    return;
  }

  if (rpcMethod === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    if (offered !== null && !MCP_ACCEPTED_REVISIONS.includes(offered)) {
      sendJson(res, 200, rpcError(id, -32602, `Unsupported protocol version ${offered}`));
      return;
    }
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: offered ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    }));
    return;
  }

  if (rpcMethod === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }

  if (rpcMethod === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: MCP_TOOLS }));
    return;
  }

  if (rpcMethod === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      sendJson(res, 200, rpcError(id, -32601, `Tool ${name} not found`));
      return;
    }
    const outcome = callTool(forge, name, args);
    if (outcome.kind === 'invalid') {
      sendJson(res, 200, rpcError(id, -32602, outcome.message));
      return;
    }
    sendJson(res, 200, rpcResult(id, outcome.result));
    return;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method ${rpcMethod} not found`));
}

type ToolOutcome = { kind: 'ok'; result: Record<string, unknown> } | { kind: 'invalid'; message: string };

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const repoOf = (): Repo | null => forge.getRepo(str('owner') || VIEWER.login, str('repo')) ?? null;

  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoName === '') return { kind: 'invalid', message: 'name is required' };
      const created = forge.createRepo(repoName, args.private === true, str('description'));
      const repo = created === 'exists' ? (forge.getRepo(VIEWER.login, repoName) as Repo) : created;
      return { kind: 'ok', result: toolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return { kind: 'ok', result: toolErrorResult('repository not found') };
      return { kind: 'ok', result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      if (str('repo') === '' || str('title') === '') return { kind: 'invalid', message: 'owner, repo and title are required' };
      const repo = repoOf();
      if (repo === null) return { kind: 'ok', result: toolErrorResult('repository not found') };
      const issue = forge.createIssue(repo, str('title'), str('body'), []);
      return { kind: 'ok', result: toolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return { kind: 'ok', result: toolErrorResult('repository not found') };
      const state = str('state') === '' ? 'open' : str('state');
      let items = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => a.seq - b.seq);
      return { kind: 'ok', result: toolResult({ issues: items.map((issue) => issueJson(repo, issue)) }) };
    }
    case 'create_pull_request': {
      if (str('repo') === '' || str('title') === '' || str('head') === '' || str('base') === '') {
        return { kind: 'invalid', message: 'owner, repo, title, head and base are required' };
      }
      const repo = repoOf();
      if (repo === null) return { kind: 'ok', result: toolErrorResult('repository not found') };
      const pull = forge.createPull(repo, str('title'), str('body'), str('head'), str('base'));
      if (typeof pull !== 'object') return { kind: 'ok', result: toolErrorResult(`cannot create pull request: ${pull}`) };
      return { kind: 'ok', result: toolResult(pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return { kind: 'ok', result: toolErrorResult('repository not found') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return { kind: 'ok', result: toolErrorResult('pull request not found') };
      const result = forge.mergePull(repo, pull, 'squash');
      if (result === 'conflict') return { kind: 'ok', result: toolErrorResult('pull request is not mergeable') };
      if (result === 'not-open') return { kind: 'ok', result: toolErrorResult('pull request is not open') };
      return { kind: 'ok', result: toolResult({ sha: result.sha, merged: true, message: 'Pull Request successfully merged' }) };
    }
    default:
      return { kind: 'invalid', message: `unknown tool ${name}` };
  }
}
