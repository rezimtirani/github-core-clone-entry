// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, plain application/json
// replies. Modern era 2026-07-28 via `server/discover`, with the legacy `initialize`
// handshake kept for safety. Tools share the same store as the REST surface.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, sendRaw } from './http-util.ts';
import {
  VIEWER_LOGIN,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name, owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map a documented argument name onto the nearest schema property (normalized match). */
function pickArg(
  args: Record<string, unknown>,
  schema: ToolDef['inputSchema'],
  documented: string,
): unknown {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(documented);
  for (const key of Object.keys(schema.properties)) {
    if (norm(key) === wanted) return args[key];
  }
  return args[documented];
}

function repoJsonForMcp(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function issueJsonForMcp(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJsonForMcp(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
  };
}

interface ToolOutcome {
  text: string;
  isError: boolean;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { text: JSON.stringify({ error: `unknown tool ${name}` }), isError: true };
  const missing = tool.inputSchema.required.filter(
    (key) => pickArg(args, tool.inputSchema, key) === undefined || pickArg(args, tool.inputSchema, key) === null,
  );
  if (missing.length > 0) {
    return { text: JSON.stringify({ error: `missing required argument(s): ${missing.join(', ')}` }), isError: true };
  }
  const ownerOf = (argsObj: Record<string, unknown>): string => {
    const fullName = pickArg(argsObj, tool.inputSchema, 'full_name');
    if (typeof fullName === 'string' && fullName.includes('/')) return fullName.split('/')[0]!;
    return String(pickArg(argsObj, tool.inputSchema, 'owner') ?? '');
  };
  const repoOf = (argsObj: Record<string, unknown>): string => {
    const fullName = pickArg(argsObj, tool.inputSchema, 'full_name');
    if (typeof fullName === 'string' && fullName.includes('/')) return fullName.split('/')[1]!;
    return String(pickArg(argsObj, tool.inputSchema, 'repo') ?? '');
  };

  if (name === 'create_repo') {
    const repoName = String(pickArg(args, tool.inputSchema, 'name') ?? '');
    const description = String(pickArg(args, tool.inputSchema, 'description') ?? '');
    const isPrivate = pickArg(args, tool.inputSchema, 'private') === true;
    const created = forge.createRepo(repoName, isPrivate, description);
    if (created === 'exists') return { text: JSON.stringify({ error: 'Repository already exists' }), isError: true };
    if (created === 'invalid') return { text: JSON.stringify({ error: 'Invalid repository name' }), isError: true };
    return { text: JSON.stringify(repoJsonForMcp(created)), isError: false };
  }

  const owner = ownerOf(args);
  const repoName = repoOf(args);
  const repo = forge.getRepo(owner, repoName);
  if (!repo) return { text: JSON.stringify({ error: 'Not Found' }), isError: true };

  if (name === 'get_repo') {
    return { text: JSON.stringify(repoJsonForMcp(repo)), isError: false };
  }
  if (name === 'create_issue') {
    const title = String(pickArg(args, tool.inputSchema, 'title') ?? '');
    const body = String(pickArg(args, tool.inputSchema, 'body') ?? '');
    const created = forge.createIssue(repo, title, body, []);
    if ('error' in created) return { text: JSON.stringify({ error: `Label "${created.label}" does not exist` }), isError: true };
    return { text: JSON.stringify(issueJsonForMcp(created)), isError: false };
  }
  if (name === 'list_issues') {
    const state = String(pickArg(args, tool.inputSchema, 'state') ?? 'open');
    const listed = forge.listIssues(repo, state, 'desc');
    return { text: JSON.stringify(listed.map(issueJsonForMcp)), isError: false };
  }
  if (name === 'create_pull_request') {
    const title = String(pickArg(args, tool.inputSchema, 'title') ?? '');
    const body = String(pickArg(args, tool.inputSchema, 'body') ?? '');
    const head = String(pickArg(args, tool.inputSchema, 'head') ?? '');
    const base = String(pickArg(args, tool.inputSchema, 'base') ?? 'main');
    const created = forge.createPull(repo, title, body, head, base);
    if ('error' in created) return { text: JSON.stringify({ error: created.error }), isError: true };
    return { text: JSON.stringify(pullJsonForMcp(created)), isError: false };
  }
  if (name === 'merge_pull_request') {
    const number = Number(pickArg(args, tool.inputSchema, 'pull_number'));
    const pull = repo.pulls.get(number);
    if (!pull) return { text: JSON.stringify({ error: 'Not Found' }), isError: true };
    const merged = forge.mergePull(repo, pull);
    if (!merged.ok) return { text: JSON.stringify({ error: merged.message }), isError: true };
    return { text: JSON.stringify({ merged: true, sha: merged.sha, number: pull.number }), isError: false };
  }
  return { text: JSON.stringify({ error: `unknown tool ${name}` }), isError: true };
}

/** POST /mcp handler. `rawBody` is the request bytes (needed for the parse-error path). */
export function handleMcp(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
): boolean {
  void req;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    // JSON-RPC parse error: HTTP 400 with code -32700.
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const request = parsed as Record<string, unknown>;
  const id = ('id' in request ? request.id : null) as string | number | null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // Notifications carry no id: answer 202 with no body.
  if (!('id' in request) || request.id === undefined) {
    sendRaw(res, 202, Buffer.alloc(0), 'application/json');
    return true;
  }

  const ok = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    ok({
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const protocolVersion =
      typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    ok({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'tools/list') {
    // Byte-identical across calls: a fixed literal list.
    ok({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (toolName === '') {
      fail(-32602, 'tools/call needs a tool name');
      return true;
    }
    const known = TOOLS.some((entry) => entry.name === toolName);
    if (!known) {
      fail(-32601, `Method not found: ${toolName}`);
      return true;
    }
    const outcome = callTool(forge, toolName, args);
    ok({
      content: [{ type: 'text', text: outcome.text }],
      isError: outcome.isError,
    });
    return true;
  }
  if (method === 'ping') {
    ok({});
    return true;
  }
  fail(-32601, `Method not found: ${method}`);
  return true;
}

/** DELETE /mcp (legacy session close): answer 200 harmlessly. */
export function handleMcpDelete(res: ServerResponse): void {
  sendJson(res, 200, {});
}

export function mcpAuthRequired(res: ServerResponse): void {
  sendError(res, 401, 'Unauthorized');
}

export { VIEWER_LOGIN };
