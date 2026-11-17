// github-core-clone-01: a standalone GitHub-compatible git forge in one Node process.
//
// Surfaces, all served from one in-memory store, no git binary, no dependencies:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack protocol v2, receive-pack v0)
//   - REST v3 under /api/v3 (repositories, issues, pull requests, contents)
//   - GraphQL v4 at /api/graphql
//   - MCP (Streamable HTTP JSON-RPC) at /mcp
// Lifecycle (bind port 0, register, poll /done) lives in main.ts.
//
// Auth: every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; the token names
// the viewer `adaiversen` (the scenario's fixed viewer login from the published wire contract:
// the token itself is an opaque `shpat_…` value derived per trial, so the login it names is
// the one the suite's seeded scenario assigns to the viewer). A request without the token is
// 401; a repository under any other owner is 404, never 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'github-core-clone/1.0.0';

type Json = Record<string, unknown>;
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: sha1("<type> <len>\0<data>"). */
function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** An opaque Relay-style global id: base64("<Kind>:<key>"), never the plain database id. */
function globalId(kind: string, key: string): string {
  return b64encode(`${kind}:${key}`);
}

function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

/** A monotonic logical clock (seconds): deterministic, never the wall clock. */
let logicalNow = 1_700_000_000;
function tickClock(): number {
  logicalNow += 1;
  return logicalNow;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

// ---------------------------------------------------------------------------
// pkt-line framing (git smart HTTP)
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

function pktLinesText(packets: readonly Pkt[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// zlib: inflate one stream out of a buffer, finding where it ends.
// inflateSync ignores trailing bytes and throws on truncation, so the consumed
// length is the smallest prefix that inflates successfully (binary search).
// ---------------------------------------------------------------------------

function inflateAt(buf: Buffer, start: number): { data: Buffer; next: number } {
  const rest = buf.subarray(start);
  let lo = 1;
  let hi = rest.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(rest.subarray(0, mid));
      found = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found < 0) throw new Error('zlib stream does not terminate');
  return { data: inflateSync(rest.subarray(0, found)), next: start + found };
}

// ---------------------------------------------------------------------------
// git objects: parse and build
// ---------------------------------------------------------------------------

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const out = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const who = (ident: string): string => `${ident} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who(fields.author)}`, `committer ${who(fields.committer)}`, '');
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles (no deltas emitted; deltas in received packs are resolved)
// ---------------------------------------------------------------------------

const PACK_TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type] ?? 0;
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta to its base, per the pack format. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] ?? 0;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Read a packfile into objects (oid -> object), resolving OFS/REF deltas. */
function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  interface Pending {
    offset: number;
    baseOffset?: number;
    baseOid?: string;
    delta: Buffer;
  }
  const pending: Pending[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeNum === 6) {
      let b = pack[offset] ?? 0;
      offset += 1;
      let baseOff = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] ?? 0;
        offset += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryStart, baseOffset: entryStart - baseOff, delta: inflated.data });
    } else if (typeNum === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryStart, baseOid, delta: inflated.data });
    } else {
      const type = PACK_CODE_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const obj: GitObject = { type, data: inflated.data };
      const oid = hashObject(type, inflated.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    }
  }
  for (const item of pending) {
    let base: GitObject | undefined;
    if (item.baseOffset !== undefined) base = byOffset.get(item.baseOffset);
    else if (item.baseOid !== undefined) base = objects.get(item.baseOid) ?? lookup(item.baseOid);
    if (base === undefined) throw new Error('delta base not found');
    const data = applyDelta(base.data, item.delta);
    const obj: GitObject = { type: base.type, data };
    const oid = hashObject(base.type, data);
    objects.set(oid, obj);
    byOffset.set(item.offset, obj);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// store: repositories, issues, pull requests (all in memory)
// ---------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  createdAt: number;
  updatedAt: number;
}

interface Comment {
  id: number;
  body: string;
  createdAt: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdAt: number;
}

class Repo {
  readonly id: number;
  readonly owner = VIEWER_LOGIN;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = DEFAULT_BRANCH;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels = new Map<string, Label>();
  readonly comments = new Map<number, Comment[]>();
  nextNumber = 1;
  createdAt: number;
  seq: number;

  constructor(id: number, name: string, description: string, isPrivate: boolean, seq: number) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.seq = seq;
    this.createdAt = tickClock();
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** All objects reachable from `roots`: commits, their trees/blobs, tags and targets. */
  reachableObjects(roots: Iterable<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack = [...roots];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        if (view.tree !== '') stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** The commit oids reachable from `roots` (parents only). */
  reachableCommits(roots: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /** True when `ancestor` is an ancestor of (or equal to) `oid`. */
  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    return this.reachableCommits([oid]).has(ancestor);
  }

  /** A merge base of two commits: the first common ancestor found walking both histories. */
  mergeBase(a: string, b: string): string | null {
    const aAncestors = this.reachableCommits([a]);
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return null;
  }

  /** A flat path -> {oid, mode} map for the tree at `treeOid`. */
  readTreeFlat(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree object from a flat path map; returns the tree oid. */
  writeTreeFlat(files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on top of `parents` with the given flat file map; returns its oid. */
  commitFiles(parents: readonly string[], files: ReadonlyMap<string, { oid: string; mode: string }>, message: string): string {
    const tree = this.writeTreeFlat(files);
    const ts = tickClock();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({ tree, parents, message, author: ident, committer: ident, timestamp: ts });
    return this.putObject('commit', data);
  }

  /** The flat file map of the commit at `commitOid` (empty when there is none). */
  filesAt(commitOid: string | undefined): Map<string, { oid: string; mode: string }> {
    if (commitOid === undefined) return new Map();
    const obj = this.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return this.readTreeFlat(parseCommit(obj.data).tree);
  }

  /** Commits reachable from `ref`, newest first (parents after children). */
  commitsFrom(ref: string | undefined): { sha: string; commit: CommitView }[] {
    if (ref === undefined) return [];
    const out: { sha: string; commit: CommitView }[] = [];
    const seen = new Set<string>();
    const stack = [ref];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      out.push({ sha: oid, commit: view });
      for (const parent of view.parents) stack.push(parent);
    }
    return out;
  }
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextGlobalId = 1;
let repoSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function listViewerRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// shapes: the JSON the REST surface returns
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Json {
  const ts = isoOf(repo.createdAt);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    created_at: ts,
    updated_at: ts,
    pushed_at: ts,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): Json {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.fullName}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedAt) : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  const headSha = pull.headSha;
  const baseSha = pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.fullName}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: computeMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER_LOGIN}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}`, repo: repoJson(repo) },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.createdAt),
    closed_at: pull.state === 'closed' ? pull.mergedAt ?? isoOf(pull.createdAt) : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** MERGEABLE / CONFLICTING for a pull request, from a three-way file comparison. */
function computeMergeable(repo: Repo, pull: Pull): boolean {
  return !pullHasConflict(repo, pull);
}

function pullHasConflict(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const base = repo.mergeBase(pull.baseSha, pull.headSha);
  if (base === null) return false;
  const baseFiles = repo.filesAt(base);
  const headFiles = repo.filesAt(pull.headSha);
  const baseTipFiles = repo.filesAt(pull.baseSha);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseTipFiles.keys()]);
  for (const path of paths) {
    const fromBase = baseFiles.get(path)?.oid ?? null;
    const head = headFiles.get(path)?.oid ?? null;
    const tip = baseTipFiles.get(path)?.oid ?? null;
    const headChanged = head !== fromBase;
    const tipChanged = tip !== fromBase;
    if (headChanged && tipChanged && head !== tip) return true;
  }
  return false;
}

/** A squash merge of an open pull request; returns the merge commit sha or null on conflict. */
function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open') return null;
  if (pullHasConflict(repo, pull)) return null;
  const headFiles = repo.filesAt(pull.headSha);
  const message = `${pull.title} (#${pull.number})`;
  const mergeSha = repo.commitFiles([pull.baseSha], headFiles, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(tickClock());
  pull.mergeCommitSha = mergeSha;
  pull.baseSha = mergeSha;
  return mergeSha;
}

/** Line counts for a pull request's files: base tree vs head tree. */
function pullFiles(repo: Repo, pull: Pull): Json[] {
  const baseFiles = repo.filesAt(pull.baseSha === '' ? undefined : pull.baseSha);
  const headFiles = repo.filesAt(pull.headSha);
  const out: Json[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const countLines = (oid: string | null): string[] => {
    if (oid === null) return [];
    const obj = repo.getObject(oid);
    if (obj === undefined) return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  for (const path of [...paths].sort()) {
    const from = baseFiles.get(path)?.oid ?? null;
    const to = headFiles.get(path)?.oid ?? null;
    if (from === to) continue;
    let status = 'modified';
    if (from === null) status = 'added';
    else if (to === null) status = 'removed';
    const oldLines = countLines(from);
    const newLines = countLines(to);
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    let deletions = 0;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    if (status === 'added' && additions === 0) additions = newLines.length;
    if (status === 'removed' && deletions === 0) deletions = oldLines.length;
    out.push({
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  // A 401 carries a challenge so git clients (Basic) and API clients (Bearer) retry with credentials.
  const extra = status === 401 ? { 'www-authenticate': 'Basic realm="github-core-clone", Bearer' } : {};
  sendJson(res, status, { message }, extra);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
}

function route(method: string, template: string): Route {
  const keys: string[] = [];
  const parts = template.split('/').map((part) => {
    if (part.startsWith(':')) {
      keys.push(part.slice(1));
      return '([^/]+)';
    }
    if (part === '*') {
      keys.push('rest');
      return '(.*)';
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { method, pattern: new RegExp(`^${parts.join('/')}$`), keys };
}

function matchRoute(route: Route, method: string, path: string): Record<string, string> | null {
  if (route.method !== method) return null;
  const m = route.pattern.exec(path);
  if (m === null) return null;
  const out: Record<string, string> = {};
  route.keys.forEach((key, i) => {
    out[key] = decodeURIComponent(m[i + 1] ?? '');
  });
  return out;
}

function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function isAuthorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${TOKEN}`) return true;
  // Real git clients send Basic auth from the URL userinfo (oauth2:<token>).
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const [user, ...rest] = decoded.split(':');
      const password = rest.join(':');
      if (password === TOKEN || user === TOKEN) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}`;
}

/** Parse a JSON body; on malformed JSON answers 400 and returns null. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Json | null {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, 'Invalid JSON body: expected an object');
      return null;
    }
    return parsed as Json;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
}

/** A paginated list reply with a Link rel="next" header when more pages exist. */
function sendList(res: ServerResponse, req: IncomingMessage, query: URLSearchParams, path: string, items: unknown[]): void {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    headers.link = `<${absoluteUrl(req, `${path}?${next.toString()}`)}>; rel="next"`;
  }
  sendJson(res, 200, slice, headers);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

const REST_ROUTES: Route[] = [
  route('GET', '/api/v3'),
  route('GET', '/api/v3/'),
  route('GET', '/api/v3/meta'),
  route('GET', '/api/v3/user'),
  route('GET', '/api/v3/user/repos'),
  route('POST', '/api/v3/user/repos'),
  route('GET', '/api/v3/repos/:owner/:repo'),
  route('PATCH', '/api/v3/repos/:owner/:repo'),
  route('DELETE', '/api/v3/repos/:owner/:repo'),
  route('GET', '/api/v3/repos/:owner/:repo/branches'),
  route('GET', '/api/v3/repos/:owner/:repo/branches/:branch'),
  route('GET', '/api/v3/repos/:owner/:repo/commits'),
  route('POST', '/api/v3/repos/:owner/:repo/git/refs'),
  route('GET', '/api/v3/repos/:owner/:repo/git/refs/heads/:branch'),
  route('GET', '/api/v3/repos/:owner/:repo/contents/*'),
  route('PUT', '/api/v3/repos/:owner/:repo/contents/*'),
  route('DELETE', '/api/v3/repos/:owner/:repo/contents/*'),
  route('POST', '/api/v3/repos/:owner/:repo/labels'),
  route('GET', '/api/v3/repos/:owner/:repo/labels'),
  route('POST', '/api/v3/repos/:owner/:repo/issues'),
  route('GET', '/api/v3/repos/:owner/:repo/issues'),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number'),
  route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number'),
  route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments'),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments'),
  route('POST', '/api/v3/repos/:owner/:repo/pulls'),
  route('GET', '/api/v3/repos/:owner/:repo/pulls'),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number'),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files'),
  route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge'),
];

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string, raw: Buffer): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  // Auth first: every /api/v3 call needs the bearer token.
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const query = parseQuery(req);
  for (const r of REST_ROUTES) {
    const params = matchRoute(r, method, path);
    if (params === null) continue;
    return handleRestRoute(req, res, r, params, query, raw);
  }
  sendError(res, 404, 'Not Found');
  return true;
}

async function handleRestRoute(req: IncomingMessage, res: ServerResponse, r: Route, params: Record<string, string>, query: URLSearchParams, raw: Buffer): Promise<boolean> {
  const method = r.method;
  const path = pathOf(req);
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: '1.0.0', git_hash: 'github-core-clone' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL });
    return true;
  }

  // POST /user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
      sendError(res, 422, 'Invalid repository name');
      return true;
    }
    if (repos.has(repoKey(VIEWER_LOGIN, name))) {
      sendError(res, 422, 'Repository already exists');
      return true;
    }
    repoSeq += 1;
    const repo = new Repo(nextRepoId, name, typeof body.description === 'string' ? body.description : '', body.private === true, repoSeq);
    nextRepoId += 1;
    repos.set(repoKey(VIEWER_LOGIN, name), repo);
    sendJson(res, 201, repoJson(repo));
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user/repos') {
    sendList(res, req, query, path, listViewerRepos().map((repo) => repoJson(repo)));
    return true;
  }

  // Repository-scoped routes
  const owner = params.owner ?? '';
  const repoName = params.repo ?? '';
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (method === 'GET' && path === `/api/v3/repos/${owner}/${repoName}`) {
    sendJson(res, 200, repoJson(repo));
    return true;
  }
  if (method === 'PATCH' && path === `/api/v3/repos/${owner}/${repoName}`) {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    sendJson(res, 200, repoJson(repo));
    return true;
  }
  if (method === 'DELETE' && path === `/api/v3/repos/${owner}/${repoName}`) {
    repos.delete(repoKey(owner, repoName));
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return true;
  }
  if (method === 'GET' && path.endsWith('/branches') && params.branch === undefined) {
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
    sendJson(res, 200, branches);
    return true;
  }
  if (method === 'GET' && params.branch !== undefined && path.includes('/branches/')) {
    const tip = repo.branchTip(params.branch);
    if (tip === undefined) {
      sendError(res, 404, 'Branch not found');
      return true;
    }
    sendJson(res, 200, { name: params.branch, sha: tip, commit: { sha: tip }, protected: false });
    return true;
  }
  if (method === 'GET' && path.endsWith('/commits')) {
    const shaParam = query.get('sha');
    const tip = shaParam === null ? repo.branchTip(repo.defaultBranch) : (repo.branchTip(shaParam) ?? (isOid(shaParam) ? shaParam : undefined));
    const commits = repo.commitsFrom(tip).map(({ sha, commit }) => ({
      sha,
      commit: {
        message: commit.message,
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      },
      parents: commit.parents.map((p) => ({ sha: p })),
      author: { login: VIEWER_LOGIN },
      committer: { login: VIEWER_LOGIN },
    }));
    sendJson(res, 200, commits);
    return true;
  }
  if (method === 'POST' && path.endsWith('/git/refs')) {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha)) {
      sendError(res, 422, 'Invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, 'Reference already exists');
      return true;
    }
    if (repo.getObject(sha) === undefined) {
      sendError(res, 422, 'Object does not exist');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` });
    return true;
  }
  if (method === 'GET' && params.branch !== undefined && path.includes('/git/refs/heads/')) {
    const tip = repo.branchTip(params.branch);
    if (tip === undefined) {
      sendError(res, 404, 'Reference not found');
      return true;
    }
    sendJson(res, 200, { ref: `refs/heads/${params.branch}`, object: { sha: tip, type: 'commit' } });
    return true;
  }

  // Contents
  if (path.includes('/contents/')) {
    return handleContents(req, res, repo, owner, repoName, params.rest ?? '', query, method, raw);
  }

  // Labels
  if (method === 'POST' && path.endsWith('/labels')) {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      sendError(res, 422, 'Invalid label name');
      return true;
    }
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      sendJson(res, 201, labelJson(existing));
      return true;
    }
    const label: Label = { id: nextGlobalId, name, color: typeof body.color === 'string' ? body.color : 'ededed', description: typeof body.description === 'string' ? body.description : '' };
    nextGlobalId += 1;
    repo.labels.set(name, label);
    sendJson(res, 201, labelJson(label));
    return true;
  }
  if (method === 'GET' && path.endsWith('/labels')) {
    sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(l)));
    return true;
  }

  // Issues
  if (method === 'POST' && path.endsWith('/issues') && params.number === undefined) {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const title = typeof body.title === 'string' ? body.title : '';
    const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
    for (const name of labelNames) {
      if (!repo.labels.has(name)) {
        sendError(res, 422, `Label "${name}" does not exist`);
        return true;
      }
    }
    const ts = tickClock();
    const issue: Issue = {
      id: nextGlobalId,
      number: repo.nextNumber,
      title,
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      labels: labelNames.map((n) => repo.labels.get(n) as Label),
      seq: repo.nextNumber,
      createdAt: ts,
      updatedAt: ts,
    };
    nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    sendJson(res, 201, issueJson(repo, issue));
    return true;
  }
  if (method === 'GET' && path.endsWith('/issues') && params.number === undefined) {
    let list = [...repo.issues];
    const state = query.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    }
    sendList(res, req, query, path, list.map((i) => issueJson(repo, i)));
    return true;
  }
  if (params.number !== undefined && path.includes('/issues/')) {
    const number = Number(params.number);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET' && !path.endsWith('/comments')) {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH' && !path.endsWith('/comments')) {
      const body = parseJsonBody(res, raw);
      if (body === null) return true;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = tickClock();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'POST' && path.endsWith('/comments')) {
      const body = parseJsonBody(res, raw);
      if (body === null) return true;
      const comment: Comment = { id: nextGlobalId, body: typeof body.body === 'string' ? body.body : '', createdAt: tickClock() };
      nextGlobalId += 1;
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      sendJson(res, 201, {
        id: comment.id,
        node_id: globalId('IssueComment', `${repo.fullName}:${number}:${comment.id}`),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: isoOf(comment.createdAt),
        updated_at: isoOf(comment.createdAt),
      });
      return true;
    }
    if (method === 'GET' && path.endsWith('/comments')) {
      const list = repo.comments.get(number) ?? [];
      sendJson(res, 200, list.map((c) => ({
        id: c.id,
        node_id: globalId('IssueComment', `${repo.fullName}:${number}:${c.id}`),
        body: c.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: isoOf(c.createdAt),
        updated_at: isoOf(c.createdAt),
      })));
      return true;
    }
  }

  // Pull requests
  if (method === 'POST' && path.endsWith('/pulls') && params.number === undefined) {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const head = typeof body.head === 'string' ? body.head : '';
    const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
    const headSha = repo.branchTip(head);
    const baseSha = repo.branchTip(base);
    if (headSha === undefined || baseSha === undefined) {
      sendError(res, 422, 'Head or base branch does not exist');
      return true;
    }
    const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
    if (existing !== undefined) {
      sendError(res, 422, 'A pull request already exists for this branch');
      return true;
    }
    const pull: Pull = {
      id: nextGlobalId,
      number: repo.nextNumber,
      title: typeof body.title === 'string' ? body.title : '',
      body: typeof body.body === 'string' ? body.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.nextNumber,
      createdAt: tickClock(),
    };
    nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    sendJson(res, 201, pullJson(repo, pull));
    return true;
  }
  if (method === 'GET' && path.endsWith('/pulls') && params.number === undefined) {
    let list = [...repo.pulls];
    const state = query.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.seq - a.seq);
    sendList(res, req, query, path, list.map((p) => pullJson(repo, p)));
    return true;
  }
  if (params.number !== undefined && path.includes('/pulls/')) {
    const number = Number(params.number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET' && path.endsWith('/files')) {
      sendJson(res, 200, pullFiles(repo, pull));
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (method === 'PUT' && path.endsWith('/merge')) {
      const body = parseJsonBody(res, raw);
      if (body === null) return true;
      if (pull.state !== 'open') {
        sendError(res, 405, 'Pull request is already closed');
        return true;
      }
      if (pullHasConflict(repo, pull)) {
        sendError(res, 405, 'Merge conflict');
        return true;
      }
      const sha = squashMerge(repo, pull);
      if (sha === null) {
        sendError(res, 405, 'Merge conflict');
        return true;
      }
      sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged` });
      return true;
    }
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Contents API
// ---------------------------------------------------------------------------

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, owner: string, repoName: string, filePath: string, query: URLSearchParams, method: string, raw: Buffer): Promise<boolean> {
  const cleanPath = filePath.replace(/^\/+/, '').replace(/\/+$/, '');
  if (method === 'GET') {
    const refParam = query.get('ref');
    const tip = refParam === null ? repo.branchTip(repo.defaultBranch) : (repo.branchTip(refParam) ?? (isOid(refParam) ? refParam : undefined));
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const files = repo.filesAt(tip);
    if (cleanPath === '') {
      sendJson(res, 200, directoryListing(repo, tip, ''));
      return true;
    }
    const entry = files.get(cleanPath);
    if (entry !== undefined) {
      const obj = repo.getObject(entry.oid);
      const content = obj === undefined ? Buffer.alloc(0) : obj.data;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: cleanPath.split('/').pop() ?? cleanPath,
        path: cleanPath,
        content: b64encode(content),
        sha: entry.oid,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${cleanPath}`,
      });
      return true;
    }
    // A directory: any file below this prefix?
    const prefix = `${cleanPath}/`;
    if ([...files.keys()].some((p) => p.startsWith(prefix))) {
      sendJson(res, 200, directoryListing(repo, tip, cleanPath));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  if (method === 'PUT') {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    let tip = repo.branchTip(branch);
    if (tip === undefined) {
      // Creating a branch implicitly: start from the default branch tip (or empty).
      tip = repo.branchTip(repo.defaultBranch);
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const files = repo.filesAt(tip);
    const existing = files.get(cleanPath);
    if (existing !== undefined) {
      if (givenSha !== undefined && givenSha !== existing.oid) {
        sendError(res, 409, 'Conflict: sha does not match the current file');
        return true;
      }
      if (givenSha === undefined) {
        sendError(res, 409, 'Conflict: sha is required to update a file');
        return true;
      }
    }
    const content = b64decode(contentB64);
    const blobOid = repo.putObject('blob', content);
    files.set(cleanPath, { oid: blobOid, mode: '100644' });
    const parents = tip === undefined ? [] : [tip];
    const commitSha = repo.commitFiles(parents, files, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(res, existing === undefined ? 201 : 200, {
      content: { name: cleanPath.split('/').pop() ?? cleanPath, path: cleanPath, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = parseJsonBody(res, raw);
    if (body === null) return true;
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const files = repo.filesAt(tip);
    const existing = files.get(cleanPath);
    if (existing === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    files.delete(cleanPath);
    const commitSha = repo.commitFiles([tip], files, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha, message } });
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function directoryListing(repo: Repo, tip: string, dir: string): Json[] {
  const files = repo.filesAt(tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, Json>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = repo.getObject(entry.oid);
      seen.set(rest, {
        type: 'file',
        name: rest,
        path,
        sha: entry.oid,
        size: obj?.data.length ?? 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        const subPath = prefix + name;
        const subTree = subtreeOid(repo, tip, subPath);
        seen.set(name, { type: 'dir', name, path: subPath, sha: subTree ?? '', size: 0, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${subPath}` });
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function subtreeOid(repo: Repo, tip: string, dirPath: string): string | null {
  const obj = repo.getObject(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  let treeOid = parseCommit(obj.data).tree;
  for (const segment of dirPath.split('/')) {
    const tree = repo.getObject(treeOid);
    if (tree === undefined) return null;
    const entry = parseTree(tree.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

interface GitRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, with peeled annotated tags. */
function listGitRefs(repo: Repo): GitRef[] {
  const out: GitRef[] = [];
  const defaultTip = repo.branchTip(repo.defaultBranch);
  out.push({
    oid: defaultTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: defaultTip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const ref: GitRef = { oid, name };
    const obj = repo.getObject(oid);
    if (obj !== undefined && obj.type === 'tag') {
      ref.peeled = parseTag(obj.data).object;
    }
    out.push(ref);
  }
  return out;
}

function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const parts: string[] = [];
  if (service === 'git-upload-pack') {
    parts.push('side-band-64k', 'thin-pack', 'ofs-delta', 'multi_ack_detailed', 'shallow', `symref=HEAD:refs/heads/${repo.defaultBranch}`, `agent=${AGENT}`);
  } else {
    parts.push('report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `symref=HEAD:refs/heads/${repo.defaultBranch}`, `agent=${AGENT}`);
  }
  return parts.join(' ');
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listGitRefs(repo);
  const caps = v0Capabilities(repo, service);
  refs.forEach((ref, index) => {
    const first = index === 0 ? `\0${caps}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${first}\n`));
    if (ref.peeled !== undefined) {
      parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'server-option\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, method: string, raw: Buffer): Promise<boolean> {
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch === null) return false;
  const owner = decodeURIComponent(gitMatch[1] ?? '');
  const repoName = decodeURIComponent(gitMatch[2] ?? '');
  const suffix = gitMatch[3] ?? '';
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const repo = findRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  try {
    if (method === 'GET' && suffix.startsWith('/info/refs')) {
      const query = parseQuery(req);
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendError(res, 400, 'Unknown service');
        return true;
      }
      const contentType = `application/x-${service}-advertisement`;
      if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBytes(res, 200, v2Advertisement(), contentType);
      } else {
        sendBytes(res, 200, v0Advertisement(repo, service), contentType);
      }
      return true;
    }
    if (method === 'POST' && suffix === '/git-upload-pack') {
      return handleUploadPack(req, res, repo, raw);
    }
    if (method === 'POST' && suffix === '/git-receive-pack') {
      return handleReceivePack(req, res, repo, raw);
    }
  } catch (err) {
    // A malformed git request must never take the server down.
    if (!res.writableEnded) sendError(res, 400, err instanceof Error ? err.message : 'Bad request');
    return true;
  }
  sendError(res, 404, 'Not Found');
  return true;
}

/** Sideband-encode `data` into band-1 pkt-lines (chunks under the pkt-line limit). */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([band])));
  return out;
}

// --- upload-pack ---

interface FetchPlan {
  /** Commits to send (with their trees/blobs). */
  sendCommits: string[];
  /** The new shallow boundary commits (depth-limited fetches). */
  shallow: string[];
  /** Previously shallow commits that are now fully present. */
  unshallow: string[];
}

/** Work out which commits a fetch sends, honouring haves, depth and old boundaries. */
function planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], shallowHeld: readonly string[], depth: number | null): FetchPlan {
  // Distances from the wants, walking parents, stopping at old shallow boundaries.
  const dist = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!dist.has(target)) {
        dist.set(target, 0);
        queue.push({ oid: target, d: 0 });
      }
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (!dist.has(want)) {
      dist.set(want, 0);
      queue.push({ oid: want, d: 0 });
    }
  }
  const shallowHeldSet = new Set(shallowHeld);
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (depth !== null && d >= depth) continue;
    if (shallowHeldSet.has(oid) && d > 0) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push({ oid: parent, d: d + 1 });
      }
    }
  }
  // The commits within depth (or all reachable when no depth).
  let within = [...dist.entries()].filter(([, d]) => depth === null || d < depth).map(([oid]) => oid);
  const shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of dist) {
      if (d === depth - 1) shallow.push(oid);
    }
    // A boundary commit whose parents are all outside the depth is shallow; a commit at
    // distance depth-1 with no parents is also the boundary. (dist holds exactly that set.)
  }
  const unshallow = [...shallowHeldSet].filter((oid) => within.includes(oid));
  if (depth === null) {
    // Exclude everything the client already holds (haves and their ancestors).
    const held = repo.reachableCommits(haves);
    within = within.filter((oid) => !held.has(oid));
  } else {
    // With a depth, only the have commits themselves are already held; their ancestors
    // outside the depth are excluded by the depth, inside it they are the boundary.
    const haveSet = new Set(haves);
    within = within.filter((oid) => !haveSet.has(oid));
  }
  return { sendCommits: within, shallow, unshallow };
}

/** Objects the client already holds: reachable from its haves, but never past a shallow boundary. */
function heldObjects(repo: Repo, haves: readonly string[], shallowHeld: readonly string[]): Set<string> {
  const out = new Set<string>();
  const shallowSet = new Set(shallowHeld);
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.getObject(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  };
  const stack = [...haves];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      if (view.tree !== '') addTreeClosure(view.tree);
      // A shallow boundary's parents are absent on the client: never walk past one.
      if (!shallowSet.has(oid)) for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      addTreeClosure(oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

function fetchObjects(repo: Repo, plan: FetchPlan, wants: readonly string[], haves: readonly string[], shallowHeld: readonly string[]): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const addTreeClosure = (treeOid: string): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.getObject(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
  };
  const addCommitRoot = (oid: string): void => {
    const obj = repo.getObject(oid);
    if (obj === undefined) return;
    out.set(oid, obj);
    if (obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
  };
  // Wanted tag objects themselves travel, with their target as a root (not its parents).
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj !== undefined && obj.type === 'tag') {
      out.set(want, obj);
      addCommitRoot(parseTag(obj.data).object);
    }
  }
  // Only the send set's commits travel: their trees and blobs, never their ancestors.
  for (const oid of plan.sendCommits) addCommitRoot(oid);
  // And never an object the client already holds (reachable from its haves, stopping at
  // shallow boundaries): an unchanged blob in the new tree is held, not new.
  for (const oid of heldObjects(repo, haves, shallowHeld)) out.delete(oid);
  return out;
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): boolean {
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const contentType = 'application/x-git-upload-pack-result';
  let packets: Pkt[];
  try {
    packets = decodePktLines(raw);
  } catch {
    sendError(res, 400, 'Malformed pkt-line stream');
    return true;
  }
  const lines = pktLinesText(packets);
  if (!isV2) {
    // v0: wants, shallow/deepen, flush, haves, done, flush.
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowHeld: string[] = [];
    let depth: number | null = null;
    let inHaves = false;
    for (const line of lines) {
      const text = line.replace(/\n$/, '');
      if (text === '') {
        inHaves = true;
        continue;
      }
      if (text.startsWith('want ')) wants.push(text.slice(5, 45));
      else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
      else if (text.startsWith('shallow ')) shallowHeld.push(text.slice(8, 48));
      else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
      else if (text === 'done') inHaves = true;
    }
    const plan = planFetch(repo, wants, haves, shallowHeld, depth);
    const objects = fetchObjects(repo, plan, wants, haves, shallowHeld);
    const pack = writePack(objects.values());
    const out: Buffer[] = [pktLine('NAK\n')];
    for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(...sidebandPackets(pack, 1));
    out.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(out), contentType);
    return true;
  }

  // v2: command=ls-refs | command=fetch, arguments after a delim.
  const commandLine = lines[0]?.replace(/\n$/, '') ?? '';
  // Re-walk the raw packets so delim boundaries are honoured.
  const afterDelim: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (pastDelim) afterDelim.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }

  if (commandLine === 'command=ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    for (const arg of afterDelim) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    const refs = listGitRefs(repo).filter((ref) => prefixes.length === 0 || prefixes.some((p) => ref.name.startsWith(p)));
    const out: Buffer[] = [];
    for (const ref of refs) {
      if (ref.unborn === true) {
        const attrs = ref.symrefTarget !== undefined && symrefs ? ` symref-target:${ref.symrefTarget}` : '';
        out.push(pktLine(`unborn ${ref.name}${attrs}\n`));
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget !== undefined && symrefs) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled !== undefined && peel) line += ` peeled:${ref.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(out), contentType);
    return true;
  }

  if (commandLine === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowHeld: string[] = [];
    let depth: number | null = null;
    let waitForDone = false;
    let done = false;
    for (const arg of afterDelim) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5, 45));
      else if (arg.startsWith('have ')) haves.push(arg.slice(5, 45));
      else if (arg.startsWith('shallow ')) shallowHeld.push(arg.slice(8, 48));
      else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7));
      else if (arg === 'wait-for-done') waitForDone = true;
      else if (arg === 'done') done = true;
    }
    const plan = planFetch(repo, wants, haves, shallowHeld, depth);
    const objects = fetchObjects(repo, plan, wants, haves, shallowHeld);
    const pack = writePack(objects.values());
    const out: Buffer[] = [];
    // Real git (and the kit client) send `done` with the fetch: the response then carries
    // no acknowledgments section — it goes straight to shallow-info / packfile. The acks
    // section exists only for a negotiation round without `done`.
    if (!done) {
      out.push(pktLine('acknowledgments\n'));
      out.push(pktLine('NAK\n'));
      if (waitForDone) out.push(pktLine('ready\n'));
      out.push(PKT_DELIM);
    }
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) out.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) out.push(pktLine(`unshallow ${oid}\n`));
      out.push(PKT_DELIM);
    }
    out.push(pktLine('packfile\n'));
    out.push(...sidebandPackets(pack, 1));
    out.push(PKT_FLUSH);
    sendBytes(res, 200, Buffer.concat(out), contentType);
    return true;
  }

  sendError(res, 400, `Unknown upload-pack command ${JSON.stringify(commandLine)}`);
  return true;
}

// --- receive-pack ---

function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): boolean {
  const contentType = 'application/x-git-receive-pack-result';
  // Split the body at the first flush pkt-line: commands before it, pack after it.
  let splitAt = -1;
  {
    let offset = 0;
    while (offset + 4 <= raw.length) {
      const lenText = raw.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
      const len = parseInt(lenText, 16);
      if (len === 0) {
        splitAt = offset + 4;
        break;
      }
      if (len < 4 || offset + len > raw.length) break;
      offset += len;
    }
  }
  if (splitAt < 0) {
    sendError(res, 400, 'Malformed receive-pack stream');
    return true;
  }
  let commands: { oldOid: string; newOid: string; ref: string }[] = [];
  try {
    const packets = decodePktLines(raw.subarray(0, splitAt));
    for (const line of pktLinesText(packets)) {
      const text = line.replace(/\n$/, '');
      if (text === '') continue;
      const nul = text.indexOf('\0');
      const head = nul >= 0 ? text.slice(0, nul) : text;
      const parts = head.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  } catch {
    sendError(res, 400, 'Malformed receive-pack commands');
    return true;
  }
  const packBytes = raw.subarray(splitAt);
  const reportLines: string[] = [];
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.getObject(oid));
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
      reportLines.push('unpack ok');
    } catch (err) {
      reportLines.push(`unpack ${err instanceof Error ? err.message : 'error'}`);
    }
  } else {
    reportLines.push('unpack ok');
  }
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (repo.getObject(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} missing object`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (!repo.isAncestor(current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  // The report-status stream inside band 1 ends with its own flush pkt-line; the outer
  // sideband stream ends with one flush. Real git's client hangs up without the inner flush.
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const out = Buffer.concat([...sidebandPackets(report, 1), PKT_FLUSH]);
  sendBytes(res, 200, out, contentType);
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser + executor for the documents gh sends
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlField[];
  typeCondition: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, GqlValue>;
  selection: GqlField[];
}

function gqlTokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < input.length && /[A-Za-z0-9_\-.+]/.test(input[j] as string)) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(input.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const tok = this.tokens[this.pos] as string;
    this.pos += 1;
    return tok;
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'query' || tok === 'mutation') {
        ops.push(this.parseOperation());
      } else if (tok === '{') {
        ops.push({ kind: 'query', name: null, variables: {}, selection: this.parseSelection() });
      } else {
        throw new Error(`unexpected token ${tok}`);
      }
    }
    return ops;
  }

  parseOperation(): GqlOperation {
    const kind = this.next() as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    const variables: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const varTok = this.next();
        if (!varTok.startsWith('$')) throw new Error(`expected variable, got ${varTok}`);
        this.expect(':');
        // Skip the type (may be [X!]! etc.); stop at the next variable or ')'.
        let depth = 0;
        for (;;) {
          const t = this.next();
          if (t === '[') depth += 1;
          else if (t === ']') depth -= 1;
          else if (t === '=') {
            this.parseValue();
            break;
          } else if (t === ')' && depth === 0) {
            this.pos -= 1;
            break;
          } else if (t.startsWith('$') && depth === 0) {
            this.pos -= 1;
            break;
          } else if ((t === ',' || t === ')') && depth === 0) {
            if (t === ')') this.pos -= 1;
            break;
          }
          if (this.peek() === undefined) break;
        }
        variables[varTok.slice(1)] = { kind: 'null' };
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selection = this.parseSelection();
    return { kind, name, variables, selection };
  }

  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selection = this.parseSelection();
      return { alias: null, name: '...', args: [], selection, typeCondition };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selection: GqlField[] = [];
    if (this.peek() === '{') selection = this.parseSelection();
    return { alias, name, args, selection, typeCondition: null };
  }

  parseValue(): GqlValue {
    const tok = this.next();
    if (tok.startsWith('$')) return { kind: 'variable', name: tok.slice(1) };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (tok === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    if (/^-?\d+\.\d+$/.test(tok)) return { kind: 'float', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => resolveGqlValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveGqlValue(field.value, variables);
      return out;
    }
  }
}

function gqlArg(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (arg === undefined) return undefined;
  return resolveGqlValue(arg.value, variables);
}

// The schema surface the suite introspects: field names per type.
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'],
  SearchType: [],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlCtx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(n: number): string {
  return b64encode(`cursor:${n}`);
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function executeGqlFields(ctx: GqlCtx, typeName: string, value: unknown, fields: readonly GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === '...') {
      // Inline fragment: only Repository is supported as a condition.
      if (field.typeCondition !== null && field.typeCondition !== typeName) continue;
      Object.assign(out, executeGqlFields(ctx, typeName, value, field.selection));
      continue;
    }
    const known = GQL_TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = resolveGqlField(ctx, typeName, value, field);
  }
  return out;
}

function resolveGqlField(ctx: GqlCtx, typeName: string, value: unknown, field: GqlField): unknown {
  const vars = ctx.variables;
  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return executeGqlFields(ctx, 'User', { login: VIEWER_LOGIN }, field.selection);
    }
    if (field.name === 'repository') {
      const owner = String(gqlArg(field, 'owner', vars) ?? '');
      const name = String(gqlArg(field, 'name', vars) ?? '');
      const repo = findRepo(owner, name);
      if (repo === undefined) return null;
      return executeGqlFields(ctx, 'Repository', repo, field.selection);
    }
    if (field.name === 'node') {
      const id = String(gqlArg(field, 'id', vars) ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null || parsed.kind !== 'Repository') return null;
      const [owner, name] = parsed.key.split('/', 2);
      const repo = findRepo(owner ?? '', name ?? '');
      if (repo === undefined) return null;
      return executeGqlFields(ctx, 'Repository', repo, field.selection);
    }
    if (field.name === '__type') {
      const typeArg = String(gqlArg(field, 'name', vars) ?? '');
      return resolveTypeIntrospection(ctx, typeArg, field.selection);
    }
    return null;
  }
  if (typeName === 'Mutation') {
    return resolveGqlMutation(ctx, field);
  }
  if (typeName === 'Repository' && value instanceof Repo) {
    const repo = value;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.fullName);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return repo.fullName;
      case 'owner':
        return executeGqlFields(ctx, 'User', { login: repo.owner }, field.selection);
      case 'defaultBranchRef': {
        const tip = repo.branchTip(repo.defaultBranch);
        if (tip === undefined) return null;
        return executeGqlFields(ctx, 'Ref', { name: repo.defaultBranch }, field.selection);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'createdAt':
      case 'updatedAt':
        return isoOf(repo.createdAt);
      case 'url':
        return `https://github.com/${repo.fullName}`;
      case 'issue': {
        const number = Number(gqlArg(field, 'number', vars));
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return null;
        return executeGqlFields(ctx, 'Issue', { repo, issue }, field.selection);
      }
      case 'issues': {
        const issues = listGqlIssues(repo, field, vars);
        const nodes = issues.page.map((issue) => executeGqlFields(ctx, 'Issue', { repo, issue }, subFields(field, 'nodes')));
        return { nodes, pageInfo: { hasNextPage: issues.hasNext, endCursor: issues.endCursor } };
      }
      case 'pullRequests': {
        const first = Number(gqlArg(field, 'first', vars) ?? 100);
        const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
        const nodes = pulls.map((pull) => executeGqlFields(ctx, 'PullRequest', { repo, pull }, subFields(field, 'nodes')));
        return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      case 'pullRequest': {
        const number = Number(gqlArg(field, 'number', vars));
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return null;
        return executeGqlFields(ctx, 'PullRequest', { repo, pull }, field.selection);
      }
      default:
        return null;
    }
  }
  if (typeName === 'Issue') {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return globalId('Issue', `${repo.fullName}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateGql(issue.state);
      case 'body':
        return issue.body;
      case 'createdAt':
        return isoOf(issue.createdAt);
      case 'updatedAt':
        return isoOf(issue.updatedAt);
      case 'url':
        return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      default:
        return null;
    }
  }
  if (typeName === 'PullRequest') {
    const { repo, pull } = value as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', `${repo.fullName}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pullStateGql(pull);
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pull.state === 'open' ? (pullHasConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'createdAt':
      case 'updatedAt':
        return isoOf(pull.createdAt);
      case 'files': {
        const first = Number(gqlArg(field, 'first', vars) ?? 100);
        const files = pullFiles(repo, pull).slice(0, first);
        const nodes = files.map((f) => executeGqlFields(ctx, 'PullRequestChangedFile', f, subFields(field, 'nodes')));
        return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default:
        return null;
    }
  }
  if (typeName === 'User') {
    const user = value as { login: string };
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return globalId('User', user.login);
    if (field.name === 'name') return user.login === VIEWER_LOGIN ? VIEWER_NAME : user.login;
    if (field.name === 'email') return user.login === VIEWER_LOGIN ? VIEWER_EMAIL : '';
    return null;
  }
  if (typeName === 'Ref') {
    const ref = value as { name: string };
    if (field.name === 'name') return ref.name;
    return null;
  }
  if (typeName === 'PullRequestChangedFile') {
    const file = value as Json;
    if (field.name === 'path') return String(file.filename ?? '');
    if (field.name === 'additions') return Number(file.additions ?? 0);
    if (field.name === 'deletions') return Number(file.deletions ?? 0);
    return null;
  }
  return null;
}

function subFields(field: GqlField, name: string): GqlField[] {
  const sub = field.selection.find((f) => f.name === name);
  return sub?.selection ?? [];
}

function listGqlIssues(repo: Repo, field: GqlField, vars: Record<string, unknown>): { page: Issue[]; hasNext: boolean; endCursor: string | null } {
  let list = [...repo.issues];
  const states = gqlArg(field, 'states', vars);
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((i) => wanted.has(issueStateGql(i.state)));
  }
  const orderBy = gqlArg(field, 'orderBy', vars) as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'DESC';
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  const after = gqlArg(field, 'after', vars);
  if (typeof after === 'string' && after !== '') {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = list.findIndex((i) => i.number === n);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = Number(gqlArg(field, 'first', vars) ?? 100);
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
  return { page, hasNext, endCursor };
}

function resolveTypeIntrospection(ctx: GqlCtx, typeName: string, selection: readonly GqlField[]): Record<string, unknown> | null {
  const fields = GQL_TYPE_FIELDS[typeName];
  const enums = GQL_TYPE_ENUMS[typeName];
  if (fields === undefined && enums === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name === 'fields') {
      out[field.alias ?? 'fields'] = (fields ?? []).map((name) => ({ name }));
    } else if (field.name === 'enumValues') {
      out[field.alias ?? 'enumValues'] = (enums ?? []).map((name) => ({ name }));
    } else if (field.name === 'name') {
      out[field.alias ?? 'name'] = typeName;
    } else if (field.name === 'kind') {
      out[field.alias ?? 'kind'] = enums !== undefined ? 'ENUM' : 'OBJECT';
    }
  }
  return out;
}

function resolveGqlMutation(ctx: GqlCtx, field: GqlField): unknown {
  const input = gqlArg(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const inputObj: Record<string, unknown> = typeof input === 'object' && input !== null ? input : {};
  if (field.name === 'createIssue') {
    const repoId = String(inputObj.repositoryId ?? '');
    const parsed = parseGlobalId(repoId);
    if (parsed === null || parsed.kind !== 'Repository') return { issue: null };
    const [owner, name] = parsed.key.split('/', 2);
    const repo = findRepo(owner ?? '', name ?? '');
    if (repo === undefined) return { issue: null };
    const ts = tickClock();
    const issue: Issue = {
      id: nextGlobalId,
      number: repo.nextNumber,
      title: String(inputObj.title ?? ''),
      body: typeof inputObj.body === 'string' ? inputObj.body : '',
      state: 'open',
      labels: [],
      seq: repo.nextNumber,
      createdAt: ts,
      updatedAt: ts,
    };
    nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    const sel = subFields(field, 'issue');
    return { issue: executeGqlFields(ctx, 'Issue', { repo, issue }, sel) };
  }
  if (field.name === 'closeIssue') {
    const issueId = String(inputObj.issueId ?? '');
    const parsed = parseGlobalId(issueId);
    if (parsed === null || parsed.kind !== 'Issue') return { issue: null };
    const key = parsed.key;
    const lastColon = key.lastIndexOf(':');
    const repoKeyPart = key.slice(0, lastColon);
    const number = Number(key.slice(lastColon + 1));
    const [o, r] = repoKeyPart.split('/', 2);
    const repo = findRepo(o ?? '', r ?? '');
    const issue = repo?.issues.find((i) => i.number === number);
    if (issue === undefined || repo === undefined) return { issue: null };
    issue.state = 'closed';
    issue.updatedAt = tickClock();
    const sel = subFields(field, 'issue');
    return { issue: executeGqlFields(ctx, 'Issue', { repo, issue }, sel) };
  }
  if (field.name === 'createPullRequest') {
    const repoId = String(inputObj.repositoryId ?? '');
    const parsed = parseGlobalId(repoId);
    if (parsed === null || parsed.kind !== 'Repository') return { pullRequest: null };
    const [owner, name] = parsed.key.split('/', 2);
    const repo = findRepo(owner ?? '', name ?? '');
    if (repo === undefined) return { pullRequest: null };
    const head = String(inputObj.headRefName ?? '');
    const base = String(inputObj.baseRefName ?? '');
    const headSha = repo.branchTip(head);
    const baseSha = repo.branchTip(base);
    if (headSha === undefined || baseSha === undefined) return { pullRequest: null };
    const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
    if (existing !== undefined) {
      const sel = subFields(field, 'pullRequest');
      return { pullRequest: executeGqlFields(ctx, 'PullRequest', { repo, pull: existing }, sel) };
    }
    const pull: Pull = {
      id: nextGlobalId,
      number: repo.nextNumber,
      title: String(inputObj.title ?? ''),
      body: typeof inputObj.body === 'string' ? inputObj.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      seq: repo.nextNumber,
      createdAt: tickClock(),
    };
    nextGlobalId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    const sel = subFields(field, 'pullRequest');
    return { pullRequest: executeGqlFields(ctx, 'PullRequest', { repo, pull }, sel) };
  }
  if (field.name === 'mergePullRequest') {
    const prId = String(inputObj.pullRequestId ?? '');
    const parsed = parseGlobalId(prId);
    if (parsed === null || parsed.kind !== 'PullRequest') return { pullRequest: null };
    const key = parsed.key;
    const lastColon = key.lastIndexOf(':');
    const repoKeyPart = key.slice(0, lastColon);
    const number = Number(key.slice(lastColon + 1));
    const [o, r] = repoKeyPart.split('/', 2);
    const repo = findRepo(o ?? '', r ?? '');
    const pull = repo?.pulls.find((p) => p.number === number);
    if (pull === undefined || repo === undefined) return { pullRequest: null };
    if (pull.state === 'open' && !pullHasConflict(repo, pull)) squashMerge(repo, pull);
    const sel = subFields(field, 'pullRequest');
    return { pullRequest: executeGqlFields(ctx, 'PullRequest', { repo, pull }, sel) };
  }
  if (field.name === 'addComment') {
    const subjectId = String(inputObj.subjectId ?? '');
    const parsed = parseGlobalId(subjectId);
    if (parsed === null || parsed.kind !== 'Issue') return { commentEdge: null };
    const key = parsed.key;
    const lastColon = key.lastIndexOf(':');
    const repoKeyPart = key.slice(0, lastColon);
    const number = Number(key.slice(lastColon + 1));
    const [o, r] = repoKeyPart.split('/', 2);
    const repo = findRepo(o ?? '', r ?? '');
    const issue = repo?.issues.find((i) => i.number === number);
    if (issue === undefined || repo === undefined) return { commentEdge: null };
    const comment: Comment = { id: nextGlobalId, body: String(inputObj.body ?? ''), createdAt: tickClock() };
    nextGlobalId += 1;
    const list = repo.comments.get(number) ?? [];
    list.push(comment);
    repo.comments.set(number, list);
    const sel = subFields(field, 'commentEdge');
    const nodeSel = sel.find((f) => f.name === 'node')?.selection ?? [];
    const node: Record<string, unknown> = {};
    for (const f of nodeSel) {
      if (f.name === 'id') node[f.alias ?? 'id'] = globalId('IssueComment', `${repo.fullName}:${number}:${comment.id}`);
      else if (f.name === 'body') node[f.alias ?? 'body'] = comment.body;
    }
    return { commentEdge: { node } };
  }
  return null;
}

function executeGqlOperation(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: GqlCtx = { variables, errors: [] };
  let ops: GqlOperation[];
  try {
    ops = new GqlParser(gqlTokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const op = ops[0];
  if (op === undefined) return { data: null, errors: [{ message: 'Empty query' }] };
  const typeName = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeGqlFields(ctx, typeName, null, op.selection);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<boolean> {
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  if (Array.isArray(body)) {
    const out = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Invalid operation' }] };
      const op = entry as { query?: unknown; variables?: unknown };
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'Missing query' }] };
      return executeGqlOperation(op.query, (op.variables as Record<string, unknown>) ?? {});
    });
    sendJson(res, 200, out);
    return true;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { errors: [{ message: 'Invalid request' }] });
    return true;
  }
  const op = body as { query?: unknown; variables?: unknown };
  if (typeof op.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'Missing query' }] });
    return true;
  }
  sendJson(res, 200, executeGqlOperation(op.query, (op.variables as Record<string, unknown>) ?? {}));
  return true;
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over Streamable HTTP at /mcp
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, Json>;
  required: string[];
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpToolJson(def: McpToolDef): Json {
  return {
    name: def.name,
    description: def.description,
    inputSchema: { type: 'object', properties: def.properties, required: def.required },
  };
}

function mcpResult(id: unknown, result: unknown): Json {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpToolTextResult(value: unknown, isError = false): Json {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError };
}

function findMcpRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repoName === '') return null;
  return findRepo(owner, repoName) ?? null;
}

function callMcpTool(name: string, args: Record<string, unknown>): Json {
  const def = MCP_TOOLS.find((t) => t.name === name);
  if (def === undefined) return mcpToolTextResult({ error: `Unknown tool: ${name}` }, true);
  const missing = def.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return mcpToolTextResult({ error: `Missing required argument(s): ${missing.join(', ')}` }, true);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(repoKey(VIEWER_LOGIN, repoName))) {
        return mcpToolTextResult({ error: 'Repository already exists' }, true);
      }
      repoSeq += 1;
      const repo = new Repo(nextRepoId, repoName, typeof args.description === 'string' ? args.description : '', args.private === true, repoSeq);
      nextRepoId += 1;
      repos.set(repoKey(VIEWER_LOGIN, repoName), repo);
      return mcpToolTextResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findMcpRepo(args);
      if (repo === null) return mcpToolTextResult({ error: 'Repository not found' }, true);
      return mcpToolTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findMcpRepo(args);
      if (repo === null) return mcpToolTextResult({ error: 'Repository not found' }, true);
      const ts = tickClock();
      const issue: Issue = {
        id: nextGlobalId,
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        seq: repo.nextNumber,
        createdAt: ts,
        updatedAt: ts,
      };
      nextGlobalId += 1;
      repo.nextNumber += 1;
      repo.issues.push(issue);
      return mcpToolTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findMcpRepo(args);
      if (repo === null) return mcpToolTextResult({ error: 'Repository not found' }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return mcpToolTextResult({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'create_pull_request': {
      const repo = findMcpRepo(args);
      if (repo === null) return mcpToolTextResult({ error: 'Repository not found' }, true);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(base);
      if (headSha === undefined || baseSha === undefined) {
        return mcpToolTextResult({ error: 'Head or base branch does not exist' }, true);
      }
      const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (existing !== undefined) return mcpToolTextResult(pullJson(repo, existing));
      const pull: Pull = {
        id: nextGlobalId,
        number: repo.nextNumber,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        seq: repo.nextNumber,
        createdAt: tickClock(),
      };
      nextGlobalId += 1;
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      return mcpToolTextResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findMcpRepo(args);
      if (repo === null) return mcpToolTextResult({ error: 'Repository not found' }, true);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return mcpToolTextResult({ error: 'Pull request not found' }, true);
      if (pull.state !== 'open') return mcpToolTextResult({ error: 'Pull request is already closed' }, true);
      if (pullHasConflict(repo, pull)) return mcpToolTextResult({ error: 'Merge conflict' }, true);
      const sha = squashMerge(repo, pull);
      if (sha === null) return mcpToolTextResult({ error: 'Merge conflict' }, true);
      return mcpToolTextResult({ number: pull.number, merged: true, state: 'closed', sha });
    }
    default:
      return mcpToolTextResult({ error: `Unknown tool: ${name}` }, true);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, raw: Buffer): Promise<boolean> {
  if (req.method === 'DELETE') {
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method not allowed');
    return true;
  }
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const text = raw.toString('utf8');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return true;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return true;
  }
  const msg = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Record<string, unknown>;
  // A notification (no id) is acknowledged with 202 and no body.
  if (msg.id === undefined) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    }));
    return true;
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
    }));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS.map((t) => mcpToolJson(t)) }));
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (toolName === '') {
      sendJson(res, 200, mcpError(id, -32602, 'Invalid params: missing tool name'));
      return true;
    }
    const def = MCP_TOOLS.find((t) => t.name === toolName);
    if (def === undefined) {
      sendJson(res, 200, mcpError(id, -32601, `Method not found: ${toolName}`));
      return true;
    }
    const missing = def.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      sendJson(res, 200, mcpError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`));
      return true;
    }
    sendJson(res, 200, mcpResult(id, callMcpTool(toolName, args)));
    return true;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return true;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
  return true;
}

// ---------------------------------------------------------------------------
// server entrypoint
// ---------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const raw = await readBody(req);
        if (path === '/mcp') {
          await handleMcp(req, res, raw);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, 405, 'Method not allowed');
            return;
          }
          await handleGraphql(req, res, raw);
          return;
        }
        if (path.startsWith('/api/v3')) {
          await handleRest(req, res, path, method, raw);
          return;
        }
        if (await handleGit(req, res, path, method, raw)) return;
        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.writableEnded) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal error');
        }
      }
    })();
  });
}
