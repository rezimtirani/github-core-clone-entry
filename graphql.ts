// GraphQL (/api/graphql): a small parser for the query language subset the suite
// sends, plus an executor over the same store the REST surface uses. Unknown fields
// answer HTTP 200 with an `errors` array naming the field; unknown repositories
// answer data.repository = null with no errors; unauthenticated answers 401 (app.ts).

import { sendError, sendJson } from './http-util.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------- lexer

interface Token {
  type: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(c)) {
      tokens.push({ type: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------- parser

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, unknown>; selections: SelectionNode[] | null }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }
  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().type !== 'eof') {
      if (this.peek().type === 'punct' && this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unsupported GraphQL definition ${keyword}`);
      let name: string | null = null;
      if (this.peek().type === 'name') name = this.next().value;
      const variables: Record<string, unknown> = {};
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().type === 'punct' && this.peek().value === ')')) {
          this.expectPunct('$');
          const varName = this.expectName();
          this.expectPunct(':');
          this.skipType();
          if (this.peek().type === 'punct' && this.peek().value === '=') {
            this.next();
            variables[varName] = this.parseValue();
          } else {
            variables[varName] = undefined;
          }
        }
        this.expectPunct(')');
      }
      operations.push({ kind: keyword, name, variables, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  /** Skip a type expression: Name, [T], T!, possibly nested. */
  private skipType(): void {
    const token = this.next();
    if (token.type === 'punct' && token.value === '[') {
      this.skipType();
      this.expectPunct(']');
    } else if (token.type !== 'name') {
      throw new Error(`bad GraphQL type, got ${JSON.stringify(token.value)}`);
    }
    if (this.peek().type === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().type === 'punct' && this.peek().value === '}')) {
      if (this.peek().type === 'punct' && this.peek().value === '...') {
        this.next();
        if (this.peek().type === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek().type === 'name') {
          selections.push({ kind: 'spread', name: this.next().value });
          this.skipDirectives();
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek().type === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, unknown> = {};
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        this.next();
        while (!(this.peek().type === 'punct' && this.peek().value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      const sub = this.peek().type === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selections: sub });
    }
    this.expectPunct('}');
    return selections;
  }

  /** Skip @directive(args) sequences, if any. */
  private skipDirectives(): void {
    while (this.peek().type === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.type === 'punct' && token.value === '(') depth += 1;
          if (token.type === 'punct' && token.value === ')') depth -= 1;
          if (token.type === 'eof') break;
        }
      }
    }
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.type === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!(this.peek().type === 'punct' && this.peek().value === ']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.type === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek().type === 'punct' && this.peek().value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return Number(token.value);
    if (token.type === 'float') return Number(token.value);
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// -------------------------------------------------------------------------------- values

type GqlValue =
  | { __typename: string; [key: string]: unknown }
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | undefined;

export function globalId(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoValue(repo: Repo): GqlValue {
  return { __typename: 'Repository', repo };
}
function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __typename: 'Issue', repo, issue };
}
function pullValue(repo: Repo, pull: Pull): GqlValue {
  return { __typename: 'PullRequest', repo, pull };
}

// -------------------------------------------------------------------------------- schema

interface TypeField {
  name: string;
  typeName: string;
  typeKind: 'SCALAR' | 'OBJECT' | 'ENUM';
}

const TYPE_FIELDS: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: TypeField[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR' },
      { name: 'number', typeName: 'Int', typeKind: 'SCALAR' },
      { name: 'title', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'state', typeName: 'IssueState', typeKind: 'ENUM' },
      { name: 'body', typeName: 'String', typeKind: 'SCALAR' },
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR' },
      { name: 'number', typeName: 'Int', typeKind: 'SCALAR' },
      { name: 'title', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'body', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'headRefName', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'baseRefName', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'mergeable', typeName: 'MergeableState', typeKind: 'ENUM' },
      { name: 'state', typeName: 'PullRequestState', typeKind: 'ENUM' },
      { name: 'merged', typeName: 'Boolean', typeKind: 'SCALAR' },
      { name: 'files', typeName: 'PullRequestFileConnection', typeKind: 'OBJECT' },
    ],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', typeName: 'ID', typeKind: 'SCALAR' },
      { name: 'databaseId', typeName: 'Int', typeKind: 'SCALAR' },
      { name: 'name', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'nameWithOwner', typeName: 'String', typeKind: 'SCALAR' },
      { name: 'owner', typeName: 'User', typeKind: 'OBJECT' },
      { name: 'defaultBranchRef', typeName: 'Ref', typeKind: 'OBJECT' },
      { name: 'viewerPermission', typeName: 'RepositoryPermission', typeKind: 'ENUM' },
      { name: 'hasIssuesEnabled', typeName: 'Boolean', typeKind: 'SCALAR' },
      { name: 'issue', typeName: 'Issue', typeKind: 'OBJECT' },
      { name: 'issues', typeName: 'IssueConnection', typeKind: 'OBJECT' },
      { name: 'pullRequests', typeName: 'PullRequestConnection', typeKind: 'OBJECT' },
      { name: 'pullRequest', typeName: 'PullRequest', typeKind: 'OBJECT' },
    ],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'ORGANIZATION', 'MILESTONE'],
  },
};

// -------------------------------------------------------------------------------- executor

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
}

function resolveArgValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__var' in (value as Record<string, unknown>)) {
      const name = (value as { __var: string }).__var;
      return variables[name] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((entry) => resolveArgValue(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveArgValue(entry, variables);
    }
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveArgValue(value, variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(n) ? n : -1;
  } catch {
    return -1;
  }
}

interface Connection {
  items: GqlValue[];
  total: number;
}

function makeConnection(items: GqlValue[], first: number | undefined, after: string | null | undefined): GqlValue {
  const afterIndex = cursorIndex(after);
  const start = afterIndex + 1;
  const sliced = typeof first === 'number' ? items.slice(start, start + first) : items.slice(start);
  const endCursor = sliced.length > 0 ? cursorFor(start + sliced.length - 1) : null;
  const hasNextPage = start + sliced.length < items.length;
  return {
    __typename: 'Connection',
    nodes: sliced,
    edges: sliced.map((node, i) => ({ __typename: 'Edge', node, cursor: cursorFor(start + i) })),
    totalCount: items.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function typeFieldValue(field: TypeField): GqlValue {
  return {
    __typename: '__Field',
    name: field.name,
    type: { __typename: '__Type', name: field.typeName, kind: field.typeKind },
  };
}

function typeValue(name: string): GqlValue {
  const info = TYPE_FIELDS[name];
  if (!info) return null;
  return {
    __typename: '__Type',
    name,
    kind: info.kind,
    fields: info.fields.map(typeFieldValue),
    enumValues: info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value })),
  };
}

function resolveField(
  ctx: ExecContext,
  typeName: string,
  fieldName: string,
  value: { __typename: string; [key: string]: unknown },
  args: Record<string, unknown>,
): GqlValue {
  const forge = ctx.forge;
  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return { __typename: 'User' };
      if (fieldName === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoValue(repo) : null;
      }
      if (fieldName === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(decoded.key));
          return repo ? repoValue(repo) : null;
        }
        if (decoded.kind === 'Issue') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(repoId));
          const issue = repo?.issues.get(Number(number));
          return repo && issue ? issueValue(repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(repoId));
          const pull = repo?.pulls.get(Number(number));
          return repo && pull ? pullValue(repo, pull) : null;
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = String(args.name ?? '');
        return typeValue(name);
      }
      break;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded?.kind === 'Repository'
          ? [...forge.repos.values()].find((entry) => entry.id === Number(decoded.key))
          : undefined;
        if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
        const created = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) return { __typename: 'CreateIssuePayload', issue: null };
        return { __typename: 'CreateIssuePayload', issue: issueValue(repo, created) };
      }
      if (fieldName === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        let closed: { repo: Repo; issue: Issue } | null = null;
        if (decoded?.kind === 'Issue') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(repoId));
          const issue = repo?.issues.get(Number(number));
          if (repo && issue) {
            forge.patchIssue(repo, issue, { state: 'closed' });
            closed = { repo, issue };
          }
        }
        return { __typename: 'CloseIssuePayload', issue: closed ? issueValue(closed.repo, closed.issue) : null };
      }
      if (fieldName === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded?.kind === 'Repository'
          ? [...forge.repos.values()].find((entry) => entry.id === Number(decoded.key))
          : undefined;
        if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        const created = forge.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, created) };
      }
      if (fieldName === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        let merged: { repo: Repo; pull: Pull } | null = null;
        if (decoded?.kind === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(repoId));
          const pull = repo?.pulls.get(Number(number));
          if (repo && pull) {
            forge.mergePull(repo, pull);
            merged = { repo, pull };
          }
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: merged ? pullValue(merged.repo, merged.pull) : null };
      }
      if (fieldName === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        let edge: GqlValue = null;
        if (decoded?.kind === 'Issue') {
          const [repoId, number] = decoded.key.split(':');
          const repo = [...forge.repos.values()].find((entry) => entry.id === Number(repoId));
          const issue = repo?.issues.get(Number(number));
          if (repo && issue) {
            const comment = forge.addComment(repo, issue, String(input.body ?? ''));
            edge = {
              __typename: 'CommentEdge',
              node: { __typename: 'IssueComment', id: globalId('Comment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body },
              cursor: cursorFor(issue.comments.length - 1),
            };
          }
        }
        return { __typename: 'AddCommentPayload', commentEdge: edge };
      }
      break;
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      if (fieldName === 'id') return globalId('Repository', repo.id);
      if (fieldName === 'databaseId') return repo.id;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (fieldName === 'owner') return { __typename: 'User' };
      if (fieldName === 'defaultBranchRef') {
        return forge.branchTip(repo, repo.defaultBranch)
          ? { __typename: 'Ref', name: repo.defaultBranch }
          : null;
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueValue(repo, issue) : null;
      }
      if (fieldName === 'issues') {
        let list = [...repo.issues.values()];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC');
        list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        const nodes = list.map((issue) => issueValue(repo, issue));
        return makeConnection(
          nodes,
          typeof args.first === 'number' ? args.first : undefined,
          typeof args.after === 'string' ? args.after : null,
        );
      }
      if (fieldName === 'pullRequests') {
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const nodes = list.map((pull) => pullValue(repo, pull));
        return makeConnection(
          nodes,
          typeof args.first === 'number' ? args.first : undefined,
          typeof args.after === 'string' ? args.after : null,
        );
      }
      if (fieldName === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullValue(repo, pull) : null;
      }
      break;
    }
    case 'Issue': {
      const repo = value.repo as Repo;
      const issue = value.issue as Issue;
      if (fieldName === 'id') return globalId('Issue', `${repo.id}:${issue.number}`);
      if (fieldName === 'number') return issue.number;
      if (fieldName === 'title') return issue.title;
      if (fieldName === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'body') return issue.body;
      break;
    }
    case 'PullRequest': {
      const repo = value.repo as Repo;
      const pull = value.pull as Pull;
      if (fieldName === 'id') return globalId('PullRequest', `${repo.id}:${pull.number}`);
      if (fieldName === 'number') return pull.number;
      if (fieldName === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'merged') return pull.merged;
      if (fieldName === 'headRefName') return pull.headRef;
      if (fieldName === 'baseRefName') return pull.baseRef;
      if (fieldName === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return forge.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (fieldName === 'files') {
        const files = forge.pullFiles(repo, pull);
        const nodes: GqlValue[] = files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename }));
        return makeConnection(
          nodes,
          typeof args.first === 'number' ? args.first : undefined,
          typeof args.after === 'string' ? args.after : null,
        );
      }
      break;
    }
    case 'User': {
      if (fieldName === 'login') return VIEWER_LOGIN;
      if (fieldName === 'id') return globalId('User', VIEWER_ID);
      if (fieldName === 'databaseId') return VIEWER_ID;
      if (fieldName === 'name') return VIEWER_NAME;
      break;
    }
    case 'Ref': {
      if (fieldName === 'name') return String(value.name ?? '');
      break;
    }
    case 'Connection': {
      if (fieldName === 'nodes') return value.nodes as GqlValue[];
      if (fieldName === 'edges') return value.edges as GqlValue[];
      if (fieldName === 'totalCount') return value.totalCount as number;
      if (fieldName === 'pageInfo') return value.pageInfo as GqlValue;
      break;
    }
    case 'Edge': {
      if (fieldName === 'node') return value.node as GqlValue;
      if (fieldName === 'cursor') return String(value.cursor ?? '');
      break;
    }
    case 'PageInfo': {
      if (fieldName === 'hasNextPage') return Boolean(value.hasNextPage);
      if (fieldName === 'endCursor') return (value.endCursor as string | null) ?? null;
      if (fieldName === 'hasPreviousPage') return false;
      if (fieldName === 'startCursor') return null;
      break;
    }
    case '__Type': {
      if (fieldName === 'name') return String(value.name ?? '');
      if (fieldName === 'kind') return String(value.kind ?? '');
      if (fieldName === 'fields') return value.fields as GqlValue[];
      if (fieldName === 'enumValues') return value.enumValues as GqlValue[];
      if (fieldName === 'description') return null;
      break;
    }
    case '__Field': {
      if (fieldName === 'name') return String(value.name ?? '');
      if (fieldName === 'type') return value.type as GqlValue;
      if (fieldName === 'description') return null;
      break;
    }
    case '__EnumValue': {
      if (fieldName === 'name') return String(value.name ?? '');
      if (fieldName === 'description') return null;
      break;
    }
    case 'PullRequestFile': {
      if (fieldName === 'path') return String(value.path ?? '');
      break;
    }
    case 'IssueComment': {
      if (fieldName === 'id') return String(value.id ?? '');
      if (fieldName === 'body') return String(value.body ?? '');
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return (value.issue as GqlValue) ?? null;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return (value.pullRequest as GqlValue) ?? null;
      break;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return (value.commentEdge as GqlValue) ?? null;
      break;
    }
    case 'CommentEdge': {
      if (fieldName === 'node') return value.node as GqlValue;
      if (fieldName === 'cursor') return String(value.cursor ?? '');
      break;
    }
    default:
      break;
  }
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function executeSelectionSet(
  ctx: ExecContext,
  selections: SelectionNode[],
  value: { __typename: string; [key: string]: unknown },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) continue;
      Object.assign(out, executeSelectionSet(ctx, fragment.selections, value));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== value.__typename) continue;
      Object.assign(out, executeSelectionSet(ctx, selection.selections, value));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = value.__typename;
      continue;
    }
    const args = resolveArgs(selection.args, ctx.variables);
    const resolved = resolveField(ctx, value.__typename, selection.name, value, args);
    if (selection.selections === null) {
      out[key] = resolved;
      continue;
    }
    if (resolved === null || resolved === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? executeSelectionSet(ctx, selection.selections!, entry as { __typename: string; [key: string]: unknown })
          : entry,
      );
      continue;
    }
    if (typeof resolved === 'object' && '__typename' in (resolved as Record<string, unknown>)) {
      out[key] = executeSelectionSet(ctx, selection.selections, resolved as { __typename: string; [key: string]: unknown });
      continue;
    }
    out[key] = resolved;
  }
  return out;
}

function executeOperation(
  forge: Forge,
  document: Document,
  operation: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: ExecContext = { forge, variables, errors: [], fragments: document.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, operation.selections, { __typename: rootType });
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function executeGraphQL(
  forge: Forge,
  body: unknown,
): { status: number; payload: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'request must be a JSON object with a query field' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string') {
      return { errors: [{ message: 'query must be a string' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let document: Document;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: `syntax error: ${(err as Error).message}` }] };
    }
    let operation: Operation | undefined;
    if (operationName !== null) {
      operation = document.operations.find((op) => op.name === operationName);
      if (!operation) return { errors: [{ message: `unknown operation ${operationName}` }] };
    } else if (document.operations.length === 1) {
      operation = document.operations[0];
    } else if (document.operations.length === 0) {
      return { errors: [{ message: 'document has no operation' }] };
    } else {
      return { errors: [{ message: 'operationName is required when the document has several operations' }] };
    }
    return executeOperation(forge, document, operation, variables);
  };
  if (Array.isArray(body)) {
    return { status: 200, payload: body.map(runOne) };
  }
  return { status: 200, payload: runOne(body) };
}

/** POST /api/graphql handler (auth is checked by app.ts). */
export function handleGraphQL(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): boolean {
  void req;
  if (body === null || (typeof body !== 'object' && !Array.isArray(body))) {
    sendError(res, 400, 'request body must be a JSON object or array');
    return true;
  }
  const result = executeGraphQL(forge, body);
  sendJson(res, result.status, result.payload);
  return true;
}
