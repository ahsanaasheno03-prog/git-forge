// The forge's state and domain logic: repositories, a shared git object store, refs, issues, labels,
// comments and pull requests, plus the git engine (trees, closures, merges) the HTTP surfaces share.
//
// One viewer owns everything: the trial's bearer token names this login (the suite's scenario fixes
// it), and repositories live under it. Times come from a logical clock — a fixed base plus a tick per
// event — so identical operation sequences produce identical state.

import {
  ObjectStore,
  formatCommit,
  formatTree,
  isTreeMode,
  objectId,
  parseCommit,
  parseTree,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const ZERO_SHA = '0'.repeat(40);
const CLOCK_BASE_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Pull {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string; // base tip when the pull was opened; the merge base
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly seq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  refs: Map<string, string>;
  refsVersion: number; // bumped on every refs mutation; lets the HTTP layer cache ref-derived replies
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // issues and pull requests share one sequence, as on GitHub
  nextCommentId: number;
  readonly createdAt: string;
}

export class Forge {
  readonly store = new ObjectStore();
  objectsVersion = 0; // bumped whenever a received pack stores objects; see githttp's caches
  readonly repos = new Map<string, Repo>();
  private repoSeq = 5000;
  private clockTick = 0;
  private commentSeq = 0;

  /** A logical timestamp: fixed base plus one second per call, as an ISO string. */
  nowIso(): string {
    this.clockTick += 1;
    return isoFromEpochSec(CLOCK_BASE_SEC + this.clockTick);
  }

  /** A git author/committer line for API-created commits, on the logical clock. */
  identityLine(): string {
    this.clockTick += 1;
    return `${VIEWER.name} <${VIEWER.email}> ${CLOCK_BASE_SEC + this.clockTick} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, priv: boolean, description: string): Repo | 'exists' {
    const key = this.key(VIEWER.login, name);
    if (this.repos.has(key)) return 'exists';
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER.login,
      name,
      private: priv,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      refsVersion: 0,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: this.nowIso(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------- git engine

  /** Flatten a tree (recursively) into path -> {mode, sha}. */
  flattenTree(treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
    const obj = this.store.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isTreeMode(entry.mode)) this.flattenTree(entry.sha, path, out);
      else out.set(path, { mode: entry.mode, sha: entry.sha });
    }
    return out;
  }

  treeOfCommit(commitSha: string): string | null {
    const obj = this.store.get(commitSha);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Build (and store) a tree from a flat path -> {mode, sha} map; returns its sha. */
  buildTree(files: ReadonlyMap<string, { mode: string; sha: string }>): string {
    interface Node {
      files: Map<string, { mode: string; sha: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, file);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, sha: file.sha });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, sha: build(dir) });
      return this.store.put('tree', formatTree(entries));
    };
    return build(root);
  }

  /** Create a commit on top of `parent` (or a root commit) with the given tree; returns its sha. */
  makeCommit(treeSha: string, parent: string | null, message: string): string {
    const ident = this.identityLine();
    return this.store.put('commit', formatCommit({
      tree: treeSha,
      parents: parent === null ? [] : [parent],
      author: ident,
      committer: ident,
      message,
    }));
  }

  /** All objects reachable from a commit/tag sha (commits, trees, blobs, tags). */
  closureFrom(tip: string, into = new Set<string>()): Set<string> {
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (into.has(sha)) continue;
      const obj = this.store.get(sha);
      if (obj === undefined) continue;
      into.add(sha);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.sha);
      } else if (obj.type === 'tag') {
        const target = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
        if (target !== null) stack.push(target[1] as string);
      }
    }
    return into;
  }

  /** Commit ancestry: is `ancestor` reachable from `descendant` through parent links? */
  isAncestor(ancestor: string, descendant: string): boolean {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.store.get(sha);
      if (obj !== undefined && obj.type === 'commit') stack.push(...commitParents(obj.data));
    }
    return false;
  }

  /** Commits reachable from a tip, newest first (committer time, then discovery order). */
  listCommits(tip: string): { sha: string; message: string; author: string; committer: string; parents: string[]; time: number }[] {
    const seen = new Set<string>();
    const out: { sha: string; message: string; author: string; committer: string; parents: string[]; time: number }[] = [];
    const queue = [tip];
    while (queue.length > 0) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.store.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      const timeMatch = / (\d+) [+-]\d{4}$/.exec(commit.committer);
      out.push({
        sha,
        message: commit.message,
        author: commit.author,
        committer: commit.committer,
        parents: [...commit.parents],
        time: timeMatch === null ? 0 : Number(timeMatch[1]),
      });
      queue.push(...commit.parents);
    }
    out.sort((a, b) => b.time - a.time);
    return out;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tree flat map at a branch (empty map when the branch does not exist). */
  filesAt(repo: Repo, branch: string): Map<string, { mode: string; sha: string }> {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return new Map();
    const tree = this.treeOfCommit(tip);
    if (tree === null) return new Map();
    return this.flattenTree(tree);
  }

  /**
   * Commit a set of file changes (path -> content, or null to delete) onto a branch, creating the
   * branch (and the repo's first commit) when needed. Returns the new commit sha and the blob shas.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    changes: ReadonlyMap<string, Buffer | null>,
    message: string,
  ): { commitSha: string; blobShas: Map<string, string> } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      // Fork from the default branch when there is one; otherwise start unborn.
      tip = branch === repo.defaultBranch ? undefined : this.branchTip(repo, repo.defaultBranch);
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const files = tip === undefined ? new Map<string, { mode: string; sha: string }>() : this.filesAt(repo, branch);
    const blobShas = new Map<string, string>();
    for (const [path, content] of changes) {
      if (content === null) {
        files.delete(path);
      } else {
        const sha = this.store.put('blob', content);
        blobShas.set(path, sha);
        const existing = files.get(path);
        files.set(path, { mode: existing?.mode ?? '100644', sha });
      }
    }
    const treeSha = this.buildTree(files);
    const commitSha = this.makeCommit(treeSha, tip ?? null, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.refsVersion += 1;
    return { commitSha, blobShas };
  }

  // -------------------------------------------------------------- merges

  /**
   * Three-way tree merge for a pull request: mergeBase tree vs head tree vs the current base tree.
   * Returns the merged flat file map, or null on a textual conflict (same path changed both ways).
   */
  mergeTrees(repo: Repo, pull: Pull): Map<string, { mode: string; sha: string }> | null {
    const baseTreeSha = this.treeOfCommit(pull.baseSha);
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headTreeSha = this.treeOfCommit(headTip);
    const currentBaseTip = this.branchTip(repo, pull.baseRef);
    if (baseTreeSha === null || headTreeSha === null || currentBaseTip === undefined) return null;
    const currentTreeSha = this.treeOfCommit(currentBaseTip);
    if (currentTreeSha === null) return null;
    const baseFiles = this.flattenTree(baseTreeSha);
    const headFiles = this.flattenTree(headTreeSha);
    const currentFiles = this.flattenTree(currentTreeSha);
    const merged = new Map(currentFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const base = baseFiles.get(path)?.sha;
      const head = headFiles.get(path)?.sha;
      const current = currentFiles.get(path)?.sha;
      const headChanged = head !== base;
      const currentChanged = current !== base;
      if (headChanged && currentChanged && head !== current) return null;
      if (headChanged && !currentChanged) {
        if (head === undefined) merged.delete(path);
        else merged.set(path, headFiles.get(path) as { mode: string; sha: string });
      }
    }
    return merged;
  }

  /** Merge a pull request (squash or merge commit). Returns {sha} or 'conflict' / 'not-open'. */
  mergePull(repo: Repo, pull: Pull, method: 'merge' | 'squash' | 'rebase'): { sha: string } | 'conflict' | 'not-open' {
    if (pull.state !== 'open' || pull.merged) return 'not-open';
    const mergedFiles = this.mergeTrees(repo, pull);
    if (mergedFiles === null) return 'conflict';
    const currentBaseTip = this.branchTip(repo, pull.baseRef) as string;
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const treeSha = this.buildTree(mergedFiles);
    let commitSha: string;
    if (method === 'merge') {
      const ident = this.identityLine();
      commitSha = this.store.put('commit', formatCommit({
        tree: treeSha,
        parents: [currentBaseTip, headTip],
        author: ident,
        committer: ident,
        message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
      }));
    } else {
      commitSha = this.makeCommit(treeSha, currentBaseTip, `${pull.title} (#${pull.number})\n`);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
    repo.refsVersion += 1;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commitSha;
    pull.mergedAt = this.nowIso();
    pull.updatedAt = pull.mergedAt;
    return { sha: commitSha };
  }

  // -------------------------------------------------------------- issues & pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const at = this.nowIso();
    const issue: Issue = {
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: number,
      createdAt: at,
      updatedAt: at,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    this.commentSeq += 1;
    const comment: IssueComment = { id: this.commentSeq, body, createdAt: this.nowIso() };
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | 'no-branch' | 'no-diff' | 'exists' {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return 'no-branch';
    if (headSha === baseSha) return 'no-diff';
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return 'exists';
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const at = this.nowIso();
    const pull: Pull = {
      number,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedAt: null,
      seq: number,
      createdAt: at,
      updatedAt: at,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Files changed by a pull: diff of the merge-base tree against the current head tree. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[] {
    const baseTree = this.treeOfCommit(pull.baseSha);
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const headTree = this.treeOfCommit(headTip);
    if (baseTree === null || headTree === null) return [];
    const baseFiles = this.flattenTree(baseTree);
    const headFiles = this.flattenTree(headTree);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base?.sha === head?.sha) continue;
      const baseLines = base === undefined ? [] : this.blobLines(base.sha);
      const headLines = head === undefined ? [] : this.blobLines(head.sha);
      const { additions, deletions } = lineDiff(baseLines, headLines);
      out.push({
        filename: path,
        status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        sha: head?.sha ?? base?.sha ?? '',
      });
    }
    return out;
  }

  blobText(sha: string): string {
    const obj = this.store.get(sha);
    return obj === undefined ? '' : obj.data.toString('utf8');
  }

  blobLines(sha: string): string[] {
    const text = this.blobText(sha);
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
}

/**
 * The parent ids of a commit object, read by scanning its header lines in place — the same
 * result as parseCommit(data).parents (the header is every line before the blank line, or the
 * whole payload when there is none; a parent line is `parent ` + id at a line start), without
 * decoding and splitting the whole header on the receive-pack hot path.
 */
function commitParents(data: Buffer): string[] {
  const parents: string[] = [];
  let headerEnd = data.indexOf('\n\n');
  if (headerEnd === -1) headerEnd = data.length;
  let pos = 0;
  while (pos < headerEnd) {
    let lineEnd = data.indexOf(0x0a, pos);
    if (lineEnd === -1 || lineEnd > headerEnd) lineEnd = headerEnd;
    if (lineEnd - pos > 7 && data.toString('latin1', pos, pos + 7) === 'parent ') {
      parents.push(data.toString('latin1', pos + 7, lineEnd).trim());
    }
    pos = lineEnd + 1;
  }
  return parents;
}

/** Count added/removed lines between two line arrays via a simple LCS dynamic program. */
export function lineDiff(a: readonly string[], b: readonly string[]): { additions: number; deletions: number } {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Too large for the DP table: fall back to a whole-file comparison.
    return { additions: m, deletions: n };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? (dp[(i + 1) * (m + 1) + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: m - common, deletions: n - common };
}

/**
 * Format epoch seconds as an ISO-8601 UTC string at seconds precision, arithmetically (civil
 * date from the day count, after Howard Hinnant's algorithm). Byte-identical to
 * `new Date(sec * 1000).toISOString()` with the millisecond part stripped, for any second the
 * logical clock can reach; it just avoids a Date allocation and a regex per timestamp.
 */
function isoFromEpochSec(totalSec: number): string {
  const days = Math.floor(totalSec / 86400);
  let rem = totalSec - days * 86400;
  const hh = Math.floor(rem / 3600);
  rem -= hh * 3600;
  const mm = Math.floor(rem / 60);
  const ss = rem - mm * 60;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const dd = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp < 10 ? mp + 3 : mp - 9;
  const yr = mo <= 2 ? y + 1 : y;
  const p2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${String(yr).padStart(4, '0')}-${p2(mo)}-${p2(dd)}T${p2(hh)}:${p2(mm)}:${p2(ss)}Z`;
}

export function objectTypeOf(forge: Forge, sha: string): GitObjectType | undefined {
  return forge.store.get(sha)?.type;
}

export { objectId };
