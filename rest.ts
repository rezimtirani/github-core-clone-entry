// REST v3 surface (/api/v3): repos, branches, refs, commits, contents, labels,
// issues, comments and pull requests. Every reply carries application/json and a
// non-empty X-GitHub-Request-Id (added by app.ts); errors are {message: string}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git.ts';
import { sendError, sendJson, sendJsonText, segments } from './http-util.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestContext {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  /** The origin for absolute pagination links, e.g. http://127.0.0.1:1234. */
  origin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    avatar_url: '',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    language: null,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(issue: Issue): string {
  if (issue.jsonText !== null) return issue.jsonText;
  const text = JSON.stringify({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    assignee: null,
    milestone: null,
    locked: false,
    html_url: '',
    url: '',
  });
  issue.jsonText = text;
  return text;
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = { name: repo.name, full_name: `${repo.owner}/${repo.name}` };
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, repo: headRepo },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, repo: headRepo },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !forge.pullConflict(repo, pull) : false,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
    url: '',
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
    url: '',
  };
}

interface Page {
  page: number;
  perPage: number;
}

function pageParams(url: URL): Page {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Slice `items` to one page and build the Link header for the next page, if any. */
function paginate<T>(items: readonly T[], page: Page, url: URL, path: string): { pageItems: T[]; link: string | null } {
  const start = (page.page - 1) * page.perPage;
  const pageItems = items.slice(start, start + page.perPage);
  let link: string | null = null;
  if (start + page.perPage < items.length) {
    const next = new URL(path, 'http://entry');
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('page', String(page.page + 1));
    next.searchParams.set('per_page', String(page.perPage));
    const absolute = `${url.protocol}//${url.host}${next.pathname}${next.search}`;
    link = `<${absolute}>; rel="next"`;
  }
  return { pageItems, link };
}

function repoOr404(ctx: RestContext, owner: string, name: string): Repo | null {
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) {
    sendError(ctx.res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function issueNumber(segment: string | undefined): number | null {
  if (segment === undefined) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Route one /api/v3 request. Returns true when handled. */
export function handleRest(ctx: RestContext): boolean {
  const { req, res, url, forge } = ctx;
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const seg = segments(path);
  // seg[0] is 'api', seg[1] is 'v3'.
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);

  // GET /api/v3/user — the token owner.
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, viewerJson());
    return true;
  }

  // POST /api/v3/user/repos — create a repository for the viewer.
  if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const name = str(body.name);
    if (name === '') {
      sendError(res, 422, 'name is required');
      return true;
    }
    const created = forge.createRepo(name, body.private === true, str(body.description));
    if (created === 'exists') {
      sendError(res, 422, 'Repository already exists');
      return true;
    }
    if (created === 'invalid') {
      sendError(res, 422, 'Invalid repository name');
      return true;
    }
    sendJson(res, 201, repoJson(created));
    return true;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const page = pageParams(url);
    const { pageItems, link } = paginate(forge.listRepos(), page, url, path);
    const headers: Record<string, string> = {};
    if (link) headers.link = link;
    sendJson(res, 200, pageItems.map(repoJson), headers);
    return true;
  }

  if (rest[0] !== 'repos' || rest.length < 3) return false;
  const owner = rest[1]!;
  const repoName = rest[2]!;
  const tail = rest.slice(3);

  // GET /repos/{o}/{r} — read, PATCH — update, DELETE — remove.
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = repoOr404(ctx, owner, repoName);
      if (!repo) return true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = repoOr404(ctx, owner, repoName);
      if (!repo) return true;
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      const repo = repoOr404(ctx, owner, repoName);
      if (!repo) return true;
      forge.deleteRepo(repoName);
      res.writeHead(204, { 'content-length': '0' });
      res.end();
      return true;
    }
    return false;
  }

  // Everything below needs the repository to exist.
  const repo = repoOr404(ctx, owner, repoName);
  if (!repo) return true;

  // GET /repos/{o}/{r}/branches — list branches.
  if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
    const list = forge.branchNames(repo).map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) },
    }));
    sendJson(res, 200, list);
    return true;
  }

  // GET /repos/{o}/{r}/branches/{branch} — one branch.
  if (method === 'GET' && tail.length === 2 && tail[0] === 'branches') {
    const sha = forge.branchTip(repo, decodeURIComponent(tail[1]!));
    if (!sha) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { name: decodeURIComponent(tail[1]!), commit: { sha } });
    return true;
  }

  // POST /repos/{o}/{r}/git/refs — create a ref.
  if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !sha) {
      sendError(res, 422, 'Invalid ref');
      return true;
    }
    const object = repo.objects.get(sha);
    if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
      sendError(res, 422, 'Object does not exist');
      return true;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Reference already exists');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha } });
    return true;
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch} — one ref.
  if (method === 'GET' && tail.length >= 3 && tail[0] === 'git' && tail[1] === 'refs') {
    const ref = tail.slice(2).map(decodeURIComponent).join('/');
    const sha = repo.refs.get(ref);
    if (!sha) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { ref, object: { sha } });
    return true;
  }

  // GET /repos/{o}/{r}/commits — history of a branch (or the default branch).
  if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
    const shaParam = url.searchParams.get('sha');
    const ref = shaParam ?? repo.defaultBranch;
    const tip = forge.resolveCommit(repo, ref);
    if (!tip) {
      if (shaParam !== null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, []);
      return true;
    }
    const list = forge.commitsFromTip(repo, tip, 100);
    const out = list.map((entry) => {
      const object = repo.objects.get(entry.sha)!;
      const view = parseCommit(object.data);
      const authorLine = view.author;
      const name = authorLine.slice(0, authorLine.lastIndexOf(' <'));
      const email = authorLine.slice(authorLine.lastIndexOf(' <') + 2, authorLine.lastIndexOf('>'));
      return {
        sha: entry.sha,
        commit: {
          message: view.message,
          author: { name, email, date: '' },
          committer: { name, email, date: '' },
        },
        author: { login: VIEWER_LOGIN },
      };
    });
    sendJson(res, 200, out);
    return true;
  }

  // Contents: PUT/GET/DELETE /repos/{o}/{r}/contents/{path...}
  if (tail.length >= 2 && tail[0] === 'contents') {
    const contentPath = tail.slice(1).map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const message = str(body.message, 'Update file');
      const branch = str(body.branch, repo.defaultBranch);
      const contentB64 = str(body.content);
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        sendError(res, 400, 'content is not valid base64');
        return true;
      }
      const result = forge.contentsPut(
        repo,
        branch,
        contentPath,
        content,
        message,
        typeof body.sha === 'string' ? body.sha : undefined,
      );
      if (result.status === 409) {
        sendError(res, 409, 'sha does not match the current file');
        return true;
      }
      sendJson(res, result.status, {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: result.blobSha,
          size: content.length,
          encoding: 'base64',
          type: 'file',
        },
        commit: { sha: result.commitSha },
      });
      return true;
    }
    if (method === 'GET') {
      const refParam = url.searchParams.get('ref');
      const commitOid = refParam ? forge.resolveCommit(repo, refParam) : forge.branchTip(repo, repo.defaultBranch);
      if (!commitOid) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const found = forge.readContentsAt(repo, commitOid, contentPath);
      if (!found) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (found.kind === 'file') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: found.data.toString('base64'),
          sha: found.sha,
          size: found.data.length,
          name: contentPath.split('/').pop(),
          path: contentPath,
        });
        return true;
      }
      sendJson(res, 200, found.entries);
      return true;
    }
    if (method === 'DELETE') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const message = str(body.message, 'Delete file');
      const branch = str(body.branch, repo.defaultBranch);
      const result = forge.contentsDelete(
        repo,
        branch,
        contentPath,
        message,
        typeof body.sha === 'string' ? body.sha : undefined,
      );
      if (result.status === 404) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (result.status === 409) {
        sendError(res, 409, 'sha does not match the current file');
        return true;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha } });
      return true;
    }
    return false;
  }

  // POST /repos/{o}/{r}/labels — create a label. GET — list labels.
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = str(body.name);
      if (name === '') {
        sendError(res, 422, 'name is required');
        return true;
      }
      const color = str(body.color, 'ffffff');
      const existing = repo.labels.get(name);
      if (existing) {
        sendJson(res, 201, { name: existing.name, color: existing.color, description: '' });
        return true;
      }
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color, description: '' });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
      return true;
    }
    return false;
  }

  // POST /repos/{o}/{r}/issues — create an issue. GET — list issues.
  if (tail.length === 1 && tail[0] === 'issues') {
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = str(body.title);
      if (title === '') {
        sendError(res, 422, 'title is required');
        return true;
      }
      const labelNames = Array.isArray(body.labels)
        ? body.labels.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const created = forge.createIssue(repo, title, str(body.body), labelNames);
      if ('error' in created) {
        sendError(res, 422, `Label "${created.label}" does not exist`);
        return true;
      }
      sendJsonText(res, 201, issueJson(created));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') === 'asc' ? 'asc' : 'desc';
      const page = pageParams(url);
      const listed = forge.listIssues(repo, state, direction);
      const { pageItems, link } = paginate(listed, page, url, path);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      // Serialize each issue from its cache where possible.
      const bodyText = `[${pageItems.map((issue) => issueJson(issue)).join(',')}]`;
      sendJsonText(res, 200, bodyText, headers);
      return true;
    }
    return false;
  }

  // GET/PATCH /repos/{o}/{r}/issues/{n} and its comments.
  if (tail.length >= 2 && tail[0] === 'issues') {
    const number = issueNumber(tail[1]);
    if (number === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const issue = repo.issues.get(number);
    if (!issue) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail.length === 2) {
      if (method === 'GET') {
        sendJsonText(res, 200, issueJson(issue));
        return true;
      }
      if (method === 'PATCH') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        forge.patchIssue(repo, issue, {
          state: typeof body.state === 'string' ? body.state : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          body: typeof body.body === 'string' ? body.body : undefined,
        });
        sendJsonText(res, 200, issueJson(issue));
        return true;
      }
      return false;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const commentBody = str(body.body);
        if (commentBody === '') {
          sendError(res, 422, 'body is required');
          return true;
        }
        const comment = forge.addComment(repo, issue, commentBody);
        sendJson(res, 201, commentJson(comment));
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return true;
      }
      return false;
    }
    return false;
  }

  // POST /repos/{o}/{r}/pulls — create a pull request. GET — list pull requests.
  if (tail.length === 1 && tail[0] === 'pulls') {
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base, repo.defaultBranch);
      if (title === '' || head === '') {
        sendError(res, 422, 'title and head are required');
        return true;
      }
      const created = forge.createPull(repo, title, str(body.body), head, base);
      if ('error' in created) {
        sendError(res, 422, created.error);
        return true;
      }
      sendJson(res, 201, pullJson(forge, repo, created));
      return true;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const page = pageParams(url);
      const listed = forge.listPulls(repo, state);
      const { pageItems, link } = paginate(listed, page, url, path);
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, 200, pageItems.map((pull) => pullJson(forge, repo, pull)), headers);
      return true;
    }
    return false;
  }

  // GET /repos/{o}/{r}/pulls/{n}, /files, and PUT /merge.
  if (tail.length >= 2 && tail[0] === 'pulls') {
    const number = issueNumber(tail[1]);
    if (number === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const pull = repo.pulls.get(number);
    if (!pull) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (tail.length === 2 && method === 'GET') {
      sendJson(res, 200, pullJson(forge, repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      sendJson(res, 200, forge.pullFiles(repo, pull));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const merged = forge.mergePull(repo, pull);
      if (!merged.ok) {
        sendError(res, merged.status, merged.message);
        return true;
      }
      sendJson(res, 200, { merged: true, sha: merged.sha, message: pull.title });
      return true;
    }
    return false;
  }

  return false;
}
