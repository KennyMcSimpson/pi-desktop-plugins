// Shared helpers. Nothing in here writes to disk except through a guard (see guard.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function roomMjsPath() { return fileURLToPath(new URL('../room.mjs', import.meta.url)); }

export const SCHEMA_VERSION = 1;

// The first word of stdout is the contract (TURN, TURN_OVER, NOT_YOUR_TURN, ACCEPTED, REJECTED, ...).
// Exit codes stay 0 for every expected outcome: Codex and Claude Code both flag a non-zero exit as a
// failed tool call, and "not your turn yet" is not a failure. Only a rejected submission, a missing
// service and real errors exit non-zero.
export const EXIT = {
  OK: 0, TURN: 0, ACCEPTED: 0, NOT_YOUR_TURN: 0, TURN_OVER: 0, CANCELED: 0, ROOM_CLOSED: 0, LEFT: 0,
  REJECTED: 2, PENDING: 8, ERROR: 9,
};

export const ROOM_FILES = {
  room: 'room.json',
  events: 'events.jsonl',
  state: 'state.json',
  adminToken: 'admin.token',
  packets: 'packets',
  replies: 'replies',
  seats: 'seats',
  adminQueue: 'admin-queue',
  writeLog: 'write-log.jsonl',
  lock: 'service.lock',
};

export const OUTBOX_FILES = {
  joined: 'joined.json',
  leave: 'leave.json',
  lastAttempt: 'last-attempt.json',
  writeLog: 'write-log.jsonl',
};

export function nowIso() { return new Date().toISOString(); }
export function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
export function randomHex(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function out(line) { process.stdout.write(`${line}\n`); }
export function fwd(p) { return path.resolve(p).replace(/\\/g, '/'); }

export function normPath(p) {
  let r = path.resolve(p);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r;
}

export function isInside(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

export function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

// Tolerates a torn last line (the service may be mid-append).
export function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const outRows = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { outRows.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return outRows;
}

// Rooms live under %USERPROFILE%\room-dev\rooms, NOT under AppData. Measured 2026-10-01: a process
// started from inside an MSIX-packaged app (the Claude desktop app is one) has its AppData writes
// silently redirected into AppData\Local\Packages\<pkg>\LocalCache\..., and only processes in the same
// package context see the normal path. A Codex Desktop or Claude Code started from the Start menu would
// find the room directory missing. The user profile root is not virtualized.
export function appRoot() {
  return process.env.ROOM_DEV_HOME || path.join(os.homedir(), 'room-dev');
}
export function defaultRoomsRoot() { return path.join(appRoot(), 'rooms'); }
export function testRunsRoot() { return path.join(appRoot(), 'test-runs'); }

// Real on-disk location of an existing path (GetFinalPathNameByHandle on Windows). Falls back to the
// resolved path when the target does not exist yet or realpath fails.
export function realPathNative(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

// Returns null when `p` is where it says it is; otherwise a description of the redirection. Call it
// on a directory you just created and that other agents must be able to open.
export function virtualizationRedirect(p) {
  const asked = path.resolve(p);
  const real = realPathNative(asked);
  const norm = (x) => x.replace(/^\\\\\?\\/, '').toLowerCase().replace(/[\\/]+$/, '');
  if (norm(asked) === norm(real)) return null;
  const packaged = /[\\/]packages[\\/][^\\/]+[\\/]localcache[\\/]/i.test(real);
  return { asked, real, packaged };
}

// --key value / --flag parsing. Values may start with '-' only when quoted by the caller as --key=value.
export function parseArgs(argv) {
  const res = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { res[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const k = a.slice(2);
      const nx = argv[i + 1];
      if (nx !== undefined && !nx.startsWith('--')) { res[k] = nx; i++; } else res[k] = true;
    } else {
      res._.push(a);
    }
  }
  return res;
}

// ---- service.lock liveness (plan §6.5, INTERFACES §1). One definition for the service (start-up
// refusal) and for admin commands (serviceRunning): the pid must exist and the heartbeat, when the
// lock has one, must be younger than LOCK_STALE_MS. A crashed service stops beating, so a reused
// pid does not keep its lock alive past that.
export const LOCK_HEARTBEAT_MS = 20_000;
export const LOCK_STALE_MS = 120_000;
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function lockHolderAlive(lock, { nowMs = Date.now(), isAlive = pidAlive, staleMs = LOCK_STALE_MS } = {}) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return false;
  if (!isAlive(lock.pid)) return false;
  if (lock.heartbeatAt) {
    const hb = Date.parse(lock.heartbeatAt);
    if (Number.isFinite(hb) && nowMs - hb > staleMs) return false;
  }
  return true;
}

export function fail(msg, code = EXIT.ERROR) {
  process.stderr.write(`ERROR ${msg}\n`);
  process.exit(code);
}
