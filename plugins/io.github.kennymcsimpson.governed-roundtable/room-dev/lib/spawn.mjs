// The single door for child processes (non-interference contract 3, plan §1.6; INTERFACES §7).
// Every child the room starts (wake push, disclosure, acceptance command, Pi worker) goes through
// spawnClean: never through a shell, with an environment built from a short whitelist plus the keys
// the caller passes explicitly, with both output streams capped and a wall-clock timeout.
//
// What this module can and cannot promise:
// - The env block handed to the OS contains exactly the whitelist keys that exist in the source env
//   plus the caller's keys. Nothing inherited leaks through this layer.
// - On Windows, libuv itself re-adds a fixed set of variables it considers required when they are
//   missing (measured on Node 24: see IMPLICIT_WIN32_VARS). That happens below Node and cannot be
//   switched off from JavaScript, so a contract-3 checker (#42) on Windows must tolerate that set.
//   Callers that need a value of their own for one of them (e.g. USERPROFILE for a snapshot run) pass
//   it explicitly; an explicit key always wins.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ENV_WHITELIST = Object.freeze([
  'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'WINDIR',
]);

// Variables libuv copies from the parent into every Windows child when they are absent from the
// provided env (libuv src/win/process.c, required_vars). Observed, not chosen.
export const IMPLICIT_WIN32_VARS = Object.freeze([
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP',
  'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
]);

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

const WIN = process.platform === 'win32';
const EMPTY = Buffer.alloc(0);

// Windows env names are case-insensitive; a plain object (tests, fixtures) is not. Look up exactly
// first, then case-insensitively on Windows.
function lookupEnv(source, key) {
  if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) return source[key];
  if (!WIN) return undefined;
  const upper = key.toUpperCase();
  for (const k of Object.keys(source)) {
    if (k.toUpperCase() === upper && source[k] !== undefined) return source[k];
  }
  return undefined;
}

function validEnvName(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('=') && !name.includes('\0');
}

// Pure: whitelist keys present in `source`, then the caller's keys. A caller key set to null or
// undefined removes that name (case-insensitively on Windows). Values are coerced to strings.
export function buildCleanEnv(extra = {}, source = process.env) {
  const result = {};
  const seen = new Map(); // normalized name -> actual key in result
  const norm = (k) => (WIN ? k.toUpperCase() : k);
  const put = (k, v) => {
    const n = norm(k);
    if (seen.has(n)) delete result[seen.get(n)];
    seen.set(n, k);
    result[k] = v;
  };
  const drop = (k) => {
    const n = norm(k);
    if (seen.has(n)) { delete result[seen.get(n)]; seen.delete(n); }
  };
  for (const key of ENV_WHITELIST) {
    const v = lookupEnv(source, key);
    if (v === undefined || v === null) continue;
    if (seen.has(norm(key))) continue; // SystemRoot / SYSTEMROOT collapse to one on Windows
    put(key, String(v));
  }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (!validEnvName(k)) throw new TypeError(`buildCleanEnv: invalid env name ${JSON.stringify(k)}`);
      if (v === undefined || v === null) drop(k);
      else put(k, String(v));
    }
  }
  return result;
}

// Resolve an executable the way the child would see it, using the PATH of the *clean* env, never
// the shell. Returns the absolute path or null. Batch files (.cmd/.bat) are deliberately not
// candidates: Node refuses to run them without a shell, and a shell is exactly what we never use.
export function findOnPath(name, { env, exts } = {}) {
  if (typeof name !== 'string' || !name) return null;
  const e = env || buildCleanEnv();
  const extList = exts || (WIN ? ['.exe', '.com'] : ['']);
  const hasExt = WIN && path.extname(name) !== '';
  const candidatesFor = (base) => (hasExt || !WIN ? [base] : extList.map((x) => base + x));
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (name.includes('/') || name.includes('\\')) {
    for (const c of candidatesFor(path.resolve(name))) if (isFile(c)) return c;
    return null;
  }
  const pathValue = lookupEnv(e, 'PATH') || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const c of candidatesFor(path.join(dir, name))) if (isFile(c)) return c;
  }
  return null;
}

// killTree(child, { env, spawnFn }) — env is the whitelist-only block for taskkill itself (defaults to
// buildCleanEnv() of process.env); spawnFn is injectable for tests. taskkill is a child like any other
// (contract 3): never the service's inherited environment, never a shell, and resolved from
// %SystemRoot%\System32 rather than a PATH lookup.
export function killTree(child, { env, spawnFn = spawn } = {}) {
  if (!child || child.pid == null) return;
  if (WIN) {
    // taskkill /T takes the whole tree down; it is itself a direct child (no shell).
    try {
      const tkEnv = env || buildCleanEnv();
      const sysRoot = lookupEnv(tkEnv, 'SystemRoot') || 'C:\\Windows';
      const taskkill = path.join(sysRoot, 'System32', 'taskkill.exe');
      const tk = spawnFn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { env: tkEnv, shell: false, windowsHide: true, stdio: 'ignore' });
      tk.on('error', () => {});
      tk.unref();
    } catch { /* fall through to kill() */ }
  }
  try { child.kill(WIN ? undefined : 'SIGKILL'); } catch { /* already gone */ }
}

function makeSink(limit, onTruncate) {
  const chunks = [];
  let bytes = 0;
  return {
    push(buf) {
      if (bytes >= limit) { onTruncate(); return; }
      const room = limit - bytes;
      if (buf.length > room) { chunks.push(buf.subarray(0, room)); bytes += room; onTruncate(); }
      else { chunks.push(buf); bytes += buf.length; }
    },
    buffer() { return chunks.length ? Buffer.concat(chunks) : EMPTY; },
  };
}

// spawnClean(file, args, { cwd, env, timeoutMs, maxOutputBytes, source, stdin, input })
//   -> Promise<{ file, args, cwd, pid, code, signal, stdout, stderr, raw:{stdout,stderr},
//                stdoutBytes, stderrBytes, truncated, timedOut, spawnError, startedAt, durationMs }>
// Never rejects for process-level failures: a missing executable comes back as spawnError with
// code null, a timeout as timedOut:true. It throws only for programmer errors (bad arguments).
// `env` is the caller's explicit keys (added on top of the whitelist); `source` is where whitelist
// values are read from (process.env by default; tests inject a fake).
// `input` (string or Buffer) is written to the child's stdin, which is then closed; it is the one
// channel for data that must stay out of argv and env (the DPAPI helper's secret, lib/hosted/dpapi.mjs).
// It is never copied into the result.
export function spawnClean(file, args = [], opts = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('spawnClean: file must be a non-empty string');
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('spawnClean: args must be an array of strings');
  const {
    cwd, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    source = process.env, stdin = 'ignore', input,
  } = opts;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('spawnClean: timeoutMs must be >= 0');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) throw new TypeError('spawnClean: maxOutputBytes must be a non-negative integer');
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw new TypeError('spawnClean: input must be a string or a Buffer');
  const cleanEnv = buildCleanEnv(env, source);
  const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();

  return new Promise((resolve) => {
    const startedMs = Date.now();
    const result = {
      file, args: [...args], cwd: resolvedCwd, pid: null, code: null, signal: null,
      stdout: '', stderr: '', raw: { stdout: EMPTY, stderr: EMPTY }, stdoutBytes: 0, stderrBytes: 0,
      truncated: false, timedOut: false, spawnError: null,
      startedAt: new Date(startedMs).toISOString(), durationMs: 0,
    };
    let settled = false;
    let timer = null;
    const outSink = makeSink(maxOutputBytes, () => { result.truncated = true; });
    const errSink = makeSink(maxOutputBytes, () => { result.truncated = true; });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      result.raw.stdout = outSink.buffer();
      result.raw.stderr = errSink.buffer();
      result.stdout = result.raw.stdout.toString('utf8');
      result.stderr = result.raw.stderr.toString('utf8');
      result.stdoutBytes = result.raw.stdout.length;
      result.stderrBytes = result.raw.stderr.length;
      result.durationMs = Date.now() - startedMs;
      resolve(result);
    };

    let child;
    try {
      child = spawn(file, args, { cwd: resolvedCwd, env: cleanEnv, shell: false, windowsHide: true, stdio: [input !== undefined ? 'pipe' : stdin, 'pipe', 'pipe'] });
    } catch (e) {
      result.spawnError = `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`;
      finish();
      return;
    }
    result.pid = child.pid == null ? null : child.pid;
    if (input !== undefined && child.stdin) {
      // A child that exits without reading its stdin makes the write fail with EPIPE; that is the
      // child's outcome to report (exit code, output), not an exception here.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    if (child.stdout) child.stdout.on('data', (b) => outSink.push(b));
    if (child.stderr) child.stderr.on('data', (b) => errSink.push(b));
    child.on('error', (e) => {
      result.spawnError = `${e && e.code ? `${e.code}: ` : ''}${e && e.message ? e.message : String(e)}`;
      // 'close' usually follows; if it never comes (spawn itself failed), settle on the next tick.
      setImmediate(finish);
    });
    child.on('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      finish();
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        // Whitelist only, from the same source: the caller's explicit keys (a Pi worker's API key,
        // say) are for the child, not for taskkill.
        killTree(child, { env: buildCleanEnv({}, source) });
      }, timeoutMs);
    }
  });
}
