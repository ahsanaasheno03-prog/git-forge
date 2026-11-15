// A compact GraphQL parser + executor covering the GitHub v4 surface the forge serves: the queries
// and mutations gh and github-mcp-server send, connections with cursor pagination, node IDs and the
// __type introspection the suite reads. Errors follow GraphQL form: HTTP 200 with an errors array.

import { Forge, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------- node ids

export function nodeId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from(`g1:${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseNodeId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^g1:([A-Za-z]+):(.*)$/.exec(text);
    if (match === null) return null;
    return { kind: match[1] as string, parts: (match[2] as string).split(':') };
  } catch {
    return null;
  }
}

function repoNodeId(repo: Repo): string {
  return nodeId('Repository', [repo.id]);
}
function issueNodeId(repo: Repo, issue: Issue): string {
  return nodeId('Issue', [repo.id, issue.number]);
}
function pullNodeId(repo: Repo, pull: Pull): string {
  return nodeId('PullRequest', [repo.id, pull.number]);
}
function commentNodeId(repo: Repo, issue: Issue, commentId: number): string {
  return nodeId('IssueComment', [repo.id, issue.number, commentId]);
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: input.slice(i + 3, end === -1 ? input.length : end) });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let text = '';
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) {
        text += input[j];
        j += 1;
      }
      if (/[.eE]/.test(text)) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selection: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}
interface Fragment {
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}'`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      if (nextToken.kind === 'punct' && nextToken.value === '{') {
        return { kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() };
      }
      return { kind: 'fragmentSpread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives are parsed and ignored (none of the suite's documents rely on one).
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
    const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: Value[] = [];
          while (!this.atPunct(']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: Value }[] = [];
          while (!this.atPunct('}')) {
            const fieldName = this.expectName();
            this.expectPunct(':');
            fields.push({ name: fieldName, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected '${token.value}' in value`);
      default:
        throw new Error('unexpected token in value');
    }
  }
}

function valueOf(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return vars[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((item) => valueOf(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(field.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

interface GqlError {
  message: string;
}

type Source =
  | { __type: 'User'; login: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: Pull }
  | { __type: 'Ref'; repo: Repo; name: string }
  | { __type: 'IssueConnection'; repo: Repo; items: Issue[]; total: number; startIndex: number }
  | { __type: 'PullRequestConnection'; repo: Repo; items: Pull[] }
  | { __type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'FileConnection'; files: { path: string; additions: number; deletions: number; changeType: string }[] }
  | { __type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string }
  | { __type: 'CommentEdge'; node: Source }
  | { __type: 'Payload'; fields: Record<string, Source | null> }
  | { __type: '__Type'; name: string }
  | { __type: 'Root' };

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closed', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'repository',
  ],
  Ref: ['name', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- execution

interface ExecCtx {
  readonly forge: Forge;
  readonly vars: Record<string, unknown>;
  readonly fragments: Map<string, Fragment>;
  readonly errors: GqlError[];
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function repoByNodeId(forge: Forge, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseNodeId(id);
  if (parsed === null) return null;
  const dbId = Number(parsed.parts[0]);
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __type: 'User', login: VIEWER.login }),
    repository: (_s, args, ctx) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = ctx.forge.getRepo(owner, name);
      return repo === undefined ? null : { __type: 'Repository', repo };
    },
    node: (_s, args, ctx) => {
      const parsed = typeof args.id === 'string' ? parseNodeId(args.id) : null;
      if (parsed === null) return null;
      const repo = repoByNodeId(ctx.forge, args.id);
      if (repo === null) return null;
      if (parsed.kind === 'Repository') return { __type: 'Repository', repo };
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(Number(parsed.parts[1]));
        return issue === undefined ? null : { __type: 'Issue', repo, issue };
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.get(Number(parsed.parts[1]));
        return pull === undefined ? null : { __type: 'PullRequest', repo, pull };
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      return TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined ? { __type: '__Type', name } : null;
    },
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(ctx.forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return tagPayload({ __type: 'Payload', fields: { issue: { __type: 'Issue', repo, issue } } }, 'CreateIssuePayload');
    },
    closeIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(ctx.forge, input.issueId);
      const parsed = typeof input.issueId === 'string' ? parseNodeId(input.issueId) : null;
      if (repo === null || parsed === null) throw new Error('issue not found');
      const issue = repo.issues.get(Number(parsed.parts[1]));
      if (issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedAt = ctx.forge.nowIso();
      return tagPayload({ __type: 'Payload', fields: { issue: { __type: 'Issue', repo, issue } } }, 'CloseIssuePayload');
    },
    createPullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(ctx.forge, input.repositoryId);
      if (repo === null) throw new Error('repository not found');
      const pull = ctx.forge.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (typeof pull !== 'object') throw new Error(`cannot create pull request: ${pull}`);
      return tagPayload({ __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo, pull } } }, 'CreatePullRequestPayload');
    },
    mergePullRequest: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(ctx.forge, input.pullRequestId);
      const parsed = typeof input.pullRequestId === 'string' ? parseNodeId(input.pullRequestId) : null;
      if (repo === null || parsed === null) throw new Error('pull request not found');
      const pull = repo.pulls.get(Number(parsed.parts[1]));
      if (pull === undefined) throw new Error('pull request not found');
      const methodText = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const method = methodText === 'SQUASH' ? 'squash' : methodText === 'MERGE' ? 'merge' : 'squash';
      const result = ctx.forge.mergePull(repo, pull, method);
      if (result === 'conflict') throw new Error('pull request is not mergeable');
      if (result === 'not-open') throw new Error('pull request is not open');
      return tagPayload({ __type: 'Payload', fields: { pullRequest: { __type: 'PullRequest', repo, pull } } }, 'MergePullRequestPayload');
    },
    addComment: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByNodeId(ctx.forge, input.subjectId);
      const parsed = typeof input.subjectId === 'string' ? parseNodeId(input.subjectId) : null;
      if (repo === null || parsed === null || parsed.kind !== 'Issue') throw new Error('subject not found');
      const issue = repo.issues.get(Number(parsed.parts[1]));
      if (issue === undefined) throw new Error('subject not found');
      const comment = ctx.forge.addComment(repo, issue, String(input.body ?? ''));
      const node: Source = { __type: 'IssueComment', repo, issue, commentId: comment.id, body: comment.body };
      return tagPayload({ __type: 'Payload', fields: { commentEdge: { __type: 'CommentEdge', node } } }, 'AddCommentPayload');
    },
  },
  User: {
    login: (s) => (s as { login: string }).login,
    id: () => nodeId('User', [VIEWER.id]),
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (s) => repoNodeId((s as { repo: Repo }).repo),
    databaseId: (s) => (s as { repo: Repo }).repo.id,
    name: (s) => (s as { repo: Repo }).repo.name,
    nameWithOwner: (s) => {
      const repo = (s as { repo: Repo }).repo;
      return `${repo.owner}/${repo.name}`;
    },
    description: (s) => (s as { repo: Repo }).repo.description,
    isPrivate: (s) => (s as { repo: Repo }).repo.private,
    owner: (s) => ({ __type: 'User', login: (s as { repo: Repo }).repo.owner }),
    defaultBranchRef: (s, _a, ctx) => {
      const repo = (s as { repo: Repo }).repo;
      if (ctx.forge.branchTip(repo, repo.defaultBranch) === undefined) return null;
      return { __type: 'Ref', repo, name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (s) => (s as { repo: Repo }).repo.createdAt,
    updatedAt: (s) => (s as { repo: Repo }).repo.createdAt,
    issue: (s, args) => {
      const repo = (s as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : { __type: 'Issue', repo, issue };
    },
    issues: (s, args) => {
      const repo = (s as { repo: Repo }).repo;
      let items = [...repo.issues.values()];
      const states = args.states as unknown[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const descending = String(orderBy.direction ?? 'ASC') === 'DESC';
      items.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
      const total = items.length;
      const start = indexOfCursor(args.after);
      const first = typeof args.first === 'number' ? args.first : 10;
      const page = items.slice(start, start + first);
      return { __type: 'IssueConnection', repo, items: page, total, startIndex: start };
    },
    pullRequest: (s, args) => {
      const repo = (s as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : { __type: 'PullRequest', repo, pull };
    },
    pullRequests: (s, args) => {
      const repo = (s as { repo: Repo }).repo;
      const first = typeof args.first === 'number' ? args.first : 10;
      const items = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first);
      return { __type: 'PullRequestConnection', repo, items };
    },
  },
  Issue: {
    id: (s) => issueNodeId((s as { repo: Repo }).repo, (s as { issue: Issue }).issue),
    number: (s) => (s as { issue: Issue }).issue.number,
    title: (s) => (s as { issue: Issue }).issue.title,
    state: (s) => ((s as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (s) => (s as { issue: Issue }).issue.body,
    author: () => ({ __type: 'User', login: VIEWER.login }),
    createdAt: (s) => (s as { issue: Issue }).issue.createdAt,
    updatedAt: (s) => (s as { issue: Issue }).issue.updatedAt,
    closed: (s) => (s as { issue: Issue }).issue.state === 'closed',
    repository: (s) => ({ __type: 'Repository', repo: (s as { repo: Repo }).repo }),
  },
  PullRequest: {
    id: (s) => pullNodeId((s as { repo: Repo }).repo, (s as { pull: Pull }).pull),
    number: (s) => (s as { pull: Pull }).pull.number,
    title: (s) => (s as { pull: Pull }).pull.title,
    body: (s) => (s as { pull: Pull }).pull.body,
    state: (s) => {
      const pull = (s as { pull: Pull }).pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (s) => (s as { pull: Pull }).pull.merged,
    mergeable: (s, _a, ctx) => {
      const { repo, pull } = s as { repo: Repo; pull: Pull };
      if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.mergeTrees(repo, pull) === null ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (s) => (s as { pull: Pull }).pull.headRef,
    baseRefName: (s) => (s as { pull: Pull }).pull.baseRef,
    headRef: (s) => ({ __type: 'Ref', repo: (s as { repo: Repo }).repo, name: (s as { pull: Pull }).pull.headRef }),
    baseRef: (s) => ({ __type: 'Ref', repo: (s as { repo: Repo }).repo, name: (s as { pull: Pull }).pull.baseRef }),
    files: (s, args, ctx) => {
      const { repo, pull } = s as { repo: Repo; pull: Pull };
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = ctx.forge.pullFiles(repo, pull).slice(0, first).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return { __type: 'FileConnection', files };
    },
    createdAt: (s) => (s as { pull: Pull }).pull.createdAt,
    updatedAt: (s) => (s as { pull: Pull }).pull.updatedAt,
    repository: (s) => ({ __type: 'Repository', repo: (s as { repo: Repo }).repo }),
  },
  Ref: {
    name: (s) => (s as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (s) => {
      const conn = s as { repo: Repo; items: Issue[] };
      return conn.items.map((issue) => ({ __type: 'Issue', repo: conn.repo, issue }));
    },
    pageInfo: (s) => {
      const conn = s as { items: Issue[]; total: number; startIndex: number };
      const end = conn.startIndex + conn.items.length;
      return { __type: 'PageInfo', hasNextPage: end < conn.total, endCursor: conn.items.length > 0 ? cursorOf(end) : null };
    },
    totalCount: (s) => (s as { total: number }).total,
    edges: (s) => {
      const conn = s as { repo: Repo; items: Issue[]; startIndex: number };
      return conn.items.map((issue, i) => ({
        __type: 'Payload',
        fields: { node: { __type: 'Issue', repo: conn.repo, issue }, cursor: null },
      }));
    },
  },
  PullRequestConnection: {
    nodes: (s) => {
      const conn = s as { repo: Repo; items: Pull[] };
      return conn.items.map((pull) => ({ __type: 'PullRequest', repo: conn.repo, pull }));
    },
    pageInfo: (s) => ({ __type: 'PageInfo', hasNextPage: false, endCursor: null }),
    totalCount: (s) => (s as { items: Pull[] }).items.length,
    edges: (s) => {
      const conn = s as { repo: Repo; items: Pull[] };
      return conn.items.map((pull) => ({
        __type: 'Payload',
        fields: { node: { __type: 'PullRequest', repo: conn.repo, pull }, cursor: null },
      }));
    },
  },
  FileConnection: {
    nodes: (s) => {
      const conn = s as { files: { path: string; additions: number; deletions: number; changeType: string }[] };
      return conn.files.map((file) => ({ __type: 'PullRequestChangedFile', ...file }));
    },
    pageInfo: () => ({ __type: 'PageInfo', hasNextPage: false, endCursor: null }),
    totalCount: (s) => (s as { files: unknown[] }).files.length,
  },
  PullRequestChangedFile: {
    path: (s) => (s as { path: string }).path,
    additions: (s) => (s as { additions: number }).additions,
    deletions: (s) => (s as { deletions: number }).deletions,
    changeType: (s) => (s as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (s) => (s as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: () => false,
    startCursor: () => null,
    endCursor: (s) => (s as { endCursor: string | null }).endCursor,
  },
  IssueComment: {
    id: (s) => {
      const src = s as { repo: Repo; issue: Issue; commentId: number };
      return commentNodeId(src.repo, src.issue, src.commentId);
    },
    body: (s) => (s as { body: string }).body,
    author: () => ({ __type: 'User', login: VIEWER.login }),
    createdAt: (s, _a, ctx) => ctx.forge.nowIso(),
  },
  CommentEdge: {
    node: (s) => (s as { node: Source }).node,
    cursor: () => cursorOf(0),
  },
  Payload: {
    issue: (s) => (s as { fields: Record<string, Source | null> }).fields.issue ?? null,
    pullRequest: (s) => (s as { fields: Record<string, Source | null> }).fields.pullRequest ?? null,
    commentEdge: (s) => (s as { fields: Record<string, Source | null> }).fields.commentEdge ?? null,
    node: (s) => (s as { fields: Record<string, Source | null> }).fields.node ?? null,
    cursor: () => cursorOf(0),
  },
  __Type: {
    name: (s) => (s as { name: string }).name,
    kind: (s) => (ENUM_VALUES[(s as { name: string }).name] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (s) => {
      const name = (s as { name: string }).name;
      return (TYPE_FIELDS[name] ?? []).map((field) => ({ __type: '__Field', name: field }));
    },
    enumValues: (s) => {
      const name = (s as { name: string }).name;
      return (ENUM_VALUES[name] ?? []).map((value) => ({ __type: '__EnumValue', name: value }));
    },
  },
  __Field: { name: (s) => (s as unknown as { name: string }).name },
  __EnumValue: { name: (s) => (s as unknown as { name: string }).name },
};

// Payload sources carry their fields in `fields`; give them dynamic resolvers per payload type.
for (const payloadType of ['CreateIssuePayload', 'CloseIssuePayload', 'CreatePullRequestPayload', 'MergePullRequestPayload', 'AddCommentPayload']) {
  RESOLVERS[payloadType] = {
    issue: (s) => (s as { fields: Record<string, Source | null> }).fields.issue ?? null,
    pullRequest: (s) => (s as { fields: Record<string, Source | null> }).fields.pullRequest ?? null,
    commentEdge: (s) => (s as { fields: Record<string, Source | null> }).fields.commentEdge ?? null,
  };
}

function typeNameOf(source: Source, rootType: string): string {
  return source.__type === 'Root' ? rootType : source.__type === 'Payload' ? 'Payload' : source.__type;
}

function executeSelectionSet(
  typeName: string,
  source: Source,
  selections: readonly SelectionNode[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const runFields = (fields: readonly SelectionNode[], currentType: string, currentSource: Source) => {
    for (const selection of fields) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === currentType) {
          runFields(selection.selection, currentType, currentSource);
        }
        continue;
      }
      if (selection.kind === 'fragmentSpread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined && fragment.typeCondition === currentType) runFields(fragment.selection, currentType, currentSource);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = currentType;
        continue;
      }
      // Payload objects resolve through their declared payload type names.
      let effectiveType = currentType;
      if (currentSource.__type === 'Payload') {
        effectiveType = payloadTypeFor(currentSource, ctx);
      }
      const resolver = RESOLVERS[effectiveType]?.[selection.name] ?? RESOLVERS[currentType]?.[selection.name];
      if (resolver === undefined) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${effectiveType}'` });
        out[key] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.vars);
      let value: unknown;
      try {
        value = resolver(currentSource, args, ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
      out[key] = completeValue(value, selection.selection, ctx);
    }
  };
  runFields(selections, typeName, source);
  return out;
}

// Payload sources need their concrete payload type for field lookup; track it on the object.
const payloadTypes = new WeakMap<object, string>();
function payloadTypeFor(source: Source, ctx: ExecCtx): string {
  return payloadTypes.get(source as object) ?? 'Payload';
}

function completeValue(value: unknown, selection: SelectionNode[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (typeof source.__type === 'string' && selection !== null) {
      const typeName = source.__type === 'Payload' ? (payloadTypes.get(source as object) ?? 'Payload') : source.__type;
      return executeSelectionSet(typeName, source, selection, ctx);
    }
    return value;
  }
  return value;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

/** Execute one GraphQL operation body ({query, variables, operationName}). */
export function executeGraphQL(forge: Forge, body: { query?: unknown; variables?: unknown; operationName?: unknown }): GraphQLResult {
  const query = typeof body.query === 'string' ? body.query : '';
  const vars = (body.variables !== null && typeof body.variables === 'object' ? body.variables : {}) as Record<string, unknown>;
  let document: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  // Tag payload sources with their concrete payload type before execution.
  const ctx: ExecCtx = { forge, vars, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __type: 'Root' }, operation.selection, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// Register payload types at creation time (called by mutation resolvers through this helper).
export function tagPayload(source: Source, type: string): Source {
  payloadTypes.set(source as object, type);
  return source;
}
