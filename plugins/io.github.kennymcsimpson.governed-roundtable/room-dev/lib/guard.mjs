// Every write the room makes goes through a guard: it refuses paths outside the allowed roots and
// appends one line per write to a write-log. This is the mechanism behind non-interference contract 1
// and tests #40/#43: the log is the room's own account of what it touched. (It is self-reported;
// a ProcMon pass is the independent check, see plan §1.6.)
import fs from 'node:fs';
import path from 'node:path';
import { isInside, nowIso } from './common.mjs';

export class GuardViolation extends Error {}

// On Windows a rename onto a file that another process has open fails with EPERM/EACCES/EBUSY even
// though libuv opens with FILE_SHARE_DELETE (measured, Node 24 / Win11). Seats poll state.json every
// 500 ms, so the service hits this routinely. The window is short (a reader holds the file for a
// read), so a bounded synchronous retry is enough: about 1.2 s in total, 1 ms backoff doubling to 50.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_RETRY = Object.freeze({ budgetMs: 1200, firstDelayMs: 1, maxDelayMs: 50 });
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

// renameRetry(src, dst, { renameFn }) -> number of retries it took. Rethrows the last error once the
// budget is spent or for any other error code. renameFn is injectable for tests only.
export function renameRetry(src, dst, { renameFn = fs.renameSync, budget = RENAME_RETRY } = {}) {
  const deadline = Date.now() + budget.budgetMs;
  let delay = budget.firstDelayMs;
  for (let retries = 0; ; retries++) {
    try { renameFn(src, dst); return retries; } catch (e) {
      if (!e || !RETRY_CODES.has(e.code) || Date.now() >= deadline) throw e;
    }
    sleepSync(delay);
    delay = Math.min(delay * 2, budget.maxDelayMs);
  }
}

export function createGuard({ allowed, logPath, who, renameFn }) {
  const roots = allowed.map((d) => path.resolve(d));
  const renameOpts = renameFn ? { renameFn } : {};
  const logAbs = path.resolve(logPath);

  function check(p, op) {
    const abs = path.resolve(p);
    if (!roots.some((r) => isInside(abs, r))) {
      throw new GuardViolation(`${who}: refused ${op} outside allowed roots: ${abs}`);
    }
    return abs;
  }
  check(logAbs, 'log');

  function log(op, abs, extra) {
    const rec = { ts: nowIso(), who, op, path: abs, pid: process.pid, ...(extra || {}) };
    try { fs.appendFileSync(logAbs, `${JSON.stringify(rec)}\n`); } catch { /* best effort */ }
  }

  return {
    roots,
    mkdir(p) { const a = check(p, 'mkdir'); fs.mkdirSync(a, { recursive: true }); log('mkdir', a); },
    writeFile(p, data) { const a = check(p, 'write'); fs.writeFileSync(a, data); log('write', a, { bytes: Buffer.byteLength(data) }); },
    // append + fsync: events.jsonl is the single commit point, so a line is only "committed" once it is on disk.
    appendFsync(p, data) {
      const a = check(p, 'append');
      const fd = fs.openSync(a, 'a');
      try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      log('append', a, { bytes: Buffer.byteLength(data) });
    },
    atomicWrite(p, data) {
      const a = check(p, 'write');
      const tmp = check(`${a}.tmp-${process.pid}`, 'write');
      let retries;
      try {
        fs.writeFileSync(tmp, data);
        retries = renameRetry(tmp, a, renameOpts);
      } catch (e) {
        // Never leave a *.tmp-<pid> behind: the target keeps its previous content, the caller sees the error.
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
      }
      log('write', a, { bytes: Buffer.byteLength(data), atomic: true, ...(retries ? { retries } : {}) });
    },
    copyFile(src, dst) { const a = check(dst, 'write'); fs.copyFileSync(src, a); log('write', a, { copiedFrom: path.resolve(src) }); },
    rename(src, dst) {
      const s = check(src, 'rename'); const d = check(dst, 'rename');
      const retries = renameRetry(s, d, renameOpts);
      log('rename', d, { from: s, ...(retries ? { retries } : {}) });
    },
    rm(p) { const a = check(p, 'rm'); fs.rmSync(a, { force: true }); log('rm', a); },
  };
}
