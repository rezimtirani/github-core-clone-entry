// The server: one HTTP listener routing git smart HTTP, REST v3, GraphQL v4 and MCP.
// Auth: every surface except /healthz, the API root and /api/v3/meta requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; anything else answers 401.
// Every reply carries a non-empty X-GitHub-Request-Id. Malformed JSON answers 400.
// Unknown routes answer JSON 404. A handler that throws answers 500 and the server
// stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleMcp, handleMcpDelete } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Forge } from './store.ts';
import { parseJsonBody, readBody, sendError, sendJson } from './http-util.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** The token the suite presents; empty when unset (then nothing authenticates). */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = shopToken();
  if (token === '') return false;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('x-github-request-id', nextRequestId());
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
    } catch {
      sendError(res, 400, 'Bad request');
      return;
    }
    const path = url.pathname;
    const origin = `${url.protocol}//${url.host}`;

    // The env's boot check: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // The GitHub API root: 200 with the token's scopes (unauthenticated, like api.github.com).
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // GET /api/v3/meta: 200 with the installed version (unauthenticated).
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0-forge' });
      return;
    }

    // MCP: POST /mcp (JSON-RPC), DELETE /mcp (legacy session close).
    if (path === '/mcp') {
      if (!authorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      if (method === 'DELETE') {
        handleMcpDelete(res);
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      readBody(req)
        .then((raw) => {
          try {
            handleMcp(forge, req, res, raw);
          } catch (err) {
            sendError(res, 500, (err as Error).message);
          }
        })
        .catch(() => sendError(res, 400, 'Bad request'));
      return;
    }

    // Git smart HTTP: /<owner>/<repo>.git/info/refs and the two services.
    const gitMatch = path.includes('.git/') ? /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path) : null;
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3] ?? '';
      if (!authorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      if (method === 'GET' && suffix === '/info/refs') {
        try {
          handleInfoRefs(forge, req, res, owner, repoName, url.searchParams.get('service') ?? '');
        } catch (err) {
          sendError(res, 500, (err as Error).message);
        }
        return;
      }
      if (method === 'POST' && suffix === '/git-upload-pack') {
        readBody(req)
          .then((raw) => {
            try {
              handleUploadPack(forge, req, res, owner, repoName, raw);
            } catch (err) {
              sendError(res, 400, (err as Error).message);
            }
          })
          .catch(() => sendError(res, 400, 'Bad request'));
        return;
      }
      if (method === 'POST' && suffix === '/git-receive-pack') {
        readBody(req)
          .then((raw) => {
            try {
              handleReceivePack(forge, req, res, owner, repoName, raw);
            } catch (err) {
              sendError(res, 400, (err as Error).message);
            }
          })
          .catch(() => sendError(res, 400, 'Bad request'));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // GraphQL: POST /api/graphql.
    if (path === '/api/graphql') {
      if (!authorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      if (method !== 'POST') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      readBody(req)
        .then((raw) => {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          try {
            handleGraphQL(forge, req, res, parsed.value);
          } catch (err) {
            sendError(res, 500, (err as Error).message);
          }
        })
        .catch(() => sendError(res, 400, 'Bad request'));
      return;
    }

    // REST v3: everything under /api/v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      if (!needsBody) {
        try {
          if (!handleRest({ forge, req, res, url, body: {}, origin })) sendError(res, 404, 'Not Found');
        } catch (err) {
          sendError(res, 500, (err as Error).message);
        }
        return;
      }
      readBody(req)
        .then((raw) => {
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendError(res, 400, 'Invalid JSON body');
            return;
          }
          try {
            if (!handleRest({ forge, req, res, url, body: parsed.value, origin })) sendError(res, 404, 'Not Found');
          } catch (err) {
            sendError(res, 500, (err as Error).message);
          }
        })
        .catch(() => sendError(res, 400, 'Bad request'));
      return;
    }

    // Everything else: GitHub's 404 body.
    sendError(res, 404, 'Not Found');
  });
}

export { JSON_TYPE };
