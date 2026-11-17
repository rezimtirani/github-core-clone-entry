// The forge's in-memory state and domain logic: repositories, refs, issues, pull
// requests, labels, comments, and the contents commits the REST surface creates.
// Everything is deterministic: server-made commits use a logical clock, never wall time.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  listCommitOids,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  putObject,
  updateTree,
  type GitObject,
  type GitObjectType,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const FORGE_IDENTITY = 'ada iversen <adaiversen@example.invalid>';

/** A logical clock: server-made commits and timestamps advance by one second each. */
let logicalTs = 1700000000;
export function nextTs(): number {
  return logicalTs++;
}
export function isoTs(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  /** Cached REST serialization; cleared on any mutation of the issue. */
  jsonText: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  counter: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  put(repo: Repo, type: GitObjectType, data: Buffer): string {
    return putObject(repo.objects, type, data);
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | 'exists' | 'invalid' {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) return 'invalid';
    if (this.repos.has(name)) return 'exists';
    const ts = nextTs();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: description ?? '',
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: isoTs(ts),
      updatedAt: isoTs(ts),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      counter: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // ---------------------------------------------------------------- refs

  /** Resolve a branch name, full ref, or commit sha to a commit oid, or null. */
  resolveCommit(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) {
      const object = repo.objects.get(ref);
      if (object && object.type === 'commit') return ref;
      if (object && object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject && targetObject.type === 'commit') return target;
      }
      return null;
    }
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (!oid) return null;
      return this.resolveCommit(repo, oid);
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    if (!oid) return null;
    return this.resolveCommit(repo, oid);
  }

  /** The commit oid a branch points at, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    return object && object.type === 'commit' ? oid : null;
  }

  /** All branch names, sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** The peeled commit of a ref (tags peel to their target commit). */
  peelToCommit(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      return this.peelToCommit(repo, target);
    }
    return null;
  }

  // ---------------------------------------------------------------- issues

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labelNames: readonly string[],
  ): Issue | { error: 'bad-label'; label: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: 'bad-label', label: name };
      labels.push(label);
    }
    const ts = nextTs();
    const number = repo.counter++;
    const issue: Issue = {
      id: this.nextEntityId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdAt: isoTs(ts),
      updatedAt: isoTs(ts),
      jsonText: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  listIssues(
    repo: Repo,
    state: string,
    direction: 'asc' | 'desc',
  ): Issue[] {
    const all = [...repo.issues.values()];
    const filtered = state === 'all' ? all : all.filter((issue) => issue.state === state);
    filtered.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    return filtered;
  }

  patchIssue(repo: Repo, issue: Issue, patch: { state?: string; title?: string; body?: string }): void {
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    issue.updatedAt = isoTs(nextTs());
    issue.jsonText = null;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const ts = nextTs();
    const comment: Comment = {
      id: this.nextEntityId++,
      body,
      createdAt: isoTs(ts),
      updatedAt: isoTs(ts),
    };
    issue.comments.push(comment);
    issue.updatedAt = isoTs(ts);
    issue.jsonText = null;
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Pull | { error: string } {
    const headSha = this.branchTip(repo, head);
    if (!headSha) return { error: `head branch ${head} does not exist` };
    const baseSha = this.branchTip(repo, base);
    if (!baseSha) return { error: `base branch ${base} does not exist` };
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
        return { error: `an open pull request already exists for ${head}` };
      }
    }
    const ts = nextTs();
    const number = repo.counter++;
    const pull: Pull = {
      id: this.nextEntityId++,
      number,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: isoTs(ts),
      updatedAt: isoTs(ts),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const all = [...repo.pulls.values()];
    const filtered = state === 'all' ? all : all.filter((pull) => pull.state === state);
    filtered.sort((a, b) => b.number - a.number);
    return filtered;
  }

  /** Files changed by a pull request, vs its merge-base with the base branch. */
  pullFiles(repo: Repo, pull: Pull): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const lookup = this.lookup(repo);
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(pull.headSha, baseTip, lookup);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const diff = diffTrees(lookup, baseTree, headTree);
    const files: Array<{
      filename: string;
      status: 'added' | 'modified' | 'removed';
      additions: number;
      deletions: number;
      changes: number;
    }> = [];
    for (const entry of diff) {
      let additions = 0;
      let deletions = 0;
      if (entry.newOid) {
        const object = repo.objects.get(entry.newOid);
        if (object) additions = Math.max(1, object.data.toString('utf8').split('\n').length - (object.data.length ? 1 : 0));
        if (entry.oldOid === null) additions = Math.max(1, additions);
      }
      if (entry.oldOid) {
        const object = repo.objects.get(entry.oldOid);
        if (object) deletions = Math.max(0, object.data.toString('utf8').split('\n').length - (object.data.length ? 1 : 0));
      }
      const status = entry.oldOid === null ? 'added' : entry.newOid === null ? 'removed' : 'modified';
      files.push({ filename: entry.path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /**
   * Whether a pull request can merge cleanly: false when the head's diff (vs the merge-base)
   * and the base tip's diff (vs the merge-base) touch the same path with different results.
   */
  pullConflict(repo: Repo, pull: Pull): boolean {
    const lookup = this.lookup(repo);
    const baseTip = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(pull.headSha, baseTip, lookup);
    if (!base) return true;
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const headDiff = diffTrees(lookup, baseTree, headTree);
    const baseDiff = diffTrees(lookup, baseTree, baseTipTree);
    const baseChanged = new Map(baseDiff.map((entry) => [entry.path, entry.newOid]));
    for (const entry of headDiff) {
      if (!baseChanged.has(entry.path)) continue;
      if (baseChanged.get(entry.path) !== entry.newOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the new commit sha or an error. */
  mergePull(
    repo: Repo,
    pull: Pull,
  ): { ok: true; sha: string } | { ok: false; status: 405 | 409; message: string } {
    if (pull.state !== 'open' || pull.merged) {
      return { ok: false, status: 409, message: 'pull request is already closed' };
    }
    const lookup = this.lookup(repo);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (!baseTip) return { ok: false, status: 409, message: `base branch ${pull.baseRef} does not exist` };
    const headObject = repo.objects.get(pull.headSha);
    if (!headObject || headObject.type !== 'commit') {
      return { ok: false, status: 409, message: 'head commit is missing' };
    }
    if (this.pullConflict(repo, pull)) {
      return { ok: false, status: 405, message: 'merge conflict' };
    }
    const base = mergeBase(pull.headSha, baseTip, lookup);
    const baseTree = base ? parseCommit(repo.objects.get(base)!.data).tree : null;
    const headTree = parseCommit(headObject.data).tree;
    const baseTipTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    // Apply the head's diff (vs merge-base) onto the base tip's tree.
    const headDiff = diffTrees(lookup, baseTree, headTree);
    const flat = flattenTree(lookup, baseTipTree);
    for (const entry of headDiff) {
      if (entry.newOid === null) flat.delete(entry.path);
      else flat.set(entry.path, { oid: entry.newOid, mode: '100644' });
    }
    // Rebuild nested trees from the flat map, bottom-up.
    const newTree = this.buildTreeFromFlat(repo, flat);
    const ts = nextTs();
    const commit = buildCommit({
      tree: newTree,
      parents: [baseTip],
      message: pull.title,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: ts,
    });
    const sha = this.put(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoTs(ts);
    pull.mergeCommitSha = sha;
    pull.updatedAt = isoTs(ts);
    return { ok: true, sha };
  }

  /** Rebuild a full tree hierarchy from a flat path -> blob map. */
  buildTreeFromFlat(
    repo: Repo,
    flat: Map<string, { oid: string; mode: string }>,
  ): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        let next = node.dirs.get(part);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.put(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  // ---------------------------------------------------------------- contents

  /** Create or update a file via the contents API: a real git commit on the branch. */
  contentsPut(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { status: 200 | 201 | 409; commitSha?: string; blobSha?: string } {
    const tip = this.branchTip(repo, branch);
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0) return { status: 409 };
    const existing = tip ? this.readContentsAt(repo, tip, path) : null;
    if (expectedSha !== undefined) {
      if (!existing || existing.kind !== 'file' || existing.sha !== expectedSha) return { status: 409 };
    }
    const blobSha = this.put(repo, 'blob', content);
    const baseTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
    const newTree = updateTree(this.lookup(repo), (type, data) => this.put(repo, type, data), baseTree, parts, blobSha);
    const ts = nextTs();
    const commit = buildCommit({
      tree: newTree,
      parents: tip ? [tip] : [],
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: ts,
    });
    const commitSha = this.put(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: existing ? 200 : 201, commitSha, blobSha };
  }

  /** Delete a file via the contents API: a real git commit on the branch. */
  contentsDelete(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
    expectedSha?: string,
  ): { status: 200 | 404 | 409; commitSha?: string } {
    const tip = this.branchTip(repo, branch);
    if (!tip) return { status: 404 };
    const existing = this.readContentsAt(repo, tip, path);
    if (!existing || existing.kind !== 'file') return { status: 404 };
    if (expectedSha !== undefined && existing.sha !== expectedSha) return { status: 409 };
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    const baseTree = parseCommit(repo.objects.get(tip)!.data).tree;
    const newTree = updateTree(this.lookup(repo), (type, data) => this.put(repo, type, data), baseTree, parts, null);
    const ts = nextTs();
    const commit = buildCommit({
      tree: newTree,
      parents: [tip],
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: ts,
    });
    const commitSha = this.put(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: 200, commitSha };
  }

  /** Read a path at a commit: a file (blob) or a directory listing, or null. */
  readContentsAt(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'file'; sha: string; data: Buffer } | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> } | null {
    const commitObject = repo.objects.get(commitOid);
    if (!commitObject || commitObject.type !== 'commit') return null;
    const treeOid = parseCommit(commitObject.data).tree;
    const parts = path.split('/').filter((part) => part !== '' && part !== '.');
    let currentTree = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const treeObject = repo.objects.get(currentTree);
      if (!treeObject || treeObject.type !== 'tree') return null;
      const entry = parseTree(treeObject.data).find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const subObject = repo.objects.get(entry.oid);
          if (!subObject || subObject.type !== 'tree') return null;
          const entries = parseTree(subObject.data).map((e) => ({
            type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
            name: e.name,
            path: `${path}/${e.name}`,
            sha: e.oid,
          }));
          return { kind: 'dir', entries };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob) return null;
        return { kind: 'file', sha: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    // Path is the repo root: list the root tree.
    const rootObject = repo.objects.get(treeOid);
    if (!rootObject || rootObject.type !== 'tree') return null;
    const entries = parseTree(rootObject.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: e.name,
      sha: e.oid,
    }));
    return { kind: 'dir', entries };
  }

  /** Commit oids on a branch, newest first. */
  commitsOnBranch(repo: Repo, branch: string, limit = 100): Array<{ sha: string; message: string }> {
    const tip = this.branchTip(repo, branch);
    if (!tip) return [];
    return this.commitsFromTip(repo, tip, limit);
  }

  /** Commits reachable from a tip, newest first. */
  commitsFromTip(repo: Repo, tip: string, limit = 100): Array<{ sha: string; message: string }> {
    const oids = listCommitOids(this.lookup(repo), tip, limit);
    return oids.map((oid) => {
      const object = repo.objects.get(oid)!;
      return { sha: oid, message: parseCommit(object.data).message };
    });
  }

  /** The git object id of the empty tree (well-known). */
  static emptyTreeOid(): string {
    return hashObject('tree', Buffer.alloc(0));
  }
}
