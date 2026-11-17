// Git smart HTTP (/<owner>/<repo>.git): v2 and v0 upload-pack advertisements,
// v2 ls-refs, v2/v0 fetch with real negotiation and shallow/deepen support, and
// v0 receive-pack pushes with report-status. Malformed input answers 400 and never
// takes the server down.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DELIM_PKT,
  FLUSH_PKT,
  ZERO_OID,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktData,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import { sendError, sendRaw } from './http-util.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './store.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS =
  'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done agent=forge/1.0.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0.0';

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref the repo advertises, HEAD first, then heads, then tags. */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (mainTip) out.push({ oid: mainTip, name: 'HEAD', symrefTarget: `refs/heads/${DEFAULT_BRANCH}` });
  else out.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: `refs/heads/${DEFAULT_BRANCH}` });
  const heads: string[] = [];
  const tags: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) heads.push(ref);
    else if (ref.startsWith('refs/tags/')) tags.push(ref);
  }
  heads.sort();
  tags.sort();
  for (const ref of heads) {
    out.push({ oid: repo.refs.get(ref)!, name: ref });
  }
  for (const ref of tags) {
    const oid = repo.refs.get(ref)!;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject && targetObject.type === 'commit') peeled = target;
    }
    out.push({ oid, name: ref, peeled });
  }
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD' || !ref.unborn);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const lines: string[] = [];
  if (realRefs.length === 0) {
    // An empty repo advertises its capabilities on a capabilities^{} line.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = refs.find((ref) => ref.name === 'HEAD')!;
    const others = refs.filter((ref) => ref.name !== 'HEAD');
    const first = head.unborn
      ? `${ZERO_OID} HEAD\0${caps}\n`
      : `${head.oid} HEAD\0${caps}\n`;
    lines.push(first);
    for (const ref of others) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** GET /<owner>/<repo>.git/info/refs?service=... */
export function handleInfoRefs(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string,
): boolean {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    sendRaw(res, 200, v2Advertisement(), contentType);
    return true;
  }
  sendRaw(res, 200, v0Advertisement(repo, service), contentType);
  return true;
}

// -------------------------------------------------------------------------------- upload-pack

/** Split a body into pkt-line packets up to the first flush; returns the packets and the offset just past it. */
function splitToFlush(buf: Buffer): { packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }>; rest: number } {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: offset + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  throw new Error('pkt-line stream has no flush');
}

function pktText(packet: { payload: Buffer }): string {
  return packet.payload.toString('utf8').replace(/\n$/, '');
}

/** Wrap pack bytes in sideband band-1 pkt-lines (chunks of at most 32768 bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktData(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

interface FetchPlan {
  /** Object oids to send, in pack order. */
  send: string[];
  /** Commits the client must now treat as shallow boundaries. */
  shallow: string[];
  /** Old shallow boundaries that are now fully present. */
  unshallow: string[];
  /** Have oids that are ancestors of a want (for ACK lines). */
  common: string[];
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldShallow: readonly string[],
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(oldShallow);
  // The objects the client already holds: everything reachable from its haves,
  // except the ancestors of its shallow boundaries — a shallow boundary commit is
  // held, but its parents are not, and a deepen must deliver them.
  const haveReachable = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (haveReachable.has(oid)) continue;
      haveReachable.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        queue.push(parseCommit(object.data).tree);
        if (!shallowSet.has(oid)) {
          for (const parent of parseCommit(object.data).parents) queue.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
  }
  const sendObjects = new Set<string>();
  const sentCommits: string[] = [];
  const shallow: string[] = [];

  // Resolve each want to a commit root (tags peel to their target commit).
  const roots: string[] = [];
  for (const want of wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      sendObjects.add(want);
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (targetObject && targetObject.type === 'commit') roots.push(target);
    } else if (object.type === 'commit') {
      roots.push(want);
    } else {
      sendObjects.add(want);
    }
  }

  // BFS over commits from the roots, tracking depth (root = depth 1). Commits the
  // client already holds are not sent, but traversal continues through them: a deepen
  // past a shallow boundary needs exactly those parents.
  const seenCommit = new Set<string>();
  const visited = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = roots.map((oid) => ({ oid, depth: 1 }));
  for (const root of roots) {
    seenCommit.add(root);
    visited.add(root);
  }
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    if (depth !== null && d > depth) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    if (!haveReachable.has(oid)) {
      sentCommits.push(oid);
      if (depth !== null && d === depth) shallow.push(oid);
    }
    if (depth !== null && d === depth) continue;
    const view = parseCommit(object.data);
    for (const parent of view.parents) {
      if (!seenCommit.has(parent)) {
        seenCommit.add(parent);
        visited.add(parent);
        queue.push({ oid: parent, depth: d + 1 });
      }
    }
  }

  // The closure of every sent commit: the commit itself plus its tree and blobs.
  // Parents are NOT followed here: a shallow fetch must not pull the history.
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || haveReachable.has(oid)) continue;
      seen.add(oid);
      sendObjects.add(oid);
      const object = lookup(oid);
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  for (const commitOid of sentCommits) {
    if (!haveReachable.has(commitOid)) sendObjects.add(commitOid);
    const object = lookup(commitOid);
    if (object && object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
  }

  // Old shallow boundaries whose parents are now sent become unshallow.
  const unshallow: string[] = [];
  for (const boundary of oldShallow) {
    if (!visited.has(boundary)) continue;
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => sentCommits.includes(parent))) unshallow.push(boundary);
  }

  const common: string[] = [];
  for (const have of haves) {
    if (common.includes(have)) continue;
    for (const want of roots) {
      if (isAncestor(have, want, lookup)) {
        common.push(have);
        break;
      }
    }
  }

  // Pack order: commits first (parents before children is not required), then the rest.
  const send: string[] = [];
  const sentSet = new Set(sentCommits);
  for (const oid of sendObjects) {
    if (sentSet.has(oid)) send.push(oid);
  }
  for (const oid of sendObjects) {
    if (!sentSet.has(oid)) send.push(oid);
  }
  return { send, shallow, unshallow, common };
}

function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitToFlush(body);
  const lines = packets.filter((p) => p.kind === 'data').map(pktText);
  if (lines.length === 0 || lines[0] !== 'command=fetch') throw new Error('expected command=fetch');
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  if (wants.length === 0) {
    // No wants: an empty answer (acknowledgments with NAK, then flush).
    return Buffer.concat([
      pktLine('acknowledgments\n'),
      pktLine('NAK\n'),
      DELIM_PKT,
      FLUSH_PKT,
    ]);
  }
  const plan = planFetch(repo, wants, haves, depth, shallowBoundaries);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.common.length > 0) {
    for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(DELIM_PKT);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM_PKT);
  }
  if (plan.send.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.send) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    const pack = writePack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleLsRefsV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitToFlush(body);
  const lines = packets.filter((p) => p.kind === 'data').map(pktText);
  if (lines.length === 0 || lines[0] !== 'command=ls-refs') throw new Error('expected command=ls-refs');
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      if (!unborn) continue;
      const tokens = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      out.push(`unborn ${ref.name}${tokens}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  const parts = out.map((line) => pktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  // Two sections: wants (with shallow/deepen) to flush, then haves + done to flush.
  const first = splitToFlush(body);
  const firstLines = first.packets.filter((p) => p.kind === 'data').map(pktText);
  const second = splitToFlush(body.subarray(first.rest));
  const secondLines = second.packets.filter((p) => p.kind === 'data').map(pktText);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of firstLines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const space = rest.indexOf(' ');
      wants.push(space < 0 ? rest.trim() : rest.slice(0, space).trim());
    } else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  for (const line of secondLines) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const parts: Buffer[] = [];
  if (wants.length === 0) {
    parts.push(pktLine('NAK\n'), FLUSH_PKT);
    return Buffer.concat(parts);
  }
  const plan = planFetch(repo, wants, haves, depth, shallowBoundaries);
  if (plan.common.length > 0) {
    for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.send.length > 0) {
    const objects: GitObject[] = [];
    for (const oid of plan.send) {
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    parts.push(sidebandPack(writePack(objects)));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** POST /<owner>/<repo>.git/git-upload-pack */
export function handleUploadPack(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): boolean {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if ((req.headers['git-protocol'] ?? '') === 'version=2') {
      const first = splitToFlush(body);
      const firstLine = first.packets.find((p) => p.kind === 'data');
      const command = firstLine ? pktText(firstLine) : '';
      if (command === 'command=ls-refs') {
        sendRaw(res, 200, handleLsRefsV2(repo, body), contentType);
      } else if (command === 'command=fetch') {
        sendRaw(res, 200, handleFetchV2(repo, body), contentType);
      } else {
        sendError(res, 400, `unknown v2 command ${JSON.stringify(command)}`);
      }
      return true;
    }
    sendRaw(res, 200, handleFetchV0(repo, body), contentType);
    return true;
  } catch (err) {
    sendError(res, 400, (err as Error).message);
    return true;
  }
}

// -------------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /<owner>/<repo>.git/git-receive-pack */
export function handleReceivePack(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): boolean {
  void req;
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[] = [];
  let sideband = false;
  let packOffset = 0;
  try {
    const { packets, rest } = splitToFlush(body);
    packOffset = rest;
    const lines = packets.filter((p) => p.kind === 'data').map(pktText);
    if (lines.length === 0) throw new Error('push has no commands');
    commands = lines.map((line, index) => {
      let text = line;
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          const caps = text.slice(nul + 1);
          sideband = caps.split(' ').includes('side-band-64k');
          text = text.slice(0, nul);
        }
      }
      const parts = text.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
        throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      }
      return { oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! };
    });
  } catch (err) {
    sendError(res, 400, (err as Error).message);
    return true;
  }

  // Unpack the pack first: objects are stored even for refs that end up refused.
  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
      if (!read.checksumOk) {
        unpackOk = false;
        unpackDetail = 'pack checksum mismatch';
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.replace(/[\r\n]+/g, ' ').slice(0, 200);
    }
  } else if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'missing pack';
  }

  // Validate and apply each ref update, in command order.
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const command of commands) {
    let ok = false;
    let reason = '';
    if (!command.ref.startsWith('refs/')) {
      reason = 'invalid ref';
    } else if (!unpackOk) {
      reason = 'unpack failed';
    } else if (command.newOid === ZERO_OID) {
      // Delete: the ref must exist at exactly oldOid.
      const current = repo.refs.get(command.ref);
      if (current === undefined) reason = 'ref does not exist';
      else if (current !== command.oldOid) reason = 'non-fast-forward';
      else ok = true;
    } else if (command.oldOid === ZERO_OID) {
      // Create: the ref must not exist, and the new object must be known.
      if (repo.refs.has(command.ref)) reason = 'already exists';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else ok = true;
    } else {
      // Update: old must equal the current tip and the new tip must descend from it.
      const current = repo.refs.get(command.ref);
      if (current === undefined) reason = 'ref does not exist';
      else if (current !== command.oldOid) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      else if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
        reason = 'non-fast-forward';
      } else ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    }
  }

  const reportStream = Buffer.concat(reportLines.map((line) => pktLine(line)));
  let response: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      parts.push(pktData(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH_PKT);
    response = Buffer.concat(parts);
  } else {
    response = Buffer.concat([reportStream, FLUSH_PKT]);
  }
  sendRaw(res, 200, response, contentType);
  return true;
}
