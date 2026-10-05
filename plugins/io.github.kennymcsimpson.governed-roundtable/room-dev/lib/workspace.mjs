// Artifact freezing and snapshots (plan §5.2, §9.1; INTERFACES §7; contract 4 of §1.6).
//
// declareArtifacts  read-only traversal of the seat's declared paths -> manifest with per-file sha256
// recompute         same traversal again -> list of changed paths (stale detection, #16a)
// snapshot          copy the manifest's files into a destination, hash before and after the copy
//                   (copyTorn), then `git init` inside the copy so nothing discovers the seat's repo
// runInSnapshot     run argv inside a snapshot through spawnClean with TEMP/TMP pointed at the
//                   snapshot, HOME/USERPROFILE at an empty room-owned dir inside its metadata dir,
//                   git confined to the snapshot's own repo and config (see snapshotEnv)
//
// Structural guarantees: this module never calls git (or anything else) with the seat's real
// directory as cwd — declareArtifacts and recompute do not even take a spawn function. All writes go
// through a guard rooted at the destination; the seat's directory is only ever opened for reading.
//
// Containment is checked on real paths, not only lexically: the walker never follows a symlink or
// junction (in the declared path's intermediate components as well as inside directories), every
// declared path must resolve (realpath) inside the real cwd, and snapshot re-checks each source just
// before and just after copying it, so a junction swapped in after the declaration copies nothing.
// Anything named `.git` (a directory, or a worktree/submodule `gitdir:` pointer file) is never
// collected or copied: a copied pointer file would send git in the snapshot to the seat's real repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { nowIso, isInside, realPathNative } from './common.mjs';
import { createGuard } from './guard.mjs';
import { spawnClean, findOnPath, buildCleanEnv } from './spawn.mjs';

const WIN = process.platform === 'win32';
const NULL_DEVICE = WIN ? 'NUL' : '/dev/null';
const nameKey = (n) => (WIN ? n.toLowerCase() : n);
const isDefaultExcludedName = (n) => DEFAULT_EXCLUDED_DIRS.some((d) => nameKey(d) === nameKey(n));
const isGitName = (n) => nameKey(n) === '.git';

export const MANIFEST_SCHEMA = 'room-artifacts/1';
export const DEFAULT_SIZE_CAP_BYTES = 200 * 1024 * 1024;
export const DEFAULT_EXCLUDED_DIRS = Object.freeze(['.room-outbox', '.git', 'node_modules']);
export const SNAPSHOT_META_DIR = '.room-snapshot';
// Fields that make up the manifest identity. copyTorn is a snapshot-time observation and sha256 is
// the identity itself, so both stay outside the hash.
export const MANIFEST_HASHED_FIELDS = Object.freeze([
  'schema', 'seatId', 'baseline', 'declaredPaths', 'excludePatterns', 'files', 'deleted', 'excluded',
  'declaredAt', 'bytes', 'fileCount', 'sizeCapBytes', 'oversize', 'summary',
]);

export class WorkspaceError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------- pure helpers ----------

export function toRel(cwd, abs) {
  return path.relative(cwd, abs).split(path.sep).join('/');
}

// Minimal glob: `*` (within a segment), `**` (across segments), `?`. A pattern without `/` matches
// a path segment at any depth; one with `/` is anchored at the declared root. A trailing `/` means
// "this directory and everything under it". Matching is against forward-slash relative paths.
export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new WorkspaceError('BAD_GLOB', '排除模式不能为空');
  let p = pattern.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  while (p.startsWith('/')) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.replace(/\/+$/, '');
  if (!p) throw new WorkspaceError('BAD_GLOB', `排除模式无效：${pattern}`);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const anchored = p.includes('/');
  const tail = dirOnly ? '/' : '(?:/|$)';
  return new RegExp(anchored ? `^${re}${tail}` : `(?:^|/)${re}${tail}`);
}

export function compileExcludes(patterns = []) {
  return (patterns || []).map((pat) => ({ pattern: pat, re: globToRegExp(pat) }));
}

function matchExclude(compiled, relPath, isDir) {
  const probe = isDir ? `${relPath}/` : relPath;
  for (const { pattern, re } of compiled) if (re.test(probe) || re.test(relPath)) return pattern;
  return null;
}

// Deterministic JSON: object keys sorted recursively, arrays in place.
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

export function manifestSha256(manifest) {
  const subset = {};
  for (const k of MANIFEST_HASHED_FIELDS) if (manifest[k] !== undefined) subset[k] = manifest[k];
  return crypto.createHash('sha256').update(canonicalJson(subset)).digest('hex');
}

// Resolves on 'close', not 'end': on Windows a file whose descriptor is still open cannot be
// deleted or renamed, and the seat (or the test) may do exactly that right after we hashed it.
export function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let bytes = 0;
    let digest = null;
    let failed = false;
    const s = fs.createReadStream(absPath);
    s.on('data', (b) => { bytes += b.length; h.update(b); });
    s.on('error', (e) => { failed = true; reject(e); });
    s.on('end', () => { digest = h.digest('hex'); });
    s.on('close', () => { if (!failed && digest !== null) resolve({ sha256: digest, bytes }); });
  });
}

function assertInside(cwd, abs, what) {
  if (!isInside(abs, cwd)) throw new WorkspaceError('PATH_OUTSIDE_CWD', `${what}不在工作目录之内：${abs}`);
}

// The first component between root (exclusive) and abs (exclusive) that is a symlink or junction
// (lstat reports junctions as symlinks on Windows), as a relative path; null when there is none or a
// component does not exist (the caller's own lstat reports that).
function linkedIntermediate(root, abs) {
  const parts = path.relative(root, abs).split(path.sep).filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return parts.slice(0, i + 1).join('/');
  }
  return null;
}

// null when `abs` is safe to read as part of cwd: no link in any component (the last included) and
// its real path inside the real cwd. Otherwise the reason ('symlink' / 'outside'). A missing
// component returns null too: the caller's read reports ENOENT.
function unsafeSource(root, rootReal, abs) {
  if (linkedIntermediate(root, abs)) return 'symlink';
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) return 'symlink';
  let real;
  try { real = fs.realpathSync.native(abs); } catch { return null; }
  return isInside(real, rootReal) ? null : 'outside';
}

// Read-only walk. Returns sorted relative file paths and the excluded entries, never follows
// symlinks or junctions (a link could point outside cwd) — neither inside a directory nor in an
// intermediate component of a declared path — and requires each declared path to resolve inside
// the real cwd. Skips sockets/devices. Anything named `.git`, file or directory, is excluded; so is
// the room's own SNAPSHOT_META_DIR at the top. Missing declared paths throw unless missingOk
// (recompute treats a vanished directory as "everything deleted").
export function collectFiles({ cwd, paths, exclude = [], missingOk = false }) {
  const root = path.resolve(cwd);
  const rootReal = realPathNative(root);
  const compiled = compileExcludes(exclude);
  const files = new Map(); // rel -> abs
  const excluded = [];
  const missing = [];
  const seenDirs = new Set();

  const consider = (abs, rel, dirent) => {
    const isDir = dirent.isDirectory();
    const isFile = dirent.isFile();
    if (dirent.isSymbolicLink()) { excluded.push({ path: rel, reason: 'symlink' }); return; }
    // By name, for every entry type: a worktree or submodule has a `.git` FILE ("gitdir: ...").
    if (isDefaultExcludedName(path.basename(abs))) { excluded.push({ path: isDir ? `${rel}/` : rel, reason: 'default' }); return; }
    if (nameKey(rel.split('/')[0]) === nameKey(SNAPSHOT_META_DIR)) { excluded.push({ path: isDir ? `${rel}/` : rel, reason: 'reserved' }); return; }
    if (!isDir && !isFile) { excluded.push({ path: rel, reason: 'special' }); return; }
    if (isDir) {
      const hit = matchExclude(compiled, rel, true);
      if (hit) { excluded.push({ path: `${rel}/`, reason: 'exclude', pattern: hit }); return; }
      if (seenDirs.has(abs)) return;
      seenDirs.add(abs);
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { excluded.push({ path: `${rel}/`, reason: 'unreadable', detail: e.code }); return; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        const childAbs = path.join(abs, ent.name);
        consider(childAbs, rel ? `${rel}/${ent.name}` : ent.name, ent);
      }
      return;
    }
    const hit = matchExclude(compiled, rel, false);
    if (hit) { excluded.push({ path: rel, reason: 'exclude', pattern: hit }); return; }
    files.set(rel, abs);
  };

  for (const declared of paths) {
    const abs = path.resolve(root, declared);
    assertInside(root, abs, '声明路径');
    const rel = toRel(root, abs);
    // A `.git` anywhere in the declared path (".git/config", "sub/.git/hooks"): never collected.
    // (A declared path that ends in `.git` is excluded by consider below, which knows file vs dir.)
    const segs = rel.split('/');
    const gitPart = segs.findIndex(isGitName);
    if (gitPart !== -1 && gitPart < segs.length - 1) {
      excluded.push({ path: `${segs.slice(0, gitPart + 1).join('/')}/`, reason: 'default' });
      continue;
    }
    // A junction/symlink in an intermediate component ("j/secret.txt" with j -> ../outside).
    const link = linkedIntermediate(root, abs);
    if (link) { excluded.push({ path: rel, reason: 'symlink', via: link }); continue; }
    let st;
    try { st = fs.lstatSync(abs); } catch {
      if (missingOk) { missing.push(rel || '.'); continue; }
      throw new WorkspaceError('PATH_MISSING', `声明路径不存在：${abs}`);
    }
    if (!st.isSymbolicLink() && !isInside(realPathNative(abs), rootReal)) {
      excluded.push({ path: rel || '.', reason: 'symlink' });
      continue;
    }
    const dirent = { isDirectory: () => st.isDirectory(), isFile: () => st.isFile(), isSymbolicLink: () => st.isSymbolicLink() };
    if (st.isDirectory() && rel === '') {
      // Declaring the root itself: walk its children; default-excluded dirs still apply.
      let entries = [];
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { excluded.push({ path: './', reason: 'unreadable', detail: e.code }); }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      seenDirs.add(abs);
      for (const ent of entries) consider(path.join(abs, ent.name), ent.name, ent);
    } else {
      consider(abs, rel, dirent);
    }
  }
  const rels = [...files.keys()].sort();
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, files: rels.map((rel) => ({ path: rel, abs: files.get(rel) })), excluded, missing };
}

function normalizeDeclaredPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new WorkspaceError('NO_PATHS', '至少要声明一个路径');
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) throw new WorkspaceError('BAD_PATH', '声明路径必须是非空字符串');
    out.push(p);
  }
  return out;
}

async function hashAll(entries) {
  const result = [];
  for (const e of entries) {
    const { sha256, bytes } = await hashFile(e.abs);
    result.push({ path: e.path, sha256, bytes });
  }
  return result;
}

// ---------- declare ----------

// declareArtifacts({ cwd, paths, baseline, exclude, sizeCapBytes, seatId, now }) -> Promise<manifest>
// baseline: 'none' (default, the declaration is a baseline for a later diff), 'whole' (the whole
// content is the artifact set), or a previous manifest object -> files carry status
// added|modified|unchanged and `deleted` lists what vanished since that manifest.
export async function declareArtifacts({ cwd, paths, baseline = 'none', exclude = [], sizeCapBytes = DEFAULT_SIZE_CAP_BYTES, seatId, now = nowIso } = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new WorkspaceError('NO_CWD', '缺少工作目录');
  const root = path.resolve(cwd);
  let st;
  try { st = fs.statSync(root); } catch { throw new WorkspaceError('CWD_MISSING', `工作目录不存在：${root}`); }
  if (!st.isDirectory()) throw new WorkspaceError('CWD_NOT_DIR', `工作目录不是目录：${root}`);
  const declaredPaths = normalizeDeclaredPaths(paths);
  const excludePatterns = [...(exclude || [])];
  if (!Number.isInteger(sizeCapBytes) || sizeCapBytes < 0) throw new WorkspaceError('BAD_SIZE_CAP', '大小上限必须是非负整数');

  let baselineField;
  let baselineManifest = null;
  if (baseline === 'none' || baseline === 'whole') baselineField = baseline;
  else if (baseline && typeof baseline === 'object' && typeof baseline.sha256 === 'string') { baselineManifest = baseline; baselineField = baseline.sha256; }
  else throw new WorkspaceError('BAD_BASELINE', '基线必须是 none、whole 或上一份清单');

  const walk = collectFiles({ cwd: root, paths: declaredPaths, exclude: excludePatterns });
  const hashed = await hashAll(walk.files);

  let files = hashed;
  let deleted = [];
  let summary;
  if (baselineManifest) {
    const prev = new Map((baselineManifest.files || []).map((f) => [f.path, f]));
    files = hashed.map((f) => {
      const old = prev.get(f.path);
      const status = !old ? 'added' : old.sha256 === f.sha256 ? 'unchanged' : 'modified';
      return { ...f, status };
    });
    const nowSet = new Set(hashed.map((f) => f.path));
    deleted = [...prev.keys()].filter((p) => !nowSet.has(p)).sort();
    summary = {
      added: files.filter((f) => f.status === 'added').length,
      modified: files.filter((f) => f.status === 'modified').length,
      unchanged: files.filter((f) => f.status === 'unchanged').length,
      deleted: deleted.length,
    };
  }

  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    ...(seatId ? { seatId } : {}),
    baseline: baselineField,
    declaredPaths: declaredPaths.map((p) => toRel(root, path.resolve(root, p)) || '.'),
    excludePatterns,
    files,
    deleted,
    excluded: walk.excluded,
    declaredAt: now(),
    bytes,
    fileCount: files.length,
    sizeCapBytes,
    oversize: bytes > sizeCapBytes,
    ...(summary ? { summary } : {}),
    copyTorn: false,
  };
  manifest.sha256 = manifestSha256(manifest);
  return manifest;
}

// ---------- recompute ----------

// recompute(manifest, cwd) -> Promise<{ manifestSha, changed:[{path, from, to}], stale, recomputedAt }>
// from/to are sha256 or null (null = absent). Compares the current tree with the manifest's own
// file list, so a manifest is self-contained: no baseline lookup needed.
export async function recompute(manifest, cwd, { now = nowIso } = {}) {
  if (!manifest || !Array.isArray(manifest.files)) throw new WorkspaceError('BAD_MANIFEST', '清单格式不对');
  const root = path.resolve(cwd);
  const walk = collectFiles({ cwd: root, paths: manifest.declaredPaths || ['.'], exclude: manifest.excludePatterns || [], missingOk: true });
  const current = new Map();
  for (const e of walk.files) current.set(e.path, e.abs);
  const known = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const changed = [];
  for (const [rel, sha] of known) {
    const abs = current.get(rel);
    if (!abs) { changed.push({ path: rel, from: sha, to: null }); continue; }
    const { sha256 } = await hashFile(abs);
    if (sha256 !== sha) changed.push({ path: rel, from: sha, to: sha256 });
  }
  for (const [rel, abs] of current) {
    if (known.has(rel)) continue;
    const { sha256 } = await hashFile(abs);
    changed.push({ path: rel, from: null, to: sha256 });
  }
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifestSha: manifest.sha256, changed, stale: changed.length > 0, recomputedAt: now() };
}

// ---------- snapshot ----------

// Config git must use inside a snapshot regardless of any file in it (GIT_CONFIG_COUNT entries are
// applied last, above every config file): no fsmonitor or hook command, no pager, no credential
// helper. Without these, a `.gitconfig` the seat put in its cwd would become git's global config in
// the copy and `git status` would run its core.fsmonitor command (NI-2).
export const SNAPSHOT_GIT_CONFIG = Object.freeze([
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', NULL_DEVICE],
  ['core.pager', 'cat'],
  ['credential.helper', ''],
]);

// Room-owned, empty HOME for commands run in a snapshot. It lives under the metadata dir, which
// snapshot() never fills from the seat's files, so no copied dotfile is ever found there.
export function snapshotHome(snapshotDir) {
  return path.join(path.resolve(snapshotDir), SNAPSHOT_META_DIR, 'home');
}

// Keys snapshotEnv decides; a caller's extra value for one of them is ignored.
const PINNED_ENV = /^(HOME|USERPROFILE|XDG_CONFIG_HOME|TEMP|TMP|GIT_.*)$/i;
const EXTRA_GIT_OK = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/i;

export function snapshotEnv(snapshotDir, extra = {}) {
  const dir = path.resolve(snapshotDir);
  const home = snapshotHome(dir);
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) {
    if (PINNED_ENV.test(k) && !EXTRA_GIT_OK.test(k)) continue;
    out[k] = v;
  }
  Object.assign(out, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TEMP: dir, TMP: dir,
    GIT_CEILING_DIRECTORIES: path.dirname(dir).replace(/\\/g, '/'),
    // The copy's own repository and nothing else: no discovery, so even a stray `.git` pointer file
    // in the copy cannot redirect git to a seat's real repository (NI-1). When git init did not
    // run, this dir does not exist and git reports "not a git repository".
    GIT_DIR: path.join(dir, '.git'),
    GIT_WORK_TREE: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_COUNT: String(SNAPSHOT_GIT_CONFIG.length),
  });
  SNAPSHOT_GIT_CONFIG.forEach(([key, value], i) => { out[`GIT_CONFIG_KEY_${i}`] = key; out[`GIT_CONFIG_VALUE_${i}`] = value; });
  return out;
}

// checkCommand(argv0, { env }) -> { ok:true, file } | { ok:false, code, message }
// Resolves argv[0] the way runInSnapshot will run it: on the PATH of the clean env, never through a
// shell. On Windows a name that only exists as a .cmd/.bat (npm, npx, pnpm, yarn, tsc) cannot run
// without a shell, so it is reported as BATCH_SHIM_UNSUPPORTED instead of failing later with a bare
// ENOENT/EINVAL. Pure lookup, nothing is spawned; usable when a task draft's acceptance commands
// are accepted.
export function checkCommand(argv0, { env } = {}) {
  if (typeof argv0 !== 'string' || !argv0) return { ok: false, code: 'BAD_ARGV', message: 'argv[0] 必须是非空字符串' };
  const clean = buildCleanEnv(env || {});
  const shimMsg = (file) => `命令 ${argv0} 是 .cmd/.bat 批处理包装（${file}），不经 shell 无法执行；请改用 ["node", "<脚本路径>", ...] 的形式，或直接给出 .exe 的路径`;
  const found = findOnPath(argv0, { env: clean });
  if (found) {
    if (WIN && ['.cmd', '.bat'].includes(path.extname(found).toLowerCase())) return { ok: false, code: 'BATCH_SHIM_UNSUPPORTED', message: shimMsg(found) };
    return { ok: true, file: found };
  }
  if (WIN) {
    const shim = findOnPath(argv0, { env: clean, exts: ['.cmd', '.bat'] });
    if (shim) return { ok: false, code: 'BATCH_SHIM_UNSUPPORTED', message: shimMsg(shim) };
  }
  return { ok: false, code: 'COMMAND_NOT_FOUND', message: `在 PATH 上找不到命令 ${argv0}（Windows 上只认 .exe/.com），也不会经 shell 查找` };
}

function dirIsEmpty(dir) {
  try { return fs.readdirSync(dir).length === 0; } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
}

// snapshot(manifest, cwd, destDir, { guard, spawn, now, timeoutMs, overwrite })
//   -> Promise<{ destDir, copied, missing, torn, copyTorn, changed, stale, git, manifest, manifestPath }>
// Copies manifest.files from cwd into destDir, hashing each source right before the copy and the
// copy right after. A source that no longer matches the manifest is reported in `changed` (stale);
// a copy whose hash differs from the pre-copy hash is `torn` (copyTorn). Then `git init` inside
// destDir through the injected spawn, or a GIT_CEILING_DIRECTORIES note when git is not on PATH.
export async function snapshot(manifest, cwd, destDir, opts = {}) {
  const { guard: givenGuard, spawn = spawnClean, now = nowIso, timeoutMs = 30_000, overwrite = false } = opts;
  // gitExe: undefined -> look it up on the clean PATH; null -> behave as if git were absent (tests).
  const gitExe = opts.gitExe === undefined ? findOnPath('git') : opts.gitExe;
  if (!manifest || !Array.isArray(manifest.files)) throw new WorkspaceError('BAD_MANIFEST', '清单格式不对');
  const root = path.resolve(cwd);
  const dest = path.resolve(destDir);
  if (isInside(dest, root) || isInside(root, dest)) throw new WorkspaceError('DEST_OVERLAPS_CWD', `快照目录不能与工作目录重叠：${dest}`);
  if (!overwrite && !dirIsEmpty(dest)) throw new WorkspaceError('DEST_NOT_EMPTY', `快照目录已存在且非空：${dest}`);
  if (manifest.oversize && !opts.force) throw new WorkspaceError('OVERSIZE', `声明集超过大小上限（${manifest.bytes} > ${manifest.sizeCapBytes} 字节），只哈希不复制`);

  const metaDir = path.join(dest, SNAPSHOT_META_DIR);
  const guard = givenGuard || createGuard({ allowed: [dest], logPath: path.join(metaDir, 'write-log.jsonl'), who: 'workspace' });
  guard.mkdir(metaDir);
  guard.mkdir(snapshotHome(dest));
  const rootReal = realPathNative(root);

  const copied = [];
  const missing = [];
  const torn = [];
  const changed = [];
  const refused = []; // { path, reason }: never copied (reserved name, link, or outside the real cwd)
  for (const f of manifest.files) {
    const src = path.join(root, ...f.path.split('/'));
    assertInside(root, src, '清单路径');
    const dst = path.join(dest, ...f.path.split('/'));
    assertInside(dest, dst, '快照路径');
    // A manifest is data: whatever produced it, nothing lands in .git or in the metadata dir.
    const segs = f.path.split('/');
    if (segs.some(isGitName) || nameKey(segs[0]) === nameKey(SNAPSHOT_META_DIR)) {
      refused.push({ path: f.path, reason: 'reserved' });
      changed.push({ path: f.path, from: f.sha256, to: null });
      continue;
    }
    // Real-path containment right before reading (a junction swapped in after the declaration).
    const unsafe = unsafeSource(root, rootReal, src);
    if (unsafe) {
      refused.push({ path: f.path, reason: unsafe });
      changed.push({ path: f.path, from: f.sha256, to: null });
      continue;
    }
    let before;
    try { before = await hashFile(src); } catch (e) {
      if (e.code === 'ENOENT') { missing.push(f.path); changed.push({ path: f.path, from: f.sha256, to: null }); continue; }
      throw e;
    }
    if (before.sha256 !== f.sha256) changed.push({ path: f.path, from: f.sha256, to: before.sha256 });
    guard.mkdir(path.dirname(dst));
    guard.copyFile(src, dst);
    // ...and right after: a swap during the hash/copy window must not leave outside bytes behind.
    const unsafeAfter = unsafeSource(root, rootReal, src);
    if (unsafeAfter) {
      guard.rm(dst);
      refused.push({ path: f.path, reason: unsafeAfter });
      if (!changed.some((c) => c.path === f.path)) changed.push({ path: f.path, from: f.sha256, to: null });
      continue;
    }
    const after = await hashFile(dst);
    if (after.sha256 !== before.sha256) torn.push({ path: f.path, before: before.sha256, after: after.sha256 });
    copied.push({ path: f.path, sha256: after.sha256, bytes: after.bytes });
  }

  // Isolate the copy from the seat's real repository: an independent repo inside the copy, or a
  // note recording the ceiling that runInSnapshot sets when git is unavailable.
  const git = { method: null, ok: false, exe: null, code: null, detail: '' };
  const env = snapshotEnv(dest);
  // Never run git while dest/.git is anything but a directory: a `gitdir:` pointer file (left by an
  // overwrite, or by a foreign manifest) would make `git init` reinitialise the seat's real repo.
  let gitEntry = null;
  try { gitEntry = fs.lstatSync(path.join(dest, '.git')); } catch { /* absent: the normal case */ }
  if (gitEntry && !gitEntry.isDirectory()) {
    guard.rm(path.join(dest, '.git'));
    git.removedPointer = true;
  }
  if (gitExe) {
    git.exe = gitExe;
    const r = await spawn(gitExe, ['init', '-q'], { cwd: dest, env, timeoutMs });
    git.method = 'git-init';
    git.code = r.code;
    git.ok = r.code === 0 && !r.spawnError && !r.timedOut;
    git.detail = (r.spawnError || r.stderr || '').slice(0, 500);
    if (git.ok && fs.existsSync(path.join(dest, '.git'))) {
      guard.mkdir(path.join(dest, '.git', 'info'));
      guard.writeFile(path.join(dest, '.git', 'info', 'exclude'), `${SNAPSHOT_META_DIR}/\n`);
    }
  }
  if (!git.ok) {
    git.method = git.method || 'ceiling-note';
    guard.writeFile(path.join(metaDir, 'GIT_CEILING_DIRECTORIES.txt'),
      `${gitExe ? 'git init 失败' : '未在 PATH 上找到 git'}，本快照没有独立仓库。\n` +
      `runInSnapshot 会设置 GIT_CEILING_DIRECTORIES=${env.GIT_CEILING_DIRECTORIES}，禁止向上发现席位的真实仓库。\n` +
      (git.detail ? `detail: ${git.detail}\n` : ''));
  }

  const copyTorn = torn.length > 0;
  const frozen = { ...manifest, copyTorn };
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const record = {
    manifest: frozen, cwd: root, destDir: dest, snapshotAt: now(), copied, missing, torn, refused, changed, stale: changed.length > 0, git,
  };
  const manifestPath = path.join(metaDir, 'manifest.json');
  guard.writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`);
  return { destDir: dest, copied, missing, torn, refused, copyTorn, changed, stale: changed.length > 0, git, manifest: frozen, manifestPath };
}

// ---------- run ----------

// Git options that write outside the work tree, pick another repository or run another program.
// git accepts any unambiguous abbreviation of a long option (--outp= is --output=), so a long
// option is refused when it is a prefix of one of these names.
const GIT_REFUSED_LONG = Object.freeze(['output', 'output-directory', 'no-index', 'git-dir', 'work-tree', 'exec-path', 'namespace', 'super-prefix', 'config-env', 'ext-diff', 'textconv']);

// snapshotArgProblem(argv) -> null | {index, arg, why}. Applied to argv[1..] of every command run in
// a snapshot, whatever approved it: no NUL, no absolute / drive-letter / UNC operand (also as the
// value of --opt=value), no '..' segment; for git, no global option before the subcommand (-c,
// -C, --git-dir, ...) and none of GIT_REFUSED_LONG anywhere.
export function snapshotArgProblem(argv) {
  if (!Array.isArray(argv)) return { index: -1, arg: String(argv), why: 'argv 无效' };
  const isGit = typeof argv[0] === 'string' && /^git(\.exe)?$/i.test(path.basename(argv[0]));
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.includes('\0')) return { index: i, arg: a, why: '含 NUL 字符' };
    const eq = a.startsWith('-') ? a.indexOf('=') : -1;
    // The operand itself, the value of --opt=value, and the attached value of a short option (-oDIR).
    const values = [eq >= 0 ? a.slice(eq + 1) : a];
    if (/^-[A-Za-z]./.test(a) && !a.startsWith('--')) values.push(a.slice(2));
    for (const value of values) {
      if (/^[A-Za-z]:/.test(value)) return { index: i, arg: a, why: '盘符路径指向副本之外' };
      if (/^[\\/]{2}/.test(value)) return { index: i, arg: a, why: 'UNC 路径指向副本之外' };
      if (/^[\\/]/.test(value)) return { index: i, arg: a, why: '绝对路径指向副本之外' };
      if (value.split(/[\\/]/).includes('..')) return { index: i, arg: a, why: '含 .. 路径段' };
    }
    if (!isGit) continue;
    if (i === 1 && a.startsWith('-')) return { index: i, arg: a, why: 'git 子命令之前的全局选项' };
    if (a === '-c' || a === '-C') return { index: i, arg: a, why: 'git 配置/目录切换选项' };
    if (a.startsWith('--') && a.length > 2) {
      const name = a.slice(2).split('=')[0].toLowerCase();
      if (name && GIT_REFUSED_LONG.some((f) => f.startsWith(name))) return { index: i, arg: a, why: '会写到副本之外或换用别的仓库/程序' };
    }
  }
  return null;
}

// runInSnapshot({ snapshotDir, argv, extraEnv, timeoutMs, maxOutputBytes, spawn, privateDir, guard })
//   -> Promise<spawn result + { argv, resolvedFile, outputSha256, stdoutSha256, stderrSha256, privatePath }>
// argv[0] is resolved on the clean PATH (never through a shell); a name that only exists as a
// .cmd/.bat shim throws BATCH_SHIM_UNSUPPORTED, an unknown one COMMAND_NOT_FOUND (see checkCommand),
// and nothing is spawned in either case. outputSha256 is the sha256 of the
// raw stdout bytes followed by the raw stderr bytes; the two per-stream hashes are also returned.
// With privateDir + guard, the raw streams and the result are written there (private/<attemptId>/).
export async function runInSnapshot({ snapshotDir, argv, extraEnv = {}, timeoutMs, maxOutputBytes, spawn = spawnClean, privateDir, guard } = {}) {
  if (typeof snapshotDir !== 'string' || !snapshotDir) throw new WorkspaceError('NO_SNAPSHOT', '缺少快照目录');
  const dir = path.resolve(snapshotDir);
  let st;
  try { st = fs.statSync(dir); } catch { throw new WorkspaceError('SNAPSHOT_MISSING', `快照目录不存在：${dir}`); }
  if (!st.isDirectory()) throw new WorkspaceError('SNAPSHOT_NOT_DIR', `快照目录不是目录：${dir}`);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) throw new WorkspaceError('BAD_ARGV', 'argv 必须是非空字符串数组');
  if (privateDir && !guard) throw new WorkspaceError('NO_GUARD', '写入 private/ 需要 guard');
  // Second layer under the disclosure rule (NI-11): nothing that points outside the copy.
  const badArg = snapshotArgProblem(argv);
  if (badArg) throw new WorkspaceError('ARG_NOT_ALLOWED', `参数不被允许：${JSON.stringify(badArg.arg)}（${badArg.why}）；快照里的命令只能作用于快照副本`, { index: badArg.index });

  const env = snapshotEnv(dir, extraEnv);
  // Resolved before anything runs: a .cmd shim or an unknown name is a clear error, not a bare
  // ENOENT/EINVAL recorded as an execution with exitCode null (W6).
  const resolved = checkCommand(argv[0], { env });
  if (!resolved.ok) throw new WorkspaceError(resolved.code, resolved.message, { argv0: argv[0] });
  const resolvedFile = resolved.file;
  const home = snapshotHome(dir);
  if (!fs.existsSync(home)) {
    createGuard({ allowed: [dir], logPath: path.join(dir, SNAPSHOT_META_DIR, 'write-log.jsonl'), who: 'workspace' }).mkdir(home);
  }
  const spawnOpts = { cwd: dir, env };
  if (timeoutMs !== undefined) spawnOpts.timeoutMs = timeoutMs;
  if (maxOutputBytes !== undefined) spawnOpts.maxOutputBytes = maxOutputBytes;
  const r = await spawn(resolvedFile, argv.slice(1), spawnOpts);
  const rawOut = r.raw && r.raw.stdout ? r.raw.stdout : Buffer.from(r.stdout || '', 'utf8');
  const rawErr = r.raw && r.raw.stderr ? r.raw.stderr : Buffer.from(r.stderr || '', 'utf8');
  const stdoutSha256 = crypto.createHash('sha256').update(rawOut).digest('hex');
  const stderrSha256 = crypto.createHash('sha256').update(rawErr).digest('hex');
  const outputSha256 = crypto.createHash('sha256').update(rawOut).update(rawErr).digest('hex');

  let privatePath = null;
  if (privateDir) {
    const p = path.resolve(privateDir);
    guard.mkdir(p);
    guard.writeFile(path.join(p, 'stdout.bin'), rawOut);
    guard.writeFile(path.join(p, 'stderr.bin'), rawErr);
    const { raw, ...rest } = r;
    guard.writeFile(path.join(p, 'result.json'), `${JSON.stringify({ ...rest, argv, resolvedFile, outputSha256, stdoutSha256, stderrSha256 }, null, 2)}\n`);
    privatePath = p;
  }
  return { ...r, argv: [...argv], resolvedFile, outputSha256, stdoutSha256, stderrSha256, privatePath };
}
