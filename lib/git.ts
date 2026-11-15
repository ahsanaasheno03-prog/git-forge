// Pure-Node git object model and packfile codec (no git binary, standard library only).
// Objects are addressed by their SHA-1 over "<type> <len>\0" + payload, exactly as git computes them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** An in-memory object database. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  putKnown(sha: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function formatCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export function parseCommit(data: Buffer): CommitInfo {
  const blank = data.indexOf('\n\n');
  const headText = data.subarray(0, blank === -1 ? data.length : blank).toString('utf8');
  const message = blank === -1 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string; // "100644", "100755", "120000", or "40000" for directories
  readonly name: string;
  readonly sha: string;
}

function treeSortKey(entry: TreeEntry): string {
  // Git sorts tree entries by name, directories as if the name had a trailing '/'.
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function formatTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta (from a packfile) to a base object payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

// ---------------------------------------------------------------- packfiles

interface RawPackEntry {
  readonly kind: 'plain' | 'ofs-delta' | 'ref-delta';
  readonly plainType?: GitObjectType;
  readonly data: Buffer; // inflated payload (the delta bytes for delta entries)
  readonly baseOffset?: number;
  readonly baseSha?: string;
  readonly start: number;
}

/**
 * Inflate the zlib stream at the front of `buf`, returning the payload and the number of compressed
 * bytes it occupied. Node's inflateSync tolerates trailing bytes, so the consumed length is the
 * smallest prefix that inflates to exactly `expectedSize` bytes.
 *
 * Fast path: one inflateSync with { info: true }; the returned engine's bytesWritten is exactly the
 * number of input bytes the stream consumed (verified against deflateSync output of many sizes).
 * The result is validated (payload size, consumed within the buffer) and any doubt falls back to
 * the prefix search below, so a Node whose engine does not report consumption stays correct.
 */
function inflatePrefix(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  try {
    const result = inflateSync(buf, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: unknown };
    };
    const consumed = result.engine?.bytesWritten;
    if (
      result.buffer.length === expectedSize &&
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed > 0 &&
      consumed <= buf.length
    ) {
      return { data: result.buffer, consumed };
    }
  } catch {
    // A truncated or corrupt stream throws here exactly as in the search below; fall through.
  }
  return inflatePrefixBySearch(buf, expectedSize);
}

/** The original prefix search: binary-search the smallest prefix that inflates to the payload. */
function inflatePrefixBySearch(buf: Buffer, expectedSize: number): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let out: Buffer | null = null;
    try {
      out = inflateSync(buf.subarray(0, mid));
    } catch {
      out = null;
    }
    if (out !== null && out.length === expectedSize) {
      best = out;
      hi = mid - 1;
    } else if (out !== null) {
      // Inflated but wrong length: the stream ended (trailing bytes ignored) yet the payload is not
      // the expected size — cannot happen for a well-formed pack entry; treat as a longer stream.
      lo = mid + 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('corrupt zlib stream in packfile');
  // Recompute the exact consumed length: the smallest prefix that produced `best`.
  let consumed = buf.length;
  let l = 1;
  let r = buf.length;
  while (l <= r) {
    const mid = (l + r) >> 1;
    let ok = false;
    try {
      ok = inflateSync(buf.subarray(0, mid)).length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      consumed = mid;
      r = mid - 1;
    } else {
      l = mid + 1;
    }
  }
  return { data: best, consumed };
}

/** Parse a packfile into resolved objects, applying deltas (bases in the pack or the store). */
export function parsePack(pack: Buffer, store: ObjectStore): { objects: GitObject & { sha: string }[]; count: number } {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: RawPackEntry[] = [];
  const indexByOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeCode === 7) {
      baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflatePrefix(pack.subarray(offset), size);
    offset += consumed;
    if (typeCode === 6) raw.push({ kind: 'ofs-delta', data, baseOffset, start });
    else if (typeCode === 7) raw.push({ kind: 'ref-delta', data, baseSha, start });
    else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      raw.push({ kind: 'plain', plainType: type, data, start });
    }
    indexByOffset.set(start, raw.length - 1);
  }
  const resolved = new Array<{ type: GitObjectType; data: Buffer } | undefined>(raw.length).fill(undefined);
  const resolve = (index: number): { type: GitObjectType; data: Buffer } => {
    const hit = resolved[index];
    if (hit !== undefined) return hit;
    const entry = raw[index] as RawPackEntry;
    let out: { type: GitObjectType; data: Buffer };
    if (entry.kind === 'plain') {
      out = { type: entry.plainType as GitObjectType, data: entry.data };
    } else {
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.kind === 'ofs-delta') {
        const baseIndex = indexByOffset.get(entry.baseOffset as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIndex);
      } else {
        const want = entry.baseSha as string;
        for (let j = 0; j < raw.length; j += 1) {
          const candidate = resolve(j);
          if (objectId(candidate.type, candidate.data) === want) {
            base = candidate;
            break;
          }
        }
        if (base === undefined) {
          const stored = store.get(want);
          if (stored === undefined) throw new Error(`ref-delta base ${want} not found`);
          base = stored;
        }
      }
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved[index] = out;
    return out;
  };
  const objects: (GitObject & { sha: string })[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const obj = resolve(i);
    objects.push({ sha: objectId(obj.type, obj.data), type: obj.type, data: obj.data });
  }
  return { objects, count };
}

/** Build a packfile containing the given objects, undeltified. */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        const b = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? b | 0x80 : b);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    // Level 1: any zlib level is a valid pack stream, and the small objects a fetch serves
    // deflate several times faster here than at the default level for a few bytes more.
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (4-hex length prefix including itself). Empty string encodes a flush packet. */
export function pktLine(payload: string | Buffer): Buffer {
  if (payload.length === 0) return Buffer.from('0000', 'latin1');
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([prefix, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');

/** Split a buffer of pkt-lines into payloads; a null entry marks a flush packet. */
export function parsePktLines(buf: Buffer, start = 0): { lines: (Buffer | null)[]; next: number } {
  const lines: (Buffer | null)[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      lines.push(null);
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return { lines, next: offset };
}
