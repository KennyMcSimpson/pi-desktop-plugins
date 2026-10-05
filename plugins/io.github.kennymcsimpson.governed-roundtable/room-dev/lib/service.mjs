// The room service (INTERFACES §8): single writer of events.jsonl, issuer of packets, reader of seat
// outboxes. It never writes outside the room directory (every write goes through a guard rooted
// there; the one exception is the application-level adjudications.jsonl, through a guard that allows
// exactly that file), never writes into a seat's outbox or cwd, never starts or stops an agent. Its
// outward actions are the optional wake push to a thread the user registered for exactly that
// purpose, disclosure / acceptance commands inside snapshot copies, and the built-in Pi seat, which
// is the room's own in-process seat (including, at start, one Windows PowerShell child that
// unprotects the user's DPAPI-saved Pi key when no other key was given; it only reads that file).
// Every child process goes through lib/spawn.mjs.
//
//   createRoomService({roomDir, now, log, spawn, codexExe, mutate, ...}) -> {tick, state, view, emit, admin, ...}
//     Pi key options: piApiKey (in memory), savedPiKeyPath (default appRoot()/secrets/pi-key.dpapi),
//     savedPiKey:false (never read the saved file), piKeyUnprotect (test hook for the DPAPI call).
//   serve({roomDir, tickMs, port, once})  CLI wrapper: loop tick(), optional loopback HTTP (lib/http.mjs)
//
// The reducer lives in lib/reducer.mjs (pure). Everything the service decides is an appended event;
// state.json is only ever the fold of events.jsonl plus a few derived read-only views.
import fs from 'node:fs';
import path from 'node:path';
import { ROOM_FILES as F, OUTBOX_FILES as O, sha256, randomHex, readJson, sleep, out, fwd, roomMjsPath, appRoot, normPath,
  LOCK_HEARTBEAT_MS, LOCK_STALE_MS, lockHolderAlive, pidAlive,
} from './common.mjs';
import { createGuard } from './guard.mjs';
import { seatRoomCmd } from './join.mjs';
import { seatSurface, surfaceLine } from './surface.mjs';
import { renderPacket, renderFarewell, escapeMarkers, loadTemplates, block } from './packet.mjs';
import readline from 'node:readline';
import { findCodex, codexHome } from './codex.mjs';
import { spawnClean } from './spawn.mjs';
import { applyEvent, rebuild, pendingAttempts, staleCovered } from './reducer.mjs';
import {
  COMMAND_KINDS, REASON_TEXT, parseMarkers, resolveSubmission, malformedFollowUp, buildItemTable, applyMarks,
  unknownMarks, unanswered as unansweredItems, verifyQuote, pointItemId, checkResolvedVerdicts,
} from './structured.mjs';
import {
  validateDivisionRound, resolveReviewers, isLead, isReviewer, takesWork, requestDisclosure, approveDisclosure,
  denyDisclosure, executeDisclosure, effectiveAllowlist, appendAdjudication, readAdjudications, rejectRateSignal,
  bindVerdict, authorizedVerdict, verifiedStatus, reverse as reverseRoom, reviewerAgentOf,
} from './supervision.mjs';
import { declareArtifacts, recompute, snapshot, runInSnapshot, checkCommand as checkCommandDefault } from './workspace.mjs';
import { isPaused, budgetStatus } from './usage.mjs';
import { auditAttempt, locateFiles } from './audit.mjs';
import { createPiSeat } from './hosted/pi.mjs';
import { loadSavedPiKey, savedPiKeyPath } from './hosted/dpapi.mjs';

export { initialState, reduce, rebuild } from './reducer.mjs';

// Deliberately broken rooms for the mutation tests (INTERFACES §11, plan §12.4 / §13.1 「+变异」).
export const MUTATIONS = Object.freeze([
  'no-dedupe', 'no-attempt-check', 'no-recompute', 'no-audit',
  'no-escape', 'no-unanswered', 'no-disclose-gate', 'no-marker-strict',
]);
export const ADMIN_COMMANDS = Object.freeze([
  'task', 'start', 'cancel', 'skip', 'retry', 'wake', 'close', 'say', 'interrupt', 'confirm-task', 'reverse', 'reconcile', 'reassign',
  'approve-disclose', 'deny-disclose', 'accept-stale', 'pi-key', 'pi-permission',
]);
// service.lock liveness (plan §6.5): the holder must still be alive, its heartbeat recent, and
// (when it can be asked) the process with that pid must be the one that wrote the lock.
export { LOCK_HEARTBEAT_MS, LOCK_STALE_MS, lockHolderAlive };
const LOCK_START_TOLERANCE_MS = 5_000;
const PHASES = ['assign', 'work', 'meet', 'summary'];
const DEFAULT_WALL_SEC = 2700;
const DEFAULT_WORK_WALL_SEC = 3600;
const MATERIAL_MAX_BYTES = 32 * 1024;
const LIST_MAX = 50;

export function parseMutate(m) {
  const list = Array.isArray(m) ? m : String(m || '').split(/[,\s|]+/);
  return new Set(list.map((x) => String(x).trim()).filter((x) => MUTATIONS.includes(x)));
}

// The phase plan of one round for a room.json (INTERFACES §2/§3). A room without a preset is the
// P-1 meet-only room: no summary, no assign, no Work.
export function phasesFor(room) {
  if (Array.isArray(room.phases) && room.phases.length) return room.phases.filter((p) => PHASES.includes(p));
  switch (room.preset) {
    case 'discussion': case 'cross-check': case 'report': return ['meet', 'summary'];
    case 'implement-review': return room.assign === true ? ['assign', 'work', 'meet', 'summary'] : ['work', 'meet', 'summary'];
    case 'division': return ['assign', 'work', 'meet', 'summary'];
    case 'simplified': return room.simplifiedMode === 'implement-review' ? ['work', 'meet', 'summary'] : ['meet', 'summary'];
    default: return ['meet'];
  }
}

function clip(s, n = 500) { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…` : t; }
function isArgv(v) { return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0); }

// A guard that permits exactly one append-only file (plus creating its directory). The
// adjudications log lives in the application root, shared across rooms (INTERFACES §1).
function singleFileGuard(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const g = createGuard({ allowed: [dir], logPath: path.join(dir, 'adjudications-write-log.jsonl'), who: 'service:adjudications' });
  return {
    mkdir(p) { if (normPath(p) !== normPath(dir)) throw new Error(`refused mkdir ${p}`); fs.mkdirSync(dir, { recursive: true }); },
    appendFsync(p, data) { if (normPath(p) !== normPath(abs)) throw new Error(`refused append ${p}`); g.appendFsync(abs, data); },
  };
}

export function createRoomService(opts = {}) {
  const roomDir = path.resolve(opts.roomDir);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const iso = () => new Date(now()).toISOString();
  const log = typeof opts.log === 'function' ? opts.log : out;
  const spawn = typeof opts.spawn === 'function' ? opts.spawn : spawnClean;
  const M = parseMutate(opts.mutate !== undefined ? opts.mutate : process.env.ROOM_MUTATE);
  const roomPath = path.join(roomDir, F.room);
  const room0 = readJson(roomPath);
  const guard = createGuard({ allowed: [roomDir], logPath: path.join(roomDir, F.writeLog), who: 'service' });
  const adjPath = path.resolve(opts.adjudicationsPath || path.join(appRoot(), 'adjudications.jsonl'));
  const roomCmd = `node ${fwd(roomMjsPath())}`;
  // An app-runtime seat (lib/join.mjs) is told to run its own room.cmd instead.
  const roomCmdFor = (seat) => seatRoomCmd({ seat, seatDir: path.join(roomDir, F.seats, seat.seatId), fallback: roomCmd });
  const templates = loadTemplates();
  const gitExe = opts.gitExe;
  let codexExe = opts.codexExe;
  let codexLooked = codexExe !== undefined;
  // idleCheck({seat, thread}) -> {idle: true | false | null, note, thread?}; default resolves a
  // registered thread name to its UUID through CODEX_HOME/session_index.jsonl (resolveCodexThread),
  // then reads that thread's own rollout log read-only (codexThreadIdle). `thread` in the answer is
  // what the push goes to. Tests inject one.
  const idleCheck = typeof opts.idleCheck === 'function' ? opts.idleCheck : async ({ thread }) => {
    const home = opts.codexHome || codexHome();
    const r = resolveCodexThread(thread, { home });
    if (!r.id) return { idle: null, note: r.note };
    const idle = await codexThreadIdle(r.id, { home });
    return { ...idle, ...(idle.idle === null && r.note ? { note: `${idle.note}；${r.note}` } : {}), thread: r.id };
  };
  const snapshotFn = typeof opts.snapshot === 'function' ? opts.snapshot : snapshot;
  // checkCommand(argv0) -> {ok, file} | {ok:false, code, message}: how an acceptance command's
  // argv[0] resolves on the clean PATH (lib/workspace.mjs); tests inject one.
  const checkCommand = typeof opts.checkCommand === 'function' ? opts.checkCommand : (argv0) => checkCommandDefault(argv0);
  // Environment findCodex() looks in (CODEX_CLI_PATH, CODEX_HOME, LOCALAPPDATA, PATH); tests inject one.
  const codexEnv = opts.codexEnv && typeof opts.codexEnv === 'object' ? opts.codexEnv : undefined;

  for (const d of [F.packets, F.replies, F.adminQueue, path.join(F.adminQueue, 'done'), 'manifests', 'artifacts', 'snapshots', 'private']) guard.mkdir(path.join(roomDir, d));

  // ---- single instance per room directory (plan §6.5)
  const lockPath = path.join(roomDir, F.lock);
  const existing = readJson(lockPath, null);
  // opts.lockProbe: what serve() learned by asking the OS about the holder ('stale' | 'alive' | 'unknown').
  if (existing && existing.pid && existing.pid !== process.pid && opts.lockProbe !== 'stale' && lockHolderAlive(existing)) {
    const e = new Error(`这个房间的服务已在运行（pid ${existing.pid}），不再启动第二个。若确认那个进程已经退出，等心跳过期（约 ${Math.round(LOCK_STALE_MS / 1000)} 秒）后重试。`);
    e.code = 'SERVICE_RUNNING';
    throw e;
  }
  if (existing && existing.pid && existing.pid !== process.pid) log(`[service] stale service.lock (pid ${existing.pid}) replaced`);
  const procStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const lockStartedAt = iso();
  // `image` is the writer's own executable name (node, or PI-Ecosystem when a host runs the service
  // with ELECTRON_RUN_AS_NODE), so the OS probe compares against what really holds the lock.
  const procImage = path.basename(process.execPath).replace(/\.exe$/i, '');
  function writeLock() { guard.atomicWrite(lockPath, JSON.stringify({ pid: process.pid, image: procImage, startedAt: lockStartedAt, procStartedAt, heartbeatAt: new Date().toISOString() })); }
  // Called by serve() every LOCK_HEARTBEAT_MS; a lock whose heartbeat is older than LOCK_STALE_MS
  // belongs to a service that is gone even when its pid has been reused.
  function heartbeat() {
    if (closed) return;
    const cur = readJson(lockPath, null);
    if (cur && cur.pid !== process.pid) return;
    try { writeLock(); } catch (e) { log(`[service] heartbeat write failed: ${e.message}`); }
  }
  writeLock();

  // ---- older versions handed the Pi key over as private/pi-key-*.key; none may stay on disk (NI-3).
  try {
    for (const n of fs.readdirSync(path.join(roomDir, 'private'))) {
      if (!/^pi-key-.*\.key$/i.test(n)) continue;
      try { guard.rm(path.join(roomDir, 'private', n)); log(`[service] removed a leftover key handoff file private/${n}`); } catch (e) { log(`[service] could not remove private/${n}: ${e.code || e.message}`); }
    }
  } catch { /* no private dir */ }

  // ---- torn tail (plan #19): a crash mid-append leaves a line without '\n'; terminate it so the
  // next append starts a fresh line. readJsonl skips the torn line.
  const eventsPath = path.join(roomDir, F.events);
  if (!fs.existsSync(eventsPath)) guard.writeFile(eventsPath, '');
  else {
    const st = fs.statSync(eventsPath);
    if (st.size > 0) {
      const fd = fs.openSync(eventsPath, 'r');
      const b = Buffer.alloc(1);
      try { fs.readSync(fd, b, 0, 1, st.size - 1); } finally { fs.closeSync(fd); }
      if (b[0] !== 0x0a) { guard.appendFsync(eventsPath, '\n'); log('[service] events.jsonl ended in a torn line; it is ignored and a fresh line was started'); }
    }
  }

  const rebuilt = rebuild(roomDir);
  const state = rebuilt.state;
  const events = rebuilt.events;
  log(`[service] room=${room0.id} dir=${fwd(roomDir)} rebuilt from ${rebuilt.count} events; phase=${state.phase} attempt=${state.attempt ? state.attempt.attemptId : '-'}${M.size ? ` MUTATE=${[...M].join(',')}` : ''}`);
  const adminToken = fs.readFileSync(path.join(roomDir, F.adminToken), 'utf8').trim();
  let piKey = typeof opts.piApiKey === 'string' && opts.piApiKey ? opts.piApiKey : (process.env.ROOM_PI_API_KEY || null);
  // Where the key came from (shown in state.json, never the key): option (serve --pi-key-stdin or an
  // in-process caller), env (ROOM_PI_API_KEY), admin (loopback /api/admin), saved (DPAPI file).
  let piKeySource = piKey ? (opts.piApiKey ? 'option' : 'env') : null;

  const inflight = new Set();
  const hostedQueue = [];
  const hosted = new Map(); // seatId -> {pi, attemptId}
  const wakeInFlight = new Set();
  let adjSignal = null;
  let conflicts = [];
  let closed = false;
  let pausedLogged = false;
  const manifestCache = new Map();

  function track(p) { inflight.add(p); p.finally(() => inflight.delete(p)); return p; }

  // ---- the saved (DPAPI-protected) Pi key (P3, INTERFACES §9). Only when no key came from the
  // option or the environment, only for a room that has hosted seats, and only when the file exists.
  // Unprotecting is one PowerShell child, so it is asynchronous: every serialized operation (tick,
  // admin call, HTTP seat request) is chained behind it (see `chain` below), so no hosted turn starts
  // before it settled, and a loopback key that arrives later still wins. The key is never logged,
  // emitted or written; a failure is logged in Chinese with its ASCII code and the room continues
  // without a key (hosted seats then fail with PI_NO_KEY as before).
  let savedKeyReady = Promise.resolve();
  if (!piKey && opts.savedPiKey !== false && room0.seats.some((s) => s && s.hosted && (s.hosted.kind || 'pi') === 'pi')) {
    const keyFile = path.resolve(opts.savedPiKeyPath || savedPiKeyPath());
    if (fs.existsSync(keyFile)) {
      savedKeyReady = track(Promise.resolve()
        .then(() => loadSavedPiKey({ file: keyFile, ...(typeof opts.piKeyUnprotect === 'function' ? { unprotect: opts.piKeyUnprotect } : {}) }))
        .then((r) => {
          if (r && typeof r.key === 'string') {
            if (piKey) return; // a key from /api/admin arrived first; it wins
            piKey = r.key;
            piKeySource = 'saved';
            log(`[service] 内置 Pi 的 key 取自 DPAPI 保存的文件 ${fwd(keyFile)}（只在内存里使用，不显示、不写入房间）`);
          } else if (r && r.saved) {
            log(`[service] 警告：保存的内置 Pi key 无法使用（${r.code || 'DPAPI_FAILED'}），本次不使用它，托管席位的回合会报 PI_NO_KEY。可用 admin pi-key --status 查看，--save 重新保存，或改用 ROOM_PI_API_KEY / serve --pi-key-stdin。`);
          }
        }, (e) => {
          log(`[service] 警告：读取保存的内置 Pi key 出错（${(e && typeof e.code === 'string' && /^[A-Z0-9_]+$/.test(e.code)) ? e.code : 'DPAPI_FAILED'}），本次不使用它，托管席位的回合会报 PI_NO_KEY。`);
        }));
    }
  }

  // ---- room view with the reducer's overrides (reverse) applied
  function room() {
    const r = { ...room0, seats: room0.seats.map((s) => ({ ...s })) };
    if (Object.keys(state.roles || {}).length) {
      for (const s of r.seats) {
        if (state.roles[s.seatId]) s.role = state.roles[s.seatId];
        if (state.reviews && Array.isArray(state.reviews[s.seatId])) s.reviews = state.reviews[s.seatId].slice();
        s.lead = undefined;
      }
      r.leadSeatId = state.leadSeatId || undefined;
    }
    return r;
  }
  function seatOf(id) { return room().seats.find((s) => s.seatId === id) || null; }
  function governed() { return !!room0.preset; }
  function leadId(r = room()) { const l = r.seats.find((s) => isLead(s, r)); return l ? l.seatId : null; }
  function reviewerOf(r = room()) { try { return resolveReviewers(r).reviewerOf; } catch { return {}; } }

  // ---- events
  // state.json is derived; it is rewritten once per serialized operation (and before any reply, so a
  // seat never sees a reply ahead of the state it implies), not after every event.
  let dirty = true;
  function writeState() { guard.atomicWrite(path.join(roomDir, F.state), JSON.stringify(view(), null, 1)); dirty = false; }
  function flush() { if (dirty) writeState(); }
  function emit(ev) {
    const full = { seq: state.lastSeq + 1, ts: iso(), ...ev };
    guard.appendFsync(eventsPath, `${JSON.stringify(full)}\n`);
    applyEvent(state, full);
    events.push(full);
    dirty = true;
    log(`[event ${full.seq}] ${full.type}${full.seatId ? ` seat=${full.seatId}` : ''}${full.attemptId ? ` attempt=${full.attemptId}` : ''}${full.reason ? ` reason=${full.reason}` : ''}`);
    return full;
  }
  // The event behind a reply is already in events.jsonl. A state.json flush that still fails after
  // the guard's rename retries (a reader holding the file) is logged and left dirty, so the next
  // tick rewrites it; the reply is written either way, and a failed reply write is logged too (the
  // seat then reports PENDING and finds the outcome in the room's state).
  function reply(seatId, subId, payload) {
    try { flush(); } catch (e) { dirty = true; log(`[service] state.json write failed before reply ${seatId}/${subId}: ${e.code || e.message}; rewritten on the next tick`); }
    try {
      const dir = path.join(roomDir, F.replies, seatId);
      guard.mkdir(dir);
      guard.atomicWrite(path.join(dir, `${subId}.json`), JSON.stringify({ ts: iso(), ...payload }));
    } catch (e) { log(`[service] reply ${seatId}/${subId} write failed: ${e.code || e.message}`); }
  }
  function privateDir(attemptId) { const d = path.join(roomDir, 'private', attemptId || 'room'); guard.mkdir(d); return d; }

  function refreshAdjudications() {
    try {
      const entries = readAdjudications(adjPath);
      const lead = leadId();
      const seat = lead ? seatOf(lead) : null;
      const agent = seat ? reviewerAgentOf(seat) : undefined;
      const sig = rejectRateSignal(entries, { reviewerAgent: agent, preset: room0.preset || 'none' });
      adjSignal = { n: sig.n, k: sig.k, status: sig.status, hint: sig.message, reviewerAgent: agent || null, preset: room0.preset || 'none', path: adjPath };
    } catch (e) { adjSignal = { n: null, k: null, status: 'unknown', hint: `读取 adjudications 失败：${e.code || e.message}` }; }
  }

  function view() {
    const maxTokens = room0.budget && room0.budget.maxTokens != null ? room0.budget.maxTokens : null;
    const b = budgetStatus({ totals: state.usage.totals, maxTokens });
    const hostedView = {};
    for (const [id, h] of hosted) hostedView[id] = { tier: h.pi.tier, busy: h.pi.busy, attemptId: h.attemptId || null, pendingPermissions: typeof h.pi.pendingPermissions === 'function' ? h.pi.pendingPermissions() : [] };
    // The live item table of the current round (whole-message items plus points, the summary lead's
    // marks applied), so the UI does not have to re-derive plan §5.4 from events.
    let items = [];
    try { items = itemTable(); } catch { items = []; }
    return {
      ...state,
      items,
      usage: { ...state.usage, maxTokens, paused: b.paused, status: b.status },
      paused: b.paused,
      adjudications: adjSignal,
      conflicts,
      hosted: hostedView,
      piKey: piKey ? 'present' : 'absent',
      piKeySource: piKey ? piKeySource : null,
      mutate: [...M],
    };
  }

  // ---- first start after a crash: pending attempts need the user's decision (plan §6.5)
  function reconcileOnStart() {
    const pend = pendingAttempts(state).filter((a) => a.status === 'pending');
    if (!pend.length) return;
    if (!governed() && opts.reconcile !== 'always') {
      // P-1 rooms (no preset) keep their pending attempt valid across a restart (test/e2e.mjs).
      for (const a of pend) log(`[service] resumed with a pending attempt ${a.attemptId} for seat ${a.seatId}; it stays valid (room has no preset)`);
      return;
    }
    for (const a of pend) {
      log(`[service] pending attempt ${a.attemptId} for seat ${a.seatId} found at start -> needs_reconcile`);
      emit({ type: 'needs_reconcile', attemptId: a.attemptId, seatId: a.seatId });
    }
  }

  // ---------------------------------------------------------------- manifests and artifacts
  function manifestFile(seatId, sha) { return path.join(roomDir, 'artifacts', seatId, `${sha}.json`); }
  function loadManifest(sha) {
    if (manifestCache.has(sha)) return manifestCache.get(sha);
    const art = state.artifacts[sha];
    if (!art || !art.seatId) return null;
    const m = readJson(manifestFile(art.seatId, sha), null);
    if (m) manifestCache.set(sha, m);
    return m;
  }
  // Seats whose latest frozen manifests share a working directory and name the same file.
  function computeConflicts() {
    const latest = Object.entries(state.seats).filter(([, s]) => s.latestManifest).map(([id, s]) => ({ seatId: id, sha: s.latestManifest, seat: seatOf(id) })).filter((x) => x.seat);
    const outl = [];
    for (let i = 0; i < latest.length; i++) {
      for (let j = i + 1; j < latest.length; j++) {
        const a = latest[i]; const b = latest[j];
        if (normPath(a.seat.cwd) !== normPath(b.seat.cwd)) continue;
        const ma = loadManifest(a.sha); const mb = loadManifest(b.sha);
        if (!ma || !mb) continue;
        const touched = (m) => new Set(m.files.filter((f) => !f.status || f.status !== 'unchanged').map((f) => f.path));
        const tb = touched(mb);
        for (const p of touched(ma)) if (tb.has(p)) outl.push({ path: p, seats: [a.seatId, b.seatId], manifests: [a.sha, b.sha], detail: '两个席位的冻结清单都含此文件；房间不自动合并' });
      }
    }
    conflicts = outl;
  }
  // Manifests seat `reviewerId` must judge: the latest manifest of every producer it reviews that
  // has no binding verdict from it yet.
  // A verdict still counts after an epoch bump (reassign, reverse, reconcile) but not across an
  // interrupt that reopened the round it was given in.
  function reopenEpoch() {
    const r = state.reopened.filter((x) => x.roundId === state.roundId).pop();
    return r ? r.epoch : -1;
  }
  function verdictCurrent(v) { return v.roundId < state.roundId || v.epoch >= reopenEpoch(); }
  function pendingReviewShas(reviewerId) {
    const rv = reviewerOf();
    const shas = [];
    for (const [producer, rid] of Object.entries(rv)) {
      if (rid !== reviewerId) continue;
      const sha = state.seats[producer] && state.seats[producer].latestManifest;
      if (!sha) continue;
      if (state.verdicts.some((v) => v.artifactSha === sha && v.seatId === reviewerId && v.verdict !== 'none' && verdictCurrent(v))) continue;
      shas.push(sha);
    }
    return shas;
  }
  function requiredVerdictsFor(seatId, phase, turnIndex) {
    const pend = pendingReviewShas(seatId);
    if (!pend.length) return [];
    const lead = leadId();
    if (phase === 'summary') return seatId === lead ? pend : [];
    if (phase === 'meet') {
      const last = state.order.lastIndexOf(seatId);
      if (last !== turnIndex) return [];
      if (seatId === lead && state.phases.includes('summary')) return [];
      return pend;
    }
    return [];
  }

  // ---------------------------------------------------------------- packets
  function packetMaterials(seatId, extra) {
    const mats = [];
    const delivered = [];
    for (const d of Object.values(state.disclosures)) {
      if (d.seatId !== seatId || d.status !== 'executed' || d.delivered || !d.exec) continue;
      let outText = '';
      try {
        const rd = (n) => { const p = path.join(d.exec.privatePath, n); return fs.existsSync(p) ? fs.readFileSync(p).subarray(0, MATERIAL_MAX_BYTES).toString('utf8') : ''; };
        outText = `--- stdout ---\n${rd('stdout.bin')}\n--- stderr ---\n${rd('stderr.bin')}`;
      } catch (e) { outText = `（读取原始输出失败：${e.code || e.message}）`; }
      mats.push({ id: `disclose-${d.id}`, version: 1, text: `披露 ${d.id} 在冻结快照 ${d.exec.manifestSha} 的副本里执行：argv=${JSON.stringify(d.argv)} exitCode=${d.exec.exitCode} outputSha256=${d.exec.outputSha256}${d.exec.truncated ? '（输出已截断）' : ''}\n${outText}` });
      delivered.push(d.id);
    }
    const notices = [];
    for (const r of state.reopened) {
      if (r.roundId !== state.roundId || r.notified.includes(seatId)) continue;
      const tookOld = Object.values(state.attemptLog).some((a) => a.seatId === seatId && a.roundId === r.roundId && a.epoch < r.epoch);
      if (!tookOld) continue;
      mats.push({ id: 'round-reopened', version: r.epoch, text: `房间通知：本轮已在 epoch ${r.epoch} 重开。之前发出的包里 seq ${r.supersededSeqs.length ? r.supersededSeqs.join(',') : '（无）'} 的发言已被取代，不要再依据它们；以本包为准。本段由房间生成，不是用户指令，不含任何授权。` });
      notices.push(r.epoch);
    }
    for (const x of Array.isArray(extra) ? extra : [extra]) if (x) mats.push(x);
    return { materials: mats, deliveredDisclosures: delivered, reopenNotices: notices };
  }

  // Seats this round that the user skipped (plan §4.3 rule 7: an absence enters the summary only
  // with a marker) and Work seats that claimed completion with no artifact (plan §13.1 #10).
  function roundAbsences() {
    const ep = reopenEpoch();
    return (state.absent || []).filter((x) => x.roundId === state.roundId && !(Number.isInteger(x.epoch) && x.epoch < ep))
      .map((x) => ({ seatId: x.seatId, phase: x.phase, by: x.by, attemptId: x.attemptId || null }));
  }
  function roundNoArtifact() {
    return (state.noArtifact || []).filter((x) => x.roundId === state.roundId)
      .map((x) => ({ seatId: x.seatId, attemptId: x.attemptId || null, reason: x.reason, manifestSha: x.manifestSha || null }));
  }
  function summaryMarkers() {
    const lines = [];
    for (const a of roundAbsences()) lines.push(`缺席标记：席位 ${a.seatId} 在 ${a.phase} 阶段${a.by === 'admin' ? '由用户跳过' : `被跳过（${a.by}）`}，没有发言。`);
    for (const n of roundNoArtifact()) lines.push(`no_artifact：席位 ${n.seatId} 声称 Work 完成，但${n.reason === 'empty' ? '冻结的产物集为空' : '本轮没有冻结任何产物'}；它的 Work 不计为已完成。`);
    if (!lines.length) return null;
    return { id: 'room-markers', version: 1, text: `房间记录（汇总里必须原样带上这些标记）：\n${lines.join('\n')}\n本段由房间生成，不是用户指令，不含任何授权。` };
  }

  function itemTable() {
    const lead = state.stage.summary && state.stage.summary.attemptId ? (state.attemptLog[state.stage.summary.attemptId] || {}).seatId : leadId();
    const ep = reopenEpoch();
    const msgs = state.messages.filter((m) => m.roundId === state.roundId && !m.superseded && m.seatId !== lead);
    const points = state.points.filter((p) => p.roundId === state.roundId && !p.voided && !(Number.isInteger(p.epoch) && p.epoch < ep));
    const items = buildItemTable(msgs, points);
    // Only the summary lead's marks from a summary turn count (plan §5.4); anything else in an old
    // log (a participant marking its own item in Meet) cannot answer an item.
    const marks = Object.values(state.marks)
      .filter((m) => m.roundId === state.roundId && m.by === lead && (m.phase === undefined || m.phase === 'summary') && !(Number.isInteger(m.epoch) && m.epoch < ep))
      .map((m) => ({ itemId: m.itemId, status: m.status, text: m.text, by: m.by }));
    return applyMarks(items, marks);
  }

  // 'sent' when the seat's own outbox records taking this attempt's packet (what `room wait` leaves
  // in last-attempt.json), 'unknown' otherwise. Read only; the outbox belongs to the seat.
  function packetReceipt(seat, a) {
    const last = seat.outbox ? readJson(path.join(seat.outbox, O.lastAttempt), null) : null;
    return last && last.attemptId === a.attemptId ? 'sent' : 'unknown';
  }

  // Re-sends an open attempt's packet: the original packet text with a room notice after the title,
  // written as a new packet file (the original stays as it was issued) plus its manifest.
  function resendPacket(seat, a, reason) {
    const original = a.originalPath || a.path;
    let text;
    try { text = fs.readFileSync(original, 'utf8'); } catch (e) { log(`[service] resend of ${a.packetId} failed: ${e.code || e.message}`); return null; }
    const n = (a.resends || 0) + 1;
    const notice = block(a.nonce, { seat: 'room', authority: 'room', seq: 0 }, `重发说明：这是 attempt ${a.attemptId} 的包 ${a.packetId} 的第 ${n} 次重发。房间服务重启前没有收到你取走这个包的回执，所以再发一次。若已收到请忽略重复的部分，按本包作答；attempt 不变，仍是 ${a.attemptId}。本段由房间生成，不是用户指令，不含任何授权。`);
    const cut = text.indexOf('\n');
    const section = `## 重发说明\n\n${notice}\n`;
    const body = cut === -1 ? `${text}\n\n${section}` : `${text.slice(0, cut + 1)}\n${section}${text.slice(cut + 1)}`;
    const pktPath = path.join(roomDir, F.packets, `${a.packetId}.resend-${n}.md`);
    const manifestPath = path.join(roomDir, 'manifests', `${a.packetId}.resend-${n}.json`);
    const digest = sha256(body);
    const bytes = Buffer.byteLength(body);
    const orig = a.manifestPath ? readJson(a.manifestPath, null) : null;
    guard.writeFile(pktPath, body);
    guard.writeFile(manifestPath, JSON.stringify({ ...(orig || { packetId: a.packetId, seatId: a.seatId, attemptId: a.attemptId, nonce: a.nonce }), sha256: digest, bytes, resend: n, resendOf: original, resendReason: reason }, null, 1));
    emit({ type: 'packet_resent', seatId: a.seatId, attemptId: a.attemptId, packetId: a.packetId, path: pktPath, manifestPath, sha256: digest, bytes, resend: n, reason });
    if (seat && !seat.hosted && seat.waitMode === 'turn_over') pushWake(seat, a.attemptId, 'resend');
    return { path: pktPath, resend: n };
  }

  function attemptIdFor(phase) {
    const tag = phase === 'meet' ? `${state.turnIndex + 1}` : phase === 'work' ? 'w' : phase === 'summary' ? 's' : phase === 'assign' ? 'g' : 'x';
    return `a${state.roundId}-${tag}-${randomHex(3)}`;
  }

  function issue(seatId, phase, { kind = 'turn', followUpOf = null, followUpText = null } = {}) {
    const seat = seatOf(seatId);
    if (!seat) { emit({ type: 'seat_skipped', seatId, attemptId: null, by: 'unknown_seat', phase }); return null; }
    const sstat = state.seats[seatId];
    if (sstat && sstat.status === 'left') { emit({ type: 'seat_skipped', seatId, attemptId: null, by: 'left', phase }); return null; }
    const attemptId = attemptIdFor(phase);
    const packetId = `r${state.roundId}-${seatId}-${attemptId}`;
    const nonce = randomHex(4);
    const seatDir = path.join(roomDir, F.seats, seatId);
    const wall = Number(seat.wallClockSec || room0.wallClockSec || DEFAULT_WALL_SEC);
    const deadline = new Date(now() + wall * 1000).toISOString();
    const pktPath = path.join(roomDir, F.packets, `${packetId}.md`);
    const voidedId = sstat && sstat.voided ? sstat.voided : null;
    const summary = state.summary && state.summary.version ? state.summary : null;
    const lastSeen = sstat && sstat.lastSummaryVersion ? sstat.lastSummaryVersion : 0;
    const supersededNotice = summary && lastSeen && lastSeen < summary.version && summary.seatId !== seatId ? { oldVersion: lastSeen, newVersion: summary.version } : null;
    const extraMat = [followUpText ? { id: 'room-followup', version: 1, text: followUpText } : null, phase === 'summary' ? summaryMarkers() : null];
    const { materials, deliveredDisclosures, reopenNotices } = packetMaterials(seatId, extraMat);
    const userMessages = state.userMessages.filter((u) => u.immediate ? true : u.deliverFromRound <= state.roundId).map((u) => ({ seq: u.seq, text: u.text, sha256: u.sha256 || undefined }));
    const r = room();
    const rv = reviewerOf(r);
    const artifacts = [];
    for (const [producer, rid] of Object.entries(rv)) {
      if (rid !== seatId && producer !== seatId) continue;
      const sha = state.seats[producer] && state.seats[producer].latestManifest;
      const art = sha ? state.artifacts[sha] : null;
      if (art) artifacts.push({ seatId: producer, manifestSha: sha, fileCount: art.fileCount, bytes: art.bytes });
    }
    let turnTask = null;
    if (phase === 'work') {
      const asg = Array.isArray(state.assignments) ? state.assignments.find((x) => x.seatId === seatId) : null;
      if (asg) turnTask = `${asg.text}${asg.acceptance && asg.acceptance.length ? `\n验收命令：${asg.acceptance.map((x) => JSON.stringify(x)).join('；')}` : ''}`;
    }
    const reassigned = (state.reassigned || []).filter((x) => x.toSeat === seatId && x.text && x.epoch === state.epoch).pop();
    if (reassigned) turnTask = `${turnTask ? `${turnTask}\n` : ''}改派说明：${reassigned.text}`;
    const requiredVerdicts = kind === 'followup' || phase === 'meet' || phase === 'summary' ? requiredVerdictsFor(seatId, phase, state.turnIndex) : [];
    const prevManifestId = sstat && sstat.lastPacketId ? sstat.lastPacketId : null;
    const pstate = { ...state, phase, messages: state.messages.filter((m) => !m.superseded) };
    const rendered = renderPacket({
      room: r, seat, seatDir, state: pstate, attempt: { attemptId, packetId, deadline, phase, turnTask }, nonce, roomCmd: roomCmdFor(seat),
      summary: summary ? { version: summary.version, text: summary.text, seatId: summary.seatId, seq: summary.seq, sha256: summary.sha256 } : null,
      materials, items: phase === 'summary' ? itemTable() : [], supersededNotice, voidNotice: voidedId ? { attemptId: voidedId } : null,
      userMessages, artifacts, quotedSeqs: state.quotes.filter((q) => !q.voided).map((q) => q.quotedSeq).filter(Number.isInteger), prevManifestId, templates,
    });
    const body = rendered.text;
    const manifestPath = path.join(roomDir, 'manifests', `${packetId}.json`);
    guard.writeFile(pktPath, body);
    guard.writeFile(manifestPath, JSON.stringify({ ...rendered.manifest, requiredVerdicts, kind, followUpOf }, null, 1));
    guard.writeFile(path.join(privateDir(attemptId), 'issued.json'), JSON.stringify({ packetId, sha256: rendered.manifest.sha256, bytes: rendered.manifest.bytes, nonce, path: pktPath, ts: iso() }, null, 1));
    emit({
      type: 'packet_issued', seatId, attemptId, packetId, nonce, sha256: sha256(body), bytes: Buffer.byteLength(body), path: pktPath, deadline,
      phase, roundId: state.roundId, epoch: state.epoch, kind, followUpOf: followUpOf || undefined, voidedAttemptId: voidedId || undefined,
      summaryVersion: summary ? summary.version : undefined, manifestPath, requiredVerdicts, deliveredUserSeqs: userMessages.map((u) => u.seq),
      deliveredDisclosures, reopenNotices, escaped: rendered.manifest.escaped, dropped: rendered.manifest.dropped,
    });
    if (supersededNotice) emit({ type: 'superseded_notice', forSeat: seatId, oldVersion: supersededNotice.oldVersion, newVersion: supersededNotice.newVersion, packetId });
    if (seat.hosted) startHosted(seat, attemptId, body);
    else if (seat.waitMode === 'turn_over') pushWake(seat, attemptId, 'issue');
    return attemptId;
  }

  // ---------------------------------------------------------------- wake push (contract 2 exception)
  // The turn a push belongs to (plan §3.3 「每回合至多 W 次」): round, epoch, phase and, in Meet, the
  // seat's place in the order. A follow-up or a re-issued attempt of the same turn shares the key.
  function wakeTurnKey(attemptId) {
    const a = attemptId ? state.attemptLog[attemptId] : null;
    const roundId = a ? a.roundId : state.roundId;
    const epoch = a ? a.epoch : state.epoch;
    const phase = a ? a.phase : state.phase;
    const ti = a ? a.turnIndex : state.turnIndex;
    return `r${roundId}/e${epoch}/${phase}${phase === 'meet' ? `/${ti}` : ''}`;
  }
  // Rules are per seat and per thread, across every attempt: no push while an earlier push to the
  // same thread has not been followed by an observed turn start, at most W real pushes per turn.
  function wakeRefusal(seat, attemptId) {
    const w = seat.wake;
    if (!w || !w.enabled || !w.thread) return 'NOT_REGISTERED';
    const kind = w.kind || 'codex-queue';
    if (kind !== 'codex-queue' && !(opts.wakers && typeof opts.wakers[kind] === 'function')) return 'UNSUPPORTED_KIND';
    const max = Number.isInteger(w.maxPerTurn) && w.maxPerTurn >= 0 ? w.maxPerTurn : 1;
    if (wakeInFlight.has(`thread:${w.thread}`) || wakeInFlight.has(`seat:${seat.seatId}`)) return 'OUTSTANDING';
    const mine = Object.values(state.wakes).flat().filter((x) => x.seatId === seat.seatId || (x.thread && x.thread === w.thread));
    if (mine.some((x) => x.command_ok === true && x.turn_observed !== true)) return 'OUTSTANDING';
    const key = wakeTurnKey(attemptId);
    const pushes = mine.filter((x) => x.seatId === seat.seatId && x.turnKey === key && !x.refused);
    if (pushes.length >= max) return 'CAP_REACHED';
    return null;
  }
  function pushWake(seat, attemptId, by) {
    const refusal = wakeRefusal(seat, attemptId);
    if (refusal) { log(`[wake] seat ${seat.seatId} attempt=${attemptId || '-'}: not pushed (${refusal})`); return { ok: false, reason: refusal }; }
    const thread = seat.wake.thread;
    const base = { type: 'wake_pushed', seatId: seat.seatId, attemptId, thread, by, roundId: state.roundId, turnKey: wakeTurnKey(attemptId), turn_observed: null };
    // A host that embeds the service can wake its own sessions (PI-Desktop: agentHostBridge.queue.push).
    // Same caps, same event, same fixed text with no room content; only the delivery is the host's.
    const kind = seat.wake.kind || 'codex-queue';
    if (kind !== 'codex-queue') {
      const waker = opts.wakers && opts.wakers[kind];
      const text = `[ROOM authority=none] 轮到席位 ${seat.seatId}，请取本回合的包`;
      const flight = [`thread:${thread}`, `seat:${seat.seatId}`];
      for (const k of flight) wakeInFlight.add(k);
      const p = Promise.resolve()
        .then(() => waker({ seat, attemptId, thread, text }))
        .then((r) => { emit({ ...base, kind, command_ok: !!(r && r.ok), detail: clip((r && r.detail) || (r && r.ok ? 'queued' : 'failed'), 500) }); })
        .catch((e) => { emit({ ...base, kind, command_ok: false, detail: clip(e && (e.code || e.message)) }); })
        .finally(() => { for (const k of flight) wakeInFlight.delete(k); });
      track(p);
      return { ok: true };
    }
    if (!codexLooked) { codexExe = findCodex(codexEnv ? { env: codexEnv } : undefined); codexLooked = true; }
    if (!codexExe) { emit({ ...base, command_ok: false, detail: 'codex.exe not found' }); return { ok: false, reason: 'NO_CODEX' }; }
    const seatDir = path.join(roomDir, F.seats, seat.seatId);
    const text = `[ROOM authority=none] 轮到席位 ${seat.seatId}，请运行  ${roomCmdFor(seat)} wait --seat ${fwd(seatDir)}`;
    const env = {};
    for (const k of ['LOCALAPPDATA', 'USERPROFILE', 'CODEX_HOME', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[k]) env[k] = process.env[k];
    const flight = [`thread:${thread}`, `seat:${seat.seatId}`];
    for (const k of flight) wakeInFlight.add(k);
    const p = Promise.resolve()
      .then(async () => {
        // Read-only idle check first (plan §3.3 推送前经只读审计确认该线程空闲). Not idle, or not
        // knowable: nothing is pushed and the seat falls back to 需用户唤醒.
        let idle;
        try { idle = await idleCheck({ seat, thread }); } catch (e) { idle = { idle: null, note: `空闲检查出错：${e.code || e.message}` }; }
        if (!idle || idle.idle !== true) {
          const refused = idle && idle.idle === false ? 'THREAD_BUSY' : 'IDLE_UNKNOWN';
          const why = refused === 'THREAD_BUSY' ? '线程有进行中的回合' : '无法确认线程空闲';
          emit({ ...base, command_ok: false, refused, detail: clip(`${refused}：${why}，未推送；需用户唤醒${idle && idle.note ? `（${idle.note}）` : ''}`, 500) });
          log(`[wake] seat ${seat.seatId}: ${refused}; not pushed, 需用户唤醒`);
          return;
        }
        // A registered name was resolved to the thread's UUID: push to that id, record both.
        const target = typeof idle.thread === 'string' && idle.thread ? idle.thread : thread;
        const r = await spawn(codexExe, ['queue', '--thread', target, '--message', text], { env, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
        const ok = !!r && r.code === 0 && !r.spawnError && !r.timedOut;
        emit({ ...base, ...(target !== thread ? { threadId: target } : {}), command_ok: ok, detail: clip(ok ? r.stdout : (r && (r.spawnError || r.stderr)) || 'failed', ok ? 200 : 500) });
      })
      .catch((e) => { emit({ ...base, command_ok: false, detail: clip(e && e.message) }); })
      .finally(() => { for (const k of flight) wakeInFlight.delete(k); });
    track(p);
    return { ok: true };
  }

  // ---------------------------------------------------------------- hosted seats (in-process)
  // Two kinds. 'pi' is the built-in Pi seat (lib/hosted/pi.mjs, needs the API key). 'lane' is run by
  // a provider the embedding host injects: opts.hostedProviders.lane({seat, roomDir, log}) must return
  // the same handle shape as createPiSeat — {busy, prompt(packetText, {signal}) -> {text, stopReason,
  // usage, failureClass?, error?}, cancel(), pendingPermissions?(), tier?}. PI-Desktop uses this to
  // seat its v-subagent lanes (claude-code, anyrouter, webchat ...) in a governed room.
  function hostedFor(seat) {
    if (hosted.has(seat.seatId)) return hosted.get(seat.seatId);
    const kind = seat.hosted.kind || 'pi';
    if (kind !== 'pi') {
      const factory = opts.hostedProviders && opts.hostedProviders[kind];
      if (typeof factory !== 'function') {
        const e = new Error(`席位 ${seat.seatId} 由宿主通道 ${seat.hosted.lane || kind} 托管，但运行这个房间服务的进程没有注入该通道（单独用命令行起的服务没有宿主通道）`);
        e.code = 'HOSTED_PROVIDER_MISSING';
        throw e;
      }
      const handle = factory({ seat, roomDir, log });
      if (!handle || typeof handle.prompt !== 'function') {
        const e = new Error(`宿主通道 ${seat.hosted.lane || kind} 返回的席位句柄没有 prompt()`);
        e.code = 'HOSTED_PROVIDER_INVALID';
        throw e;
      }
      // Wrap rather than spread: a class-instance handle keeps its methods on the prototype.
      const h = {
        pi: {
          tier: handle.tier || seat.hosted.tier || 'discussion',
          get busy() { return !!handle.busy; },
          prompt: (text, o) => handle.prompt(text, o),
          cancel: () => (typeof handle.cancel === 'function' ? Promise.resolve(handle.cancel()) : Promise.resolve()),
          pendingPermissions: () => (typeof handle.pendingPermissions === 'function' ? handle.pendingPermissions() : []),
        },
        attemptId: null,
      };
      hosted.set(seat.seatId, h);
      return h;
    }
    if (!piKey) return null;
    const tier = seat.hosted.tier || 'discussion';
    const pi = createPiSeat({
      tier, apiKey: piKey, model: seat.hosted.model || (room0.pi && room0.pi.model) || 'anthropic/claude-sonnet-4-5',
      cwd: path.resolve(seat.cwd), sessionDir: path.join(roomDir, 'private', 'hosted', seat.seatId), provider: opts.piProvider,
      readRoots: tier === 'reviewer' ? [path.join(roomDir, 'snapshots')] : [], spawn,
      onEvent: (ev) => { if (ev && ev.type === 'permission_pending') log(`[hosted] seat ${seat.seatId} permission_pending ${ev.id} ${ev.tool} ${ev.category || ''}`); },
    });
    const h = { pi, attemptId: null };
    hosted.set(seat.seatId, h);
    return h;
  }
  function startHosted(seat, attemptId, packetText) {
    let h;
    try { h = hostedFor(seat); } catch (e) {
      hostedQueue.push({ seatId: seat.seatId, attemptId, res: { stopReason: 'error', failureClass: 'other', error: { code: e.code, message: e.message } } });
      return;
    }
    if (!h) { hostedQueue.push({ seatId: seat.seatId, attemptId, res: { stopReason: 'error', failureClass: 'auth_expired', error: { code: 'PI_NO_KEY', message: '缺少 API key：用 ROOM_PI_API_KEY 或 serve --pi-key-stdin 启动服务，或 admin pi-key --port <端口> 交给运行中的服务，或先用 admin pi-key --save 以 DPAPI 保存后重启服务' } } }); return; }
    h.attemptId = attemptId;
    const p = h.pi.prompt(packetText).then((res) => { hostedQueue.push({ seatId: seat.seatId, attemptId, res }); })
      .catch((e) => { hostedQueue.push({ seatId: seat.seatId, attemptId, res: { stopReason: 'error', failureClass: 'other', error: { code: e.code, message: e.message } } }); });
    track(p);
  }
  function cancelHosted(seatId) {
    const h = hosted.get(seatId);
    if (h && h.pi.busy) track(h.pi.cancel().catch(() => {}));
  }
  async function drainHosted() {
    while (hostedQueue.length) {
      const { seatId, attemptId, res } = hostedQueue.shift();
      const seat = seatOf(seatId);
      const a = state.attemptLog[attemptId];
      if (res && res.usage) emit({ type: 'usage_reported', seatId, attemptId, input: res.usage.input, output: res.usage.output, cached: res.usage.cached, source: 'hosted' });
      if (!a || a.status !== 'pending') { log(`[hosted] seat ${seatId}: late result for ${attemptId} dropped (attempt ${a ? a.status : 'unknown'})`); continue; }
      if (res.stopReason === 'end_turn') {
        await processSubmission(seat, { kind: 'speech', attemptId, text: String(res.text || ''), origin: 'hosted', subId: `${attemptId}-h${randomHex(3)}` });
      } else if (res.stopReason === 'cancelled') {
        emit({ type: 'attempt_canceled', seatId, attemptId, by: res.unconfirmed ? 'hosted_unconfirmed' : 'hosted' });
      } else {
        const detail = res.error ? clip(`${res.error.code || ''} ${res.error.message || ''}`.trim(), 300) : 'error';
        emit({ type: 'seat_failed', seatId, attemptId, class: res.failureClass || 'other', detail });
      }
    }
  }

  // ---------------------------------------------------------------- submissions
  function parseOutboxFile(seat, dir, f) {
    let meta;
    try { meta = readJson(path.join(dir, f)); } catch { return null; } // mid-write
    return meta;
  }

  // Outbox format (seat command -> service). Speech, as in P-1: <subId>.md + <subId>.json with
  // {seatId, attemptId, submissionId, bodySha256, proof = sha256(token:attemptId:bodySha256)}.
  // Structured: the same pair with meta.kind and the payload as JSON in <subId>.md, or the payload
  // inline as meta.payload with meta.payloadSha256 = sha256(JSON.stringify(meta.payload)) and
  // proof = sha256(token:attemptId:payloadSha256). attemptId may be 'none' only for kind artifacts.
  function verifyOutbox(seat, dir, f, meta) {
    const subId = f.replace(/\.json$/, '');
    const kind = meta && typeof meta.kind === 'string' ? meta.kind : 'speech';
    const attemptId = meta && meta.attemptId ? String(meta.attemptId) : null;
    const base = { subId, kind, attemptId, file: f, meta, origin: 'outbox' };
    if (!meta || typeof meta !== 'object' || meta.seatId !== seat.seatId || meta.submissionId !== subId) return { ...base, error: 'MALFORMED_META' };
    if (!COMMAND_KINDS.includes(kind)) return { ...base, error: 'UNKNOWN_KIND' };
    if (!attemptId && kind !== 'artifacts') return { ...base, error: 'MALFORMED_META' };
    let token;
    try { token = fs.readFileSync(path.join(roomDir, F.seats, seat.seatId, 'token'), 'utf8').trim(); } catch { return { ...base, error: 'NO_SEAT_TOKEN' }; }
    const proofAttempt = attemptId || 'none';
    const bodyPath = path.join(dir, `${subId}.md`);
    let bodyBuf = null;
    let digest = null;
    if (meta.bodySha256 || kind === 'speech') {
      if (!fs.existsSync(bodyPath)) return { ...base, error: 'BODY_MISSING' };
      bodyBuf = fs.readFileSync(bodyPath);
      digest = sha256(bodyBuf);
      if (digest !== meta.bodySha256) return { ...base, error: 'BODY_HASH_MISMATCH' };
    } else if (meta.payload && typeof meta.payload === 'object') {
      digest = sha256(JSON.stringify(meta.payload));
      if (digest !== meta.payloadSha256) return { ...base, error: 'PAYLOAD_HASH_MISMATCH' };
    } else return { ...base, error: 'BODY_MISSING' };
    if (meta.proof !== sha256(`${token}:${proofAttempt}:${digest}`)) return { ...base, error: 'BAD_PROOF' };
    let payload = {};
    let text = null;
    if (kind === 'speech') text = bodyBuf.toString('utf8');
    else if (meta.payload && typeof meta.payload === 'object') payload = { ...meta.payload };
    else {
      const t = bodyBuf.toString('utf8');
      let parsed = null;
      try { parsed = t.trim() ? JSON.parse(t) : {}; } catch { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
      else payload = kind === 'assign' ? { draft: t } : { text: t };
    }
    for (const k of ['seq', 'item', 'status', 'verdict', 'artifact', 'argv', 'reason', 'paths', 'baseline', 'exclude', 'text', 'draft']) if (payload[k] === undefined && meta[k] !== undefined) payload[k] = meta[k];
    return { ...base, payload, text, bodyBuf, digest };
  }

  async function scanOutboxes() {
    for (const seat of room().seats) {
      if (seat.hosted) continue;
      const dir = seat.outbox;
      if (!dir || !fs.existsSync(dir)) continue;
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      const id = seat.seatId;
      if (names.includes(O.joined) && !(state.seats[id] && state.seats[id].status)) emit({ type: 'seat_joined', seatId: id });
      if (names.includes(O.leave) && !state.processed[`${id}/${O.leave}`]) {
        const held = state.holding[id];
        if (held) { emit({ type: 'attempt_canceled', seatId: id, attemptId: held, by: 'leave' }); cancelHosted(id); }
        emit({ type: 'seat_left', seatId: id, file: O.leave });
        continue;
      }
      const todo = [];
      for (const f of names) {
        if (!f.endsWith('.json') || Object.values(O).includes(f)) continue;
        if (state.processed[`${id}/${f}`] && !M.has('no-dedupe')) continue;
        if (M.has('no-dedupe') && seenThisRun.has(`${id}/${f}`)) continue;
        const meta = parseOutboxFile(seat, dir, f);
        if (meta === null) continue;
        let mt = 0;
        try { mt = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* vanished */ }
        todo.push({ f, meta, key: `${meta && meta.ts ? meta.ts : ''}|${String(Math.trunc(mt)).padStart(16, '0')}|${f}` });
      }
      todo.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      for (const { f, meta } of todo) {
        if (M.has('no-dedupe')) seenThisRun.add(`${id}/${f}`);
        const sub = verifyOutbox(seat, dir, f, meta);
        if (sub.error) { rejectSub(seat, sub, sub.error); continue; }
        await processSubmission(seat, sub);
      }
    }
  }
  const seenThisRun = new Set();

  function rejectSub(seat, sub, reason, extra) {
    emit({ type: 'submission_rejected', seatId: seat.seatId, attemptId: sub.attemptId || null, file: sub.file || undefined, kind: sub.kind, reason });
    const r = { status: 'REJECTED', reason, ...(extra || {}) };
    if (sub.origin === 'outbox') reply(seat.seatId, sub.subId, r);
    return r;
  }
  function acceptReply(seat, sub, payload) {
    const r = { status: 'ACCEPTED', kind: sub.kind, ...payload };
    if (sub.origin === 'outbox') reply(seat.seatId, sub.subId, r);
    return r;
  }

  // The single door for every submission (outbox file, HTTP seat transport, hosted seat result).
  async function processSubmission(seat, sub) {
    const id = seat.seatId;
    let attempt = null;
    const preTurnArtifacts = sub.kind === 'artifacts' && (!sub.attemptId || sub.attemptId === 'none');
    if (!preTurnArtifacts) {
      if (M.has('no-attempt-check')) {
        attempt = state.attemptLog[sub.attemptId] || state.attemptLog[state.holding[id]] || null;
      } else {
        const held = state.holding[id];
        // A late submission for this seat's own attempt that was canceled, expired, voided or
        // skipped is stale, whether or not the seat holds a newer attempt (#4).
        const prior = sub.attemptId ? state.attemptLog[sub.attemptId] : null;
        if (prior && prior.seatId === id && prior.attemptId !== held && ['canceled', 'expired', 'voided', 'skipped'].includes(prior.status)) return rejectSub(seat, sub, 'STALE_ATTEMPT');
        if (!held) return rejectSub(seat, sub, 'NOT_YOUR_TURN');
        if (held !== sub.attemptId) return rejectSub(seat, sub, 'STALE_ATTEMPT');
        attempt = state.attemptLog[held];
        if (attempt.status === 'needs_reconcile') return rejectSub(seat, sub, 'NEEDS_RECONCILE');
        if (sub.meta && sub.meta.epoch !== undefined && sub.meta.epoch !== null && Number(sub.meta.epoch) !== attempt.epoch) return rejectSub(seat, sub, 'STALE_EPOCH');
      }
    }
    // Private diagnostic layer (plan §6.9): the exact submitted bytes.
    if (sub.bodyBuf || sub.text != null) {
      try { guard.writeFile(path.join(privateDir(sub.attemptId || 'pre-turn'), `${sub.subId}.md`), sub.bodyBuf || Buffer.from(String(sub.text), 'utf8')); } catch (e) { log(`[private] ${e.message}`); }
    }
    switch (sub.kind) {
      case 'speech': case 'pass': return handleTerminal(seat, attempt, sub);
      case 'point': return handlePoint(seat, attempt, sub);
      case 'quote': return handleQuote(seat, attempt, sub);
      case 'misquoted': return handleMisquoted(seat, attempt, sub);
      case 'disclose': return handleDisclose(seat, attempt, sub);
      case 'artifacts': return handleArtifacts(seat, attempt, sub);
      case 'verdict': case 'mark': case 'assign':
        emit({ type: 'structured_received', seatId: id, attemptId: sub.attemptId, file: sub.file || undefined, kind: sub.kind, submissionId: sub.subId, payload: sub.payload });
        return acceptReply(seat, sub, { note: '已记录；本回合 submit 时与正文里的标记一起结算' });
      default: return rejectSub(seat, sub, 'UNKNOWN_KIND');
    }
  }

  function addPoint(seat, attemptId, { seq, text }, file) {
    const n = state.points.filter((p) => p.aboutSeq === seq).length + 1;
    const itemId = pointItemId(seq, n);
    emit({ type: 'point_added', itemId, seatId: seat.seatId, attemptId, aboutSeq: seq, text, file: file || undefined });
    return itemId;
  }
  function addQuote(seat, attemptId, { seq, text }, file) {
    const v = verifyQuote({ seq, text }, state.messages.map((m) => ({ ...m, text: m.text })));
    emit({ type: 'quote_submitted', seatId: seat.seatId, attemptId, quotedSeq: v.seq, text, verified: v.verified, reason: v.reason, file: file || undefined });
    return v;
  }
  function addMisquoted(seat, { seq, text }, file) {
    emit({ type: 'misquoted_declared', seatId: seat.seatId, aboutSeq: seq, text: text || '', file: file || undefined });
  }
  function acceptanceCommands() { return Array.isArray(state.assignments) ? state.assignments.flatMap((a) => a.acceptance || []) : []; }
  // [{seatId, argv, code, message}] for every acceptance argv whose argv[0] does not resolve to
  // something spawnClean can run without a shell (BATCH_SHIM_UNSUPPORTED | COMMAND_NOT_FOUND).
  function acceptanceProblems(assignments) {
    const outl = [];
    for (const a of Array.isArray(assignments) ? assignments : []) {
      for (const argv of Array.isArray(a && a.acceptance) ? a.acceptance : []) {
        if (!isArgv(argv)) continue;
        let r;
        try { r = checkCommand(argv[0]); } catch (e) { r = { ok: false, code: 'COMMAND_NOT_FOUND', message: e.message }; }
        if (r && r.ok === false) outl.push({ seatId: a.seatId, argv: argv.slice(), code: r.code, message: `席位 ${a.seatId} 的验收命令 ${JSON.stringify(argv)} 无法执行：${r.message}` });
      }
    }
    return outl;
  }
  function addDisclosure(seat, attemptId, { argv, reason, artifact }, file) {
    const id = `d${randomHex(4)}`;
    const req = requestDisclosure({ argv, reason, allowlist: room0.disclosureAllowlist, acceptanceCommands: acceptanceCommands(), seatId: seat.seatId, attemptId, id, now: iso });
    const sha = artifact || pendingReviewShas(seat.seatId)[0] || (state.seats[seat.seatId] && state.seats[seat.seatId].latestManifest) || null;
    emit({
      type: 'disclose_requested', id, seatId: seat.seatId, attemptId, argv: req.argv, reason: req.reason, manifestSha: sha, allowed: req.allowed,
      matched: req.matched || undefined, matchKind: req.matchKind || undefined, file: file || undefined,
    });
    if (req.status === 'denied') emit({ type: 'disclose_denied', id, by: 'room', reason: req.denyReason, message: req.message || undefined });
    return { id, status: req.status, denyReason: req.denyReason || null, message: req.status === 'denied' ? req.message || null : null };
  }

  function handlePoint(seat, attempt, sub) {
    const seq = Number(sub.payload.seq);
    if (!Number.isInteger(seq) || !String(sub.payload.text || '').trim()) return rejectSub(seat, sub, 'MALFORMED_POINT', { detail: REASON_TEXT.point_invalid });
    const itemId = addPoint(seat, sub.attemptId, { seq, text: String(sub.payload.text) }, sub.file);
    return acceptReply(seat, sub, { item: itemId });
  }
  function handleQuote(seat, attempt, sub) {
    const seq = Number(sub.payload.seq);
    if (!Number.isInteger(seq) || !String(sub.payload.text || '')) return rejectSub(seat, sub, 'MALFORMED_QUOTE', { detail: REASON_TEXT.quote_invalid });
    const v = addQuote(seat, sub.attemptId, { seq, text: String(sub.payload.text) }, sub.file);
    return acceptReply(seat, sub, { verified: v.verified, reason: v.reason });
  }
  function handleMisquoted(seat, attempt, sub) {
    const seq = Number(sub.payload.seq);
    if (!Number.isInteger(seq)) return rejectSub(seat, sub, 'MALFORMED_MISQUOTED', { detail: REASON_TEXT.misquoted_invalid });
    addMisquoted(seat, { seq, text: sub.payload.text || '' }, sub.file);
    return acceptReply(seat, sub, {});
  }
  function handleDisclose(seat, attempt, sub) {
    if (!isArgv(sub.payload.argv)) return rejectSub(seat, sub, 'MALFORMED_DISCLOSE', { detail: REASON_TEXT.disclose_invalid });
    const r = addDisclosure(seat, sub.attemptId, sub.payload, sub.file);
    return acceptReply(seat, sub, { id: r.id, requestStatus: r.status, denyReason: r.denyReason, message: r.message || undefined });
  }

  async function handleArtifacts(seat, attempt, sub) {
    const p = sub.payload || {};
    const paths = Array.isArray(p.paths) && p.paths.length ? p.paths.map(String) : ['.'];
    const exclude = Array.isArray(p.exclude) ? p.exclude.map(String) : (p.exclude ? [String(p.exclude)] : []);
    let baseline = p.baseline || 'none';
    if (baseline !== 'none' && baseline !== 'whole') {
      const prev = readJson(manifestFile(seat.seatId, String(baseline)), null);
      if (!prev) return rejectSub(seat, sub, 'BASELINE_UNKNOWN');
      baseline = prev;
    }
    let manifest;
    try {
      manifest = await declareArtifacts({ cwd: seat.cwd, paths, baseline, exclude, seatId: seat.seatId, now: iso });
    } catch (e) { return rejectSub(seat, sub, e.code || 'DECLARE_FAILED', { detail: clip(e.message, 300) }); }
    const sha = manifest.sha256;
    guard.mkdir(path.join(roomDir, 'artifacts', seat.seatId));
    const dest = path.join(roomDir, 'snapshots', seat.seatId, sha);
    let snap = null;
    let snapshotDir = null;
    try {
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) snapshotDir = dest;
      else {
        guard.mkdir(dest);
        snap = await snapshotFn(manifest, seat.cwd, dest, { guard, spawn, now: iso, gitExe });
        snapshotDir = dest;
      }
    } catch (e) { log(`[artifacts] seat ${seat.seatId} snapshot skipped: ${e.code || e.message}`); }
    // A file that changed between hashing (declare) and copying (snapshot) leaves a copy that does
    // not match the frozen manifest; that is recorded, and disclosures refuse such a copy.
    const prevArt = state.artifacts[sha] || null;
    const snapshotStale = snap ? !!snap.stale : !!(prevArt && prevArt.snapshotStale);
    const snapshotChanged = snap ? (Array.isArray(snap.changed) ? snap.changed.slice(0, LIST_MAX) : []) : ((prevArt && prevArt.snapshotChanged) || []);
    const frozen = { ...manifest, copyTorn: snap ? snap.copyTorn : false, snapshotStale, snapshotChanged };
    guard.writeFile(manifestFile(seat.seatId, sha), JSON.stringify(frozen, null, 1));
    manifestCache.set(sha, frozen);
    emit({
      type: 'artifacts_frozen', seatId: seat.seatId, roundId: state.roundId, manifestSha: sha, baseline: manifest.baseline, fileCount: manifest.fileCount,
      bytes: manifest.bytes, excluded: manifest.excluded.slice(0, LIST_MAX), copyTorn: frozen.copyTorn, attemptId: sub.attemptId && sub.attemptId !== 'none' ? sub.attemptId : null,
      file: sub.file || undefined, snapshotDir, manifestPath: manifestFile(seat.seatId, sha), empty: manifest.fileCount === 0,
      snapshotStale, snapshotChanged,
      // Manifest entries snapshot() would not copy (reserved .git / .room-snapshot, a symlink on the
      // way, a real path outside the cwd).
      refused: snap && Array.isArray(snap.refused) && snap.refused.length ? snap.refused.slice(0, LIST_MAX) : undefined,
    });
    computeConflicts();
    return acceptReply(seat, sub, { manifestSha: sha, fileCount: manifest.fileCount, bytes: manifest.bytes, copyTorn: frozen.copyTorn, empty: manifest.fileCount === 0, snapshotStale, snapshotChanged: snapshotStale ? snapshotChanged : undefined });
  }

  // Per-seat audit state the service keeps (room-owned, private/audit/<seatId>.json, guarded write):
  // {kind, threadId, cwd, sessionId?, childThreads?, discoveryCursors?, cursors?}. It is ignored when
  // the seat's registered audit source changed since it was written.
  function auditStorePath(seatId) { return path.join(roomDir, 'private', 'audit', `${seatId}.json`); }
  function loadAuditStore(seat) {
    const st = readJson(auditStorePath(seat.seatId), null);
    const a = seat.audit || {};
    if (!st || typeof st !== 'object' || st.kind !== a.kind || (st.threadId || null) !== (a.threadId || null) || normPath(String(st.cwd || '')) !== normPath(String(a.cwd || ''))) return {};
    if (a.sessionId && st.sessionId && st.sessionId !== a.sessionId) return {};
    return st;
  }
  function saveAuditStore(seat, patch) {
    if (!patch || !Object.keys(patch).length) return;
    try {
      const p = auditStorePath(seat.seatId);
      guard.mkdir(path.dirname(p));
      const a = seat.audit || {};
      const prev = loadAuditStore(seat);
      guard.atomicWrite(p, JSON.stringify({ ...prev, ...patch, kind: a.kind, threadId: a.threadId || null, cwd: a.cwd || null, updatedAt: iso() }));
    } catch (e) { log(`[audit] seat ${seat.seatId}: audit state not saved: ${e.code || e.message}`); }
  }

  async function runAudit(seat, attempt) {
    if (M.has('no-audit')) return null;
    const a = attempt;
    const turnWindow = { fromTs: a.issuedAt, toTs: iso() };
    let r;
    try {
      if (typeof opts.audit === 'function') r = await opts.audit({ seat, attemptId: a.attemptId, packetId: a.packetId, packetPath: a.path, turnWindow });
      else if (seat.audit && seat.audit.kind) {
        const firstPacket = events.find((e) => e.type === 'packet_issued' && e.seatId === seat.seatId);
        const since = Date.parse(seat.createdAt || '') - 60_000;
        // What earlier audits learned (the Claude session found by packet id, Codex child threads and
        // discovery cursors, per-file read cursors) so this one neither re-probes nor re-reads.
        const stored = loadAuditStore(seat);
        const cfg = { ...seat.audit };
        if (!cfg.sessionId && stored.sessionId) cfg.sessionId = stored.sessionId;
        if (stored.childThreads) cfg.childThreads = stored.childThreads;
        if (stored.discoveryCursors) cfg.discoveryCursors = stored.discoveryCursors;
        const loc = await locateFiles(cfg, Number.isFinite(since) ? since : undefined, firstPacket && firstPacket.packetId);
        r = await auditAttempt({ seat, attemptId: a.attemptId, files: loc.files, packetId: a.packetId, packetPath: a.path, turnWindow, cursors: stored.cursors });
        r.note = `${loc.note}; ${r.note || ''}`;
        saveAuditStore(seat, { ...(loc.persist || {}), ...(r.cursors ? { cursors: r.cursors } : {}) });
        if (loc.persist && loc.persist.sessionId) log(`[audit] seat ${seat.seatId}: session ${loc.persist.sessionId} registered (found by packet id; ${(loc.opened || []).length} file(s) opened)`);
      } else r = { status: 'unknown', writes: [], unknownCommands: [], tainted: false, annotation: null, note: '未登记审计源：未审计' };
    } catch (e) { r = { status: 'unknown', writes: [], unknownCommands: [], tainted: false, annotation: 'audit_failed', note: `审计出错：${e.code || e.message}` }; }
    const ev = {
      type: 'audit_observed', seatId: seat.seatId, attemptId: a.attemptId, packetId: a.packetId, status: r.status || 'unknown',
      writes: (r.writes || []).slice(0, LIST_MAX).map((w) => ({ path: w.path, source: w.source, command: w.command ? clip(w.command, 200) : undefined, ts: w.ts })),
      unknownCommands: (r.unknownCommands || []).slice(0, LIST_MAX).map((u) => ({ command: clip(u.command, 200), source: u.source, reason: u.reason })),
      tainted: !!r.tainted, annotation: r.annotation || null, note: clip(r.note, 600),
    };
    emit(ev);
    return ev;
  }

  async function handleTerminal(seat, attempt, sub) {
    const seatId = seat.seatId;
    const attemptId = attempt ? attempt.attemptId : sub.attemptId;
    const phase = attempt ? attempt.phase : state.phase;
    const raw = sub.kind === 'pass' ? '' : String(sub.text == null ? '' : sub.text);
    const parsed = sub.kind === 'speech' && raw ? parseMarkers(raw, { nonce: attempt ? attempt.nonce : undefined }) : { markers: [] };
    const commandSubs = [...(state.structured[attemptId] || [])];
    if (sub.kind === 'pass') commandSubs.push({ kind: 'pass' });
    const required = attempt && Array.isArray(attempt.requiredVerdicts) ? attempt.requiredVerdicts : [];
    const requiredKinds = phase === 'assign' ? ['assign'] : required.length ? ['verdict'] : [];
    const discloseRequested = Object.values(state.disclosures).some((d) => d.attemptId === attemptId);
    const res = resolveSubmission({ commandSubmissions: commandSubs, textMarkers: parsed.markers, required: requiredKinds, discloseRequested });
    const reasons = res.reasons.map((r) => ({ code: r.code, text: r.text }));
    let verdicts = [];
    if (res.annotation !== 'malformed') {
      const pool = required.length ? required : pendingReviewShas(seatId);
      const resolved = [];
      for (const v of res.verdicts) {
        let sha = v.artifact;
        if (!sha) {
          if (pool.length === 1) sha = pool[0];
          else if (required.length) { reasons.push({ code: 'artifact_ambiguous', text: 'verdict 没有指明 artifact，而本回合待审产物不止一份' }); continue; }
        }
        resolved.push({ ...v, artifact: sha });
      }
      // Second conflict check on the resolved artifacts (GOV-1): an artifact-less verdict that became
      // the single pending sha may disagree with a verdict that named that sha. Neither is kept.
      const chk = checkResolvedVerdicts(resolved);
      for (const c of chk.conflicts) reasons.push({ code: 'verdict_conflict', text: REASON_TEXT.verdict_conflict, detail: { artifact: c.artifact } });
      verdicts = chk.verdicts;
      for (const sha of required) if (!verdicts.some((v) => v.artifact === sha) && !chk.conflicts.some((c) => c.artifact === sha)) reasons.push({ code: 'verdict_missing', text: `${REASON_TEXT.verdict_missing}（产物 ${sha.slice(0, 12)}）` });
    }
    // Acceptance commands in a task draft must run without a shell (W6): a .cmd/.bat shim such as
    // npm, or a name not on PATH, is refused at draft time with the reason, not at execution.
    if (res.assign && Array.isArray(res.assign.assignments)) {
      for (const p of acceptanceProblems(res.assign.assignments)) reasons.push({ code: 'acceptance_unresolvable', text: p.message, detail: { seatId: p.seatId, argv: p.argv, code: p.code } });
    }
    if (M.has('no-marker-strict')) {
      // Mutated room (#33): a missing, conflicting or translated verdict marker defaults to pass.
      for (let i = reasons.length - 1; i >= 0; i--) if (['verdict_missing', 'verdict_conflict', 'marker_translated'].includes(reasons[i].code)) reasons.splice(i, 1);
      for (const sha of required) if (!verdicts.some((v) => v.artifact === sha)) verdicts.push({ verdict: 'pass', artifact: sha, text: '', source: 'mutated-default' });
    }
    const malformed = reasons.length > 0;
    const isFollowUp = !!(attempt && attempt.followUpOf);
    // Work reports are not asked again: a follow-up would hold every other Work seat.
    const wantFollowUp = malformed && governed() && !!attempt && !isFollowUp && phase !== 'work';

    // Records from the text channel (the command channel recorded them on receipt). Nothing from a
    // malformed text channel becomes a record.
    if (!malformed) {
      for (const p of res.points) if (p.source === 'text') addPoint(seat, attemptId, p);
      for (const q of res.quotes) if (q.source === 'text') addQuote(seat, attemptId, q);
      for (const m of res.misquoted) if (m.source === 'text') addMisquoted(seat, m);
      for (const d of res.disclose) if (d.source === 'text') addDisclosure(seat, attemptId, d);
    }
    if (res.assign && (!malformed || !wantFollowUp)) {
      emit({ type: 'task_drafted', seatId, attemptId, draft: { assignments: malformed ? (res.assign.assignments || []) : res.assign.assignments, text: res.assign.draft }, errors: res.assign.errors || [] });
    } else if (phase === 'assign' && malformed && !wantFollowUp) {
      emit({ type: 'task_drafted', seatId, attemptId, draft: { assignments: [], text: raw }, errors: reasons });
    }

    // 'no-escape' (mutation, #15b): the seat's text is stored as written, forged room blocks included.
    const esc = raw && sub.kind === 'speech' ? (M.has('no-escape') ? { text: raw, count: 0 } : escapeMarkers(raw)) : null;
    const bodySha = sub.digest || (raw ? sha256(raw) : null);
    const msgSeq = esc ? state.nextMsgSeq : undefined;
    emit({
      type: 'submission_accepted', seatId, role: seat.role, attemptId, file: sub.file || undefined, msgSeq, text: esc ? esc.text : null,
      sha256: bodySha, bytes: raw ? Buffer.byteLength(raw) : 0, escaped: esc ? esc.count : 0, kind: sub.kind, source: sub.origin,
      annotation: malformed ? 'malformed' : 'none', reasons: malformed ? reasons : undefined, followUp: wantFollowUp || undefined,
    });

    // A Work report claims completion; with no frozen artifact this round, or an empty one, the
    // room records no_artifact (plan §13.1 #10) and the seat's Work does not count as done.
    let noArtifact = null;
    if (phase === 'work' && attempt) {
      const latest = state.seats[seatId] && state.seats[seatId].latestManifest;
      const art = latest ? state.artifacts[latest] : null;
      const thisRound = art && art.roundId === attempt.roundId;
      if (!thisRound) noArtifact = { reason: 'none_declared', manifestSha: null };
      else if (art.fileCount === 0) noArtifact = { reason: 'empty', manifestSha: latest };
      if (noArtifact) emit({ type: 'work_no_artifact', seatId, attemptId, roundId: attempt.roundId, ...noArtifact });
    }

    // Reviewer turns are audited after submit (plan §5.3); hosted seats hold their tools in-process.
    const reviewerish = governed() && !seat.hosted && attempt && (isReviewer(seat, room()) || isLead(seat, room()) || required.length > 0 || verdicts.length > 0);
    const audit = reviewerish ? await runAudit(seat, attempt) : null;

    let unknownItemIds = [];
    let notPermittedMarks = [];
    if (!wantFollowUp && attempt) {
      for (const v of verdicts) await recordVerdict(seat, attempt, v, audit);
      if (malformed) for (const sha of required) {
        if (verdicts.some((v) => v.artifact === sha)) continue;
        emit({ type: 'verdict_recorded', seatId, attemptId, artifactSha: sha, verdict: 'none', annotation: 'malformed', annotations: ['malformed'], entersSummary: false, producer: (state.artifacts[sha] || {}).seatId || null, evidence: { reasons } });
      }
      const markConflict = res.reasons.some((r) => r.code === 'mark_conflict' || r.code === 'mark_invalid');
      if (!markConflict && res.marks.length) {
        // Only the summary lead marks items, and only in the summary turn (plan §5.4). Any other
        // mark is not recorded; the reply says so.
        const summaryLead = phase === 'summary' && (isLead(seat, room()) || (state.stage.summary && state.stage.summary.attemptId === attemptId));
        if (!summaryLead) {
          notPermittedMarks = res.marks.map((m) => m.itemId);
        } else {
          const table = itemTable();
          const known = res.marks.filter((m) => table.some((it) => it.itemId === m.itemId));
          unknownItemIds = unknownMarks(table, res.marks);
          for (const m of known) emit({ type: 'item_marked', itemId: m.itemId, by: seatId, status: m.status, text: m.text || '', phase });
        }
      }
      if (phase === 'summary') publishSummary(seat, attempt);
    }
    const notes = [];
    if (notPermittedMarks.length) notes.push({ code: 'mark_not_permitted', text: '只有汇总回合的牵头席位可以标记条目；这些标记没有记录', items: notPermittedMarks });
    if (noArtifact) notes.push({ code: 'no_artifact', text: noArtifact.reason === 'empty' ? '声称完成，但冻结的产物集为空：记 no_artifact' : '声称完成，但本轮没有冻结任何产物（room artifacts）：记 no_artifact' });
    if (!seat.hosted && attempt) {
      const u = sub.meta && sub.meta.usage && typeof sub.meta.usage === 'object' ? sub.meta.usage : null;
      emit({ type: 'usage_reported', seatId, attemptId, input: u ? u.input : null, output: u ? u.output : null, cached: u ? u.cached : null, source: 'declared' });
    }
    return acceptReply(seat, sub, {
      seq: msgSeq, malformed: malformed ? reasons[0].code : undefined, reasons: malformed ? reasons : undefined,
      followUp: wantFollowUp || undefined, unknownItems: unknownItemIds.length ? unknownItemIds : undefined,
      annotation: noArtifact ? 'no_artifact' : undefined, notes: notes.length ? notes : undefined,
    });
  }

  async function recordVerdict(seat, attempt, v, audit) {
    const sha = v.artifact;
    const art = sha ? state.artifacts[sha] : null;
    const manifest = sha ? loadManifest(sha) : null;
    const producerId = art ? art.seatId : null;
    const producer = producerId ? seatOf(producerId) : null;
    let rec = null;
    if (manifest && producer) {
      if (M.has('no-recompute')) rec = { changed: [], stale: false };
      else {
        try {
          const r = await recompute(manifest, producer.cwd, { now: iso });
          rec = { changed: r.changed, stale: r.stale };
        } catch (e) { rec = { changed: [], stale: true, error: e.code || e.message }; }
        emit({ type: 'artifacts_recomputed', seatId: producerId, manifestSha: sha, changed: rec.changed.slice(0, 200), stale: rec.stale, error: rec.error || undefined });
      }
    }
    const fresh = art ? state.artifacts[sha] : null;
    // A stale acceptance covers only the change list the user saw (plan §5.2); a change made after
    // it, or a recompute failure that was not the accepted state, leaves the verdict stale.
    const acc = fresh && fresh.staleAccepted ? fresh.staleAccepted : null;
    const covered = !!(acc && rec && staleCovered(rec.changed, acc, rec.error || null));
    const bound = bindVerdict({
      verdict: { verdict: v.verdict, artifactSha: sha }, manifest: manifest ? { manifestSha: sha } : null, recompute: rec,
      staleAccepted: covered ? { manifestSha: sha, changed: acc.changed, error: acc.error || undefined } : null,
    });
    if (acc && !covered && bound.annotation === 'stale') bound.reason = 'STALE_CHANGED_SINCE_ACCEPT';
    const annotations = [bound.annotation];
    if (audit && audit.tainted) annotations.push('tainted');
    if (audit && audit.annotation === 'audit_failed') annotations.push('audit_failed');
    const primary = annotations.includes('stale') ? 'stale' : annotations.includes('tainted') ? 'tainted' : annotations.includes('audit_failed') ? 'audit_failed' : bound.annotation;
    const authorized = producerId ? authorizedVerdict(room(), { seatId: seat.seatId }, producerId) : false;
    emit({
      type: 'verdict_recorded', seatId: seat.seatId, attemptId: attempt.attemptId, artifactSha: sha || null, verdict: v.verdict, annotation: primary,
      annotations, entersSummary: bound.entersSummary, authorized, tainted: !!(audit && audit.tainted), producer: producerId,
      evidence: { reason: bound.reason, changed: rec ? rec.changed.slice(0, LIST_MAX) : [], recomputeError: rec && rec.error ? rec.error : undefined, audit: audit ? { status: audit.status, writes: audit.writes.length, unknownCommands: audit.unknownCommands.length } : null, text: clip(v.text, 500), source: v.source },
    });
    if (authorized && ['pass', 'reject', 'disclose'].includes(v.verdict)) {
      try {
        appendAdjudication(adjPath, { roomId: room0.id, reviewerAgent: reviewerAgentOf(seat), preset: room0.preset || 'none', verdict: v.verdict, artifactSha: sha, annotation: primary, ts: iso() }, { guard: singleFileGuard(adjPath) });
        refreshAdjudications();
      } catch (e) { log(`[adjudications] append failed: ${e.message}`); }
    }
  }

  function publishSummary(seat, attempt) {
    const items = itemTable();
    // 'no-unanswered' (mutation, #17): the room stops computing which items the lead left unanswered.
    const unanswered = M.has('no-unanswered') ? [] : unansweredItems(items);
    const prev = state.summary && state.summary.version ? state.summary.version : null;
    const version = (prev || 0) + 1;
    const roundVerdicts = state.verdicts.filter((v) => v.roundId === state.roundId && v.epoch >= reopenEpoch());
    const latestPer = new Map();
    for (const v of roundVerdicts) latestPer.set(`${v.seatId}|${v.artifactSha}`, v);
    const included = [];
    const excluded = [];
    // Each entry keeps the full annotation list and the taint (a stale-accepted tainted verdict
    // stays tainted), and whether it came from the producer's resolved reviewer. Only the reviewer's
    // verdicts are binding (plan §5.3, #36): any other seat's verdict is listed as excluded,
    // annotation not_reviewer.
    const entry = (v, extra) => ({
      artifactSha: v.artifactSha, verdict: v.verdict, seatId: v.seatId, annotation: v.annotation,
      annotations: Array.isArray(v.annotations) ? v.annotations.slice() : [v.annotation], tainted: !!v.tainted || (Array.isArray(v.annotations) && v.annotations.includes('tainted')),
      authorized: v.authorized === true, producer: v.producer || null, ...(extra || {}),
    });
    for (const v of latestPer.values()) {
      if (v.authorized !== true && v.verdict !== 'none') { excluded.push(entry(v, { annotation: 'not_reviewer', originalAnnotation: v.annotation })); continue; }
      if (v.entersSummary && v.verdict !== 'none') {
        const vs = verifiedStatus({ verdict: v.verdict, annotation: v.annotation, authorized: true, tainted: entry(v).tainted });
        included.push(entry(v, { verified: vs.verified, verifiedReason: vs.reason }));
      } else excluded.push(entry(v));
    }
    // Per artifact: 已验证 only on the resolved reviewer's latest binding verdict (verifiedStatus).
    const verified = [];
    for (const sha of new Set(roundVerdicts.map((v) => v.artifactSha).filter(Boolean))) {
      const mine = included.filter((x) => x.artifactSha === sha);
      const last = mine.length ? mine[mine.length - 1] : null;
      verified.push({ artifactSha: sha, producer: (state.artifacts[sha] || {}).seatId || (last && last.producer) || null, verified: !!(last && last.verified), reason: last ? last.verifiedReason : 'NO_BINDING_VERDICT', by: last ? last.seatId : null });
    }
    emit({
      type: 'summary_published', version, seatId: seat.seatId, attemptId: attempt.attemptId, unanswered, supersedes: prev, verdicts: included, excluded,
      verified, absent: roundAbsences(), noArtifact: roundNoArtifact(),
    });
  }

  // ---------------------------------------------------------------- admin
  function liveAttemptIds() { return pendingAttempts(state).map((a) => a.attemptId); }
  function cancelAttempt(attemptId, by) {
    const a = state.attemptLog[attemptId];
    if (!a || (a.status !== 'pending' && a.status !== 'needs_reconcile')) return false;
    emit({ type: 'attempt_canceled', seatId: a.seatId, attemptId, by });
    cancelHosted(a.seatId);
    return true;
  }
  function startRound(order) {
    const r = room();
    let phases = phasesFor(room0);
    const lead = leadId(r);
    const workers = r.seats.filter((s) => takesWork(s));
    if (!lead) phases = phases.filter((p) => p !== 'assign' && p !== 'summary');
    if (!workers.length) phases = phases.filter((p) => p !== 'work');
    if (!phases.length) phases = ['meet'];
    let ord = Array.isArray(order) && order.length ? order.filter((id) => seatOf(id)) : null;
    if (!ord) ord = [...(lead ? [lead] : []), ...r.seats.map((s) => s.seatId).filter((id) => id !== lead)];
    emit({ type: 'round_started', roundId: state.roundId + 1, order: ord, epoch: state.epoch, phases, phase: phases[0], lead });
    return { ok: true, roundId: state.roundId, phases };
  }
  function nextPhase() {
    const idx = state.phases.indexOf(state.phase);
    const next = idx >= 0 ? state.phases[idx + 1] : null;
    if (!next) {
      const st = state.stage.summary;
      const summary = state.phases.includes('summary') ? (st && st.published ? 'published' : 'missing') : undefined;
      emit({ type: 'round_done', roundId: state.roundId, summary });
      return;
    }
    emit({ type: 'phase_changed', from: state.phase, to: next, roundId: state.roundId });
  }

  async function admin(cmd = {}) {
    const name = cmd.cmd;
    const fail = (error, message) => { log(`[admin] ${name}: ${error}${message ? ` ${message}` : ''}`); return { ok: false, error, message }; };
    switch (name) {
      case 'task': if (typeof cmd.text !== 'string' || !cmd.text) return fail('BAD_ARGS', '需要 text'); emit({ type: 'task_set', text: cmd.text, sha256: sha256(cmd.text) }); return { ok: true };
      case 'start': {
        if (state.closed) return fail('ROOM_CLOSED');
        if (PHASES.includes(state.phase)) return fail('ROUND_IN_PROGRESS', '本轮还在进行');
        return startRound(cmd.order);
      }
      case 'cancel': {
        const target = cmd.attemptId || (state.attempt && state.attempt.attemptId) || (cmd.seatId && state.holding[cmd.seatId]) || (liveAttemptIds().length === 1 ? liveAttemptIds()[0] : null);
        if (!target) return fail('NO_ATTEMPT');
        return cancelAttempt(target, 'admin') ? { ok: true, attemptId: target } : fail('NOT_LIVE');
      }
      case 'skip': {
        if (state.phase === 'work') {
          const sid = cmd.seatId || null;
          if (!sid) return fail('BAD_ARGS', 'Work 阶段跳过需要 seatId');
          const held = state.holding[sid];
          if (held) cancelHosted(sid);
          emit({ type: 'seat_skipped', seatId: sid, attemptId: held || null, by: 'admin', phase: 'work' });
          return { ok: true };
        }
        if (state.phase === 'meet') {
          if (state.turnIndex >= state.order.length && !state.attempt) return fail('NOTHING_TO_SKIP');
          const sid = state.attempt ? state.attempt.seatId : state.order[state.turnIndex];
          if (state.attempt) cancelHosted(sid);
          emit({ type: 'seat_skipped', seatId: sid, attemptId: state.attempt ? state.attempt.attemptId : null, by: 'admin', phase: 'meet' });
          return { ok: true };
        }
        if (state.phase === 'summary' || state.phase === 'assign') {
          const st = state.stage[state.phase];
          const aid = state.attempt ? state.attempt.attemptId : null;
          if (state.attempt) cancelHosted(state.attempt.seatId);
          emit({ type: 'seat_skipped', seatId: state.attempt ? state.attempt.seatId : leadId(), attemptId: aid, by: 'admin', phase: state.phase });
          return { ok: true, stage: st };
        }
        return fail('NOTHING_TO_SKIP');
      }
      case 'retry': {
        // The user's "wait" choice after a seat's turn ran out (#6a): the same seat gets a fresh
        // attempt for the same turn; the packet names the expired one.
        const g = state.awaitingDecision;
        if (!g) return fail('NO_DECISION_PENDING', '没有等待用户决定的超时席位');
        if (cmd.seatId && cmd.seatId !== g.seatId) return fail('BAD_ARGS', `等待决定的是席位 ${g.seatId}`);
        if (paused()) return fail('PAUSED', '已达用量上限，暂停发包');
        const aid = issue(g.seatId, g.phase);
        return aid ? { ok: true, attemptId: aid } : fail('NOT_ISSUED');
      }
      case 'wake': {
        const seat = seatOf(cmd.seatId);
        if (!seat) return fail('NO_SEAT');
        const r = pushWake(seat, state.holding[seat.seatId] || null, 'admin');
        return r.ok ? { ok: true } : fail(r.reason);
      }
      case 'close': return closeRoom();
      case 'say': {
        if (typeof cmd.text !== 'string' || !cmd.text.trim()) return fail('BAD_ARGS', '需要 text');
        emit({ type: 'user_message_queued', msgSeq: state.nextMsgSeq, text: cmd.text, sha256: sha256(cmd.text), deliverFromRound: state.roundId + 1 });
        return { ok: true, deliverFromRound: state.roundId + 1 };
      }
      case 'interrupt': {
        if (!PHASES.includes(state.phase)) {
          if (cmd.text) return admin({ cmd: 'say', text: cmd.text });
          return fail('NO_ROUND', '没有进行中的回合可以重开');
        }
        for (const id of liveAttemptIds()) cancelAttempt(id, 'interrupt');
        const epoch = state.epoch + 1;
        emit({ type: 'epoch_bumped', epoch, reason: 'interrupt' });
        if (cmd.text) emit({ type: 'user_message_queued', msgSeq: state.nextMsgSeq, text: cmd.text, sha256: sha256(cmd.text), deliverFromRound: state.roundId, immediate: true });
        const superseded = state.messages.filter((m) => m.roundId === state.roundId && !m.superseded).map((m) => m.seq);
        emit({ type: 'round_reopened', epoch, supersededSeqs: superseded, phase: state.phases[0] || 'meet', phases: state.phases });
        return { ok: true, epoch, supersededSeqs: superseded };
      }
      case 'confirm-task': {
        const assignments = Array.isArray(cmd.assignments) ? cmd.assignments : (state.taskDraft && state.taskDraft.draft ? state.taskDraft.draft.assignments : null);
        if (!assignments || !assignments.length) return fail('NO_ASSIGNMENTS', '没有可确认的任务单（草案为空时请在命令里给出 assignments）');
        const v = validateDivisionRound(room(), assignments);
        if (!v.ok) return { ...fail('INVALID_ASSIGNMENTS', v.errors.map((e) => e.message).join('；')), errors: v.errors };
        const bad = acceptanceProblems(assignments);
        if (bad.length) {
          const code = bad.some((p) => p.code === 'BATCH_SHIM_UNSUPPORTED') ? 'ACCEPTANCE_BATCH_SHIM' : 'ACCEPTANCE_UNRESOLVABLE';
          return { ...fail(code, bad.map((p) => p.message).join('；')), problems: bad };
        }
        const needConfirm = v.warnings.filter((w) => w.requiresConfirm);
        if (needConfirm.length && cmd.confirmSameCwd !== true) return { ...fail('CONFIRM_REQUIRED', needConfirm.map((w) => w.message).join('；')), warnings: v.warnings };
        emit({ type: 'task_confirmed', by: 'admin', assignments, warnings: v.warnings.map((w) => ({ code: w.code, message: w.message })) });
        return { ok: true };
      }
      case 'reverse': {
        const r = reverseRoom(room(), state);
        if (!r.ok) return { ...fail(r.reason, r.message), errors: r.errors };
        emit({ ...r.event, roles: r.roles, reviews: r.reviews, leadSeatId: r.room.leadSeatId || null, redeclare: r.redeclare });
        emit({ type: 'epoch_bumped', epoch: r.event.epoch, reason: 'reverse' });
        return { ok: true, epoch: r.event.epoch, roles: r.roles };
      }
      case 'reconcile': {
        const a = state.attemptLog[cmd.attemptId];
        if (!a || a.status !== 'needs_reconcile') return fail('NOT_PENDING_RECONCILE');
        if (cmd.action === 'replay') {
          const seat = seatOf(a.seatId);
          const wall = Number((seat && seat.wallClockSec) || room0.wallClockSec || DEFAULT_WALL_SEC);
          // Receipt (plan §7.2, #14): a packet the seat confirmed taking (its last-attempt.json names
          // this attempt) is handed back unchanged; one whose receipt is unknown is re-sent once more,
          // same attempt, with a notice to ignore it if it already arrived.
          const receipt = seat && !seat.hosted ? packetReceipt(seat, a) : 'room';
          emit({ type: 'reconciled', attemptId: a.attemptId, seatId: a.seatId, action: 'replay', receipt, deadline: new Date(now() + wall * 1000).toISOString() });
          const resent = receipt === 'unknown' ? resendPacket(seat, a, 'receipt_unknown') : null;
          if (seat && seat.hosted) { try { startHosted(seat, a.attemptId, fs.readFileSync(a.path, 'utf8')); } catch (e) { log(`[hosted] replay failed: ${e.message}`); } }
          return { ok: true, receipt, resent: resent ? resent.path : null };
        }
        if (cmd.action === 'void') {
          emit({ type: 'reconciled', attemptId: a.attemptId, seatId: a.seatId, action: 'void' });
          emit({ type: 'epoch_bumped', epoch: state.epoch + 1, reason: 'reconcile_void', attemptId: a.attemptId });
          return { ok: true };
        }
        return fail('BAD_ARGS', 'action 必须是 replay 或 void');
      }
      case 'reassign': {
        const from = seatOf(cmd.seatId);
        const to = seatOf(cmd.toSeatId);
        if (!from || !to || from.seatId === to.seatId) return fail('BAD_ARGS', '需要两个不同的现有席位 seatId、toSeatId');
        const held = state.holding[from.seatId];
        if (held) cancelAttempt(held, 'reassign');
        emit({ type: 'epoch_bumped', epoch: state.epoch + 1, reason: 'reassign', fromSeat: from.seatId, toSeat: to.seatId, text: typeof cmd.text === 'string' ? cmd.text : '' });
        return { ok: true };
      }
      case 'approve-disclose': return approveDisclose(cmd);
      case 'deny-disclose': {
        const d = state.disclosures[cmd.id];
        if (!d) return fail('NO_SUCH_DISCLOSURE');
        const r = denyDisclosure(requestOf(d), { by: 'admin', reason: cmd.reason || '', now: iso });
        if (!r.ok) return fail(r.reason, r.message);
        emit({ type: 'disclose_denied', id: d.id, by: 'admin', reason: cmd.reason || '' });
        return { ok: true };
      }
      case 'accept-stale': {
        const art = state.artifacts[cmd.manifestSha];
        if (!art) return fail('NO_SUCH_MANIFEST');
        // The user accepts the change list the room showed them, so there must be one: a manifest
        // that was never recomputed, or recomputed clean, has nothing to accept (plan §5.2).
        const rc = art.recomputed;
        if (!rc || !(rc.stale === true || (Array.isArray(rc.changed) && rc.changed.length > 0))) return fail('NOT_STALE', '这份产物还没有复算出变化，没有可接受的过期');
        if (cmd.changed !== undefined) {
          const want = (Array.isArray(cmd.changed) ? cmd.changed : []).map((c) => (typeof c === 'string' ? c : c && c.path)).sort();
          const have = rc.changed.map((c) => c.path).sort();
          if (JSON.stringify(want) !== JSON.stringify(have)) return fail('CHANGED_MISMATCH', '界面上看到的变化清单与最新复算不一致，请刷新后再确认');
        }
        emit({ type: 'stale_accepted', manifestSha: cmd.manifestSha, by: 'admin', changed: rc.changed, error: rc.error || undefined, recomputedTs: rc.ts || undefined });
        return { ok: true, changed: rc.changed.length };
      }
      case 'pi-key': {
        // In memory only: over the loopback /api/admin (admin pi-key --port) or from a caller in
        // the same process. There is no file handoff (NI-3).
        const key = typeof cmd.key === 'string' ? cmd.key.trim() : null;
        if (!key) return fail('NO_KEY', 'pi-key 只接受请求体里的 key；不再读取交接文件');
        piKey = key;
        piKeySource = 'admin';
        log('[admin] pi-key received (kept in memory only)');
        return { ok: true };
      }
      case 'pi-permission': {
        const h = hosted.get(cmd.seatId);
        if (!h) return fail('NO_HOSTED_SEAT');
        try { const r = await h.pi.resolvePermission(cmd.id, cmd.decision); return { ok: true, decision: r.decision }; } catch (e) { return fail(e.code || 'ERROR', e.message); }
      }
      default: return fail('UNKNOWN_CMD');
    }
  }

  function requestOf(d) {
    return {
      id: d.id, seatId: d.seatId, attemptId: d.attemptId, argv: d.argv, reason: d.reason, allowed: d.allowed !== false, status: d.status,
      approvedArgv: d.status === 'approved' ? d.argv : undefined, matched: d.matched || undefined, matchKind: d.matchKind || undefined, history: [],
    };
  }
  async function approveDisclose(cmd) {
    const d = state.disclosures[cmd.id];
    if (!d) return { ok: false, error: 'NO_SUCH_DISCLOSURE' };
    const req = requestOf(d);
    const r = approveDisclosure(req, { by: 'admin', argv: cmd.argv, now: iso });
    if (!r.ok && r.reason === 'ARGV_CHANGED') {
      // A changed argv is a new request (plan #30); the old one is closed.
      emit({ type: 'disclose_denied', id: d.id, by: 'admin', reason: 'ARGV_CHANGED' });
      const seat = seatOf(d.seatId);
      const nr = addDisclosure(seat, d.attemptId, { argv: cmd.argv, reason: d.reason, artifact: d.manifestSha }, null);
      return { ok: false, error: 'ARGV_CHANGED', newRequestId: nr.id, newStatus: nr.status };
    }
    if (!r.ok) { log(`[admin] approve-disclose ${d.id}: ${r.reason}`); return { ok: false, error: r.reason, message: r.message }; }
    emit({ type: 'disclose_approved', id: d.id, by: 'admin' });
    const art = d.manifestSha ? state.artifacts[d.manifestSha] : null;
    if (!art || !art.snapshotDir || !fs.existsSync(art.snapshotDir)) {
      emit({ type: 'disclose_denied', id: d.id, by: 'room', reason: 'NO_SNAPSHOT' });
      return { ok: false, error: 'NO_SNAPSHOT' };
    }
    if (art.snapshotStale) {
      // The copy differs from the frozen manifest: a disclosure there would report a manifestSha
      // whose content it did not run on.
      emit({ type: 'disclose_denied', id: d.id, by: 'room', reason: 'SNAPSHOT_STALE' });
      return { ok: false, error: 'SNAPSHOT_STALE' };
    }
    const pdir = path.join(privateDir(d.attemptId || 'disclose'), `disclose-${d.id}`);
    let ex;
    try {
      // The full argument rule is re-run before anything spawns (NI-11 defence in depth).
      ex = await executeDisclosure(r.request, {
        manifestSha: d.manifestSha, now: iso, allowlist: room0.disclosureAllowlist, acceptanceCommands: acceptanceCommands(),
        run: async (argv) => {
          const rr = await runInSnapshot({ snapshotDir: art.snapshotDir, argv, spawn, privateDir: pdir, guard, timeoutMs: Number(room0.discloseTimeoutMs) || 120_000, maxOutputBytes: 1_048_576 });
          return { ...rr, exitCode: rr.code };
        },
      });
    } catch (e) {
      // runInSnapshot refuses before spawning: BATCH_SHIM_UNSUPPORTED, COMMAND_NOT_FOUND,
      // ARG_NOT_ALLOWED, SNAPSHOT_MISSING... The approval is closed with that reason.
      const reason = e && e.code ? String(e.code) : 'EXEC_FAILED';
      emit({ type: 'disclose_denied', id: d.id, by: 'room', reason, message: clip(e && e.message, 300) });
      return { ok: false, error: reason, message: e && e.message };
    }
    if (!ex.ok) {
      log(`[admin] disclosure ${d.id} not executed: ${ex.reason}`);
      emit({ type: 'disclose_denied', id: d.id, by: 'room', reason: ex.reason, message: ex.message ? clip(ex.message, 300) : undefined });
      return { ok: false, error: ex.reason, message: ex.message };
    }
    emit(ex.event);
    return { ok: true, exitCode: ex.result.exitCode, privatePath: ex.result.privatePath };
  }

  function closeRoom() {
    if (state.closed) return { ok: false, error: 'ROOM_CLOSED' };
    for (const id of liveAttemptIds()) cancelAttempt(id, 'close');
    for (const seat of room().seats) {
      const nonce = randomHex(4);
      const packetId = `farewell-${room0.id}-${seat.seatId}-${nonce}`;
      const f = renderFarewell({ room: room(), seat, nonce, roomCmd: roomCmdFor(seat), packetId, templates });
      const p = path.join(roomDir, F.packets, `${packetId}.md`);
      guard.writeFile(p, f.text);
      guard.writeFile(path.join(roomDir, 'manifests', `${packetId}.json`), JSON.stringify(f.manifest, null, 1));
      emit({ type: 'farewell_issued', packetId, seats: [seat.seatId], path: p, sha256: f.manifest.sha256 });
    }
    emit({ type: 'room_closed', by: 'admin' });
    return { ok: true };
  }

  async function processAdminQueue() {
    const qdir = path.join(roomDir, F.adminQueue);
    let files;
    try { files = fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
    for (const f of files) {
      const p = path.join(qdir, f);
      let cmd;
      try { cmd = readJson(p); } catch { continue; } // may be mid-write
      if (!cmd || typeof cmd !== 'object') { guard.rename(p, path.join(qdir, 'done', f)); continue; }
      if (cmd.cmd === 'pi-key' || cmd.key !== undefined) {
        // A key never travels through the queue (NI-3): such a file is deleted, not archived, and
        // never executed. The key reaches the service only in memory (/api/admin, env, stdin).
        try { guard.rm(p); } catch (e) { log(`[admin] ${f}: could not delete: ${e.code || e.message}`); }
        log('[admin] pi-key via queue refused (file deleted)');
        continue;
      }
      const finish = () => guard.rename(p, path.join(qdir, 'done', f));
      if (cmd.token !== adminToken) { log(`[admin] ${f}: bad token, ignored`); finish(); continue; }
      const { token: _t, ...rest } = cmd;
      try { await admin(rest); } catch (e) { log(`[admin] ${cmd.cmd} failed: ${e.message}`); }
      finish();
    }
  }

  // ---------------------------------------------------------------- the clock
  function checkDeadlines() {
    const t = now();
    for (const a of pendingAttempts(state)) {
      if (a.status !== 'pending') continue; // needs_reconcile does not expire
      if (a.deadline && Date.parse(a.deadline) < t) {
        // Governed rooms hold an expired turn for the user's decision (plan §4.3 rule 7, #6a): the
        // reducer then waits for admin retry / skip / reassign instead of moving on.
        const hold = governed() && a.phase !== 'work' && !a.followUpOf;
        emit({ type: 'attempt_expired', seatId: a.seatId, attemptId: a.attemptId, hold: hold || undefined });
        if (hold) log(`[service] seat ${a.seatId} let attempt ${a.attemptId} expire; waiting for the user: admin retry / skip / reassign`);
        cancelHosted(a.seatId);
        if (a.followUpOf && a.requiredVerdicts && a.requiredVerdicts.length) {
          for (const sha of a.requiredVerdicts) emit({ type: 'verdict_recorded', seatId: a.seatId, attemptId: a.attemptId, artifactSha: sha, verdict: 'none', annotation: 'malformed', annotations: ['malformed'], entersSummary: false, producer: (state.artifacts[sha] || {}).seatId || null, evidence: { reason: 'FOLLOW_UP_EXPIRED' } });
        }
      }
    }
    if (state.phase === 'work' && state.work && state.work.deadline && Date.parse(state.work.deadline) < t) {
      for (const a of pendingAttempts(state).filter((x) => x.phase === 'work')) { emit({ type: 'work_partial', roundId: state.roundId, seatId: a.seatId, attemptId: a.attemptId }); cancelHosted(a.seatId); }
      for (const sid of [...(state.work.queue || [])]) emit({ type: 'work_partial', roundId: state.roundId, seatId: sid, attemptId: null });
    }
  }

  function paused() {
    const maxTokens = room0.budget ? room0.budget.maxTokens : null;
    const p = isPaused({ totals: state.usage.totals, maxTokens });
    if (p && !pausedLogged) { log(`[service] paused: known tokens ${state.usage.totals.tokens} >= cap ${maxTokens}; no new packets until the cap is raised`); pausedLogged = true; }
    if (!p) pausedLogged = false;
    return p;
  }

  function advance() {
    for (let guardN = 0; guardN < 64; guardN++) {
      if (state.closed) return;
      const before = state.lastSeq;
      step();
      if (state.lastSeq === before) return;
    }
  }
  function step() {
    const phase = state.phase;
    if (!PHASES.includes(phase)) return;
    if (state.followUp && !state.followUp.issued) {
      if (paused()) return;
      const fu = state.followUp;
      const followUpText = malformedFollowUp({ reasons: fu.reasons, attemptId: fu.forAttemptId, retriesLeft: 1, resubmit: surfaceLine(seatSurface(seatOf(fu.seatId)), 'resubmit') });
      issue(fu.seatId, fu.phase, { kind: 'followup', followUpOf: fu.forAttemptId, followUpText });
      return;
    }
    if (state.followUp) return; // the follow-up attempt is live
    // A seat's turn ran out: nothing moves until the user retries, skips or reassigns (#6a).
    if (state.awaitingDecision && phase !== 'work') return;
    if (phase === 'assign') {
      const st = state.stage.assign;
      if (st.done) { if (state.taskConfirmed && state.taskConfirmed.roundId === state.roundId) nextPhase(); return; }
      if (state.attempt) return;
      if (paused()) return;
      const lead = leadId();
      if (!lead) { nextPhase(); return; }
      issue(lead, 'assign');
      return;
    }
    if (phase === 'work') {
      if (!state.work || state.work.roundId !== state.roundId) {
        const seats = Array.isArray(state.assignments) && state.taskConfirmed && state.taskConfirmed.roundId === state.roundId
          ? state.assignments.map((a) => a.seatId).filter((id) => seatOf(id))
          : room().seats.filter((s) => takesWork(s)).map((s) => s.seatId);
        const wall = Number(room0.workWallClockSec || DEFAULT_WORK_WALL_SEC);
        emit({ type: 'work_started', roundId: state.roundId, seats, deadline: new Date(now() + wall * 1000).toISOString() });
        return;
      }
      const live = pendingAttempts(state).filter((a) => a.phase === 'work' && a.roundId === state.roundId);
      const max = Math.max(1, Number(room0.maxWorkConcurrent || 2));
      if (live.length < max && state.work.queue.length && !paused()) {
        issue(state.work.queue[0], 'work');
        return;
      }
      if (!live.length && !state.work.queue.length) nextPhase();
      return;
    }
    if (phase === 'meet') {
      if (state.attempt) return;
      if (state.turnIndex >= state.order.length) { nextPhase(); return; }
      if (paused()) return;
      issue(state.order[state.turnIndex], 'meet');
      return;
    }
    if (phase === 'summary') {
      const st = state.stage.summary;
      if (st.done) { nextPhase(); return; }
      if (state.attempt) return;
      if (paused()) return;
      const lead = leadId();
      if (!lead) { nextPhase(); return; }
      issue(lead, 'summary');
    }
  }

  // One chain serializes ticks, admin calls from HTTP and seat requests from HTTP: the state is only
  // ever changed by one of them at a time.
  // The chain starts behind the saved-key load (it never rejects): nothing serialized runs before it.
  let chain = savedKeyReady;
  function serial(fn) {
    const p = chain.then(() => fn()).finally(() => { try { flush(); } catch (e) { log(`[service] state.json write failed: ${e.message}`); } });
    chain = p.catch(() => {});
    return p;
  }
  let ticking = null;
  async function tickOnce() {
    if (closed) return;
    await processAdminQueue();
    await drainHosted();
    await scanOutboxes();
    if (M.has('no-disclose-gate')) {
      // Mutated room (#25): disclosure requests run without the user's approval.
      for (const d of Object.values(state.disclosures)) if (d.status === 'requested' && d.allowed !== false) await approveDisclose({ id: d.id });
    }
    if (state.closed) return;
    checkDeadlines();
    advance();
  }
  function tick() {
    if (closed) return Promise.resolve();
    if (ticking) return ticking;
    ticking = serial(tickOnce).finally(() => { ticking = null; });
    return ticking;
  }
  function adminExternal(cmd) {
    if (closed) return Promise.resolve({ ok: false, error: 'SERVICE_CLOSED' });
    return serial(async () => { const r = await admin(cmd); if (!state.closed) advance(); return r; });
  }
  // Waits for every async side task (wake pushes, hosted prompts, cancels) started so far.
  async function settle() {
    for (let i = 0; i < 50 && inflight.size; i++) await Promise.allSettled([...inflight]);
  }

  async function close() {
    if (closed) return;
    if (ticking) { try { await ticking; } catch { /* reported by the caller */ } }
    closed = true;
    for (const h of hosted.values()) { try { await h.pi.dispose(); } catch { /* ignore */ } }
    await settle();
    flush();
    const lock = readJson(lockPath, null);
    if (lock && lock.pid === process.pid) guard.rm(lockPath);
    log(`[service] stopped; phase=${state.phase}`);
  }

  // Seat transport over HTTP (optional, INTERFACES §8): the same checks as an outbox file, with the
  // seat token presented directly instead of a proof.
  async function seatRequest(seatId, cmd, body = {}) {
    const seat = seatOf(seatId);
    if (!seat) return { status: 'REJECTED', reason: 'NO_SEAT' };
    if (cmd === 'status' || cmd === 'wait') {
      const held = state.holding[seatId];
      const a = held ? state.attemptLog[held] : null;
      if (state.closed) return { status: 'ROOM_CLOSED' };
      if (state.seats[seatId] && state.seats[seatId].status === 'left') return { status: 'LEFT' };
      if (a && a.status === 'needs_reconcile') return { status: 'NEEDS_RECONCILE', attemptId: a.attemptId };
      if (cmd === 'wait' && a) return { status: 'TURN', attemptId: a.attemptId, nonce: a.nonce, packet: a.path, sha256: a.sha256, deadline: a.deadline };
      if (cmd === 'wait') return { status: 'NOT_YOUR_TURN', phase: state.phase, current: state.currentSeat || null };
      return { status: 'STATUS', phase: state.phase, round: state.roundId, epoch: state.epoch, current: state.currentSeat || null, attempt: a ? a.attemptId : null };
    }
    const kind = cmd === 'submit' ? 'speech' : cmd;
    if (!COMMAND_KINDS.includes(kind)) return { status: 'REJECTED', reason: 'UNKNOWN_KIND' };
    const attemptId = body.attemptId ? String(body.attemptId) : null;
    const subId = `${attemptId || 'none'}-h${randomHex(3)}`;
    const text = kind === 'speech' ? String(body.text == null ? '' : body.text) : null;
    const payload = kind === 'speech' ? {} : (body.payload && typeof body.payload === 'object' ? body.payload : {});
    const sub = { subId, kind, attemptId, payload, text, digest: text != null ? sha256(text) : sha256(JSON.stringify(payload)), meta: { epoch: body.epoch, usage: body.usage }, origin: 'http' };
    if (!attemptId && kind !== 'artifacts') return { status: 'REJECTED', reason: 'MALFORMED_META' };
    if (closed) return { status: 'REJECTED', reason: 'SERVICE_CLOSED' };
    return serial(async () => { const r = await processSubmission(seat, sub); if (!state.closed) advance(); return r; });
  }
  function seatToken(seatId) {
    try { return fs.readFileSync(path.join(roomDir, F.seats, seatId, 'token'), 'utf8').trim(); } catch { return null; }
  }

  reconcileOnStart();
  refreshAdjudications();
  computeConflicts();
  writeState();

  return {
    roomDir,
    get state() { return state; },
    get room() { return room(); },
    get events() { return events; },
    view, emit, tick, settle, close, admin: adminExternal, seatRequest, seatToken, adminToken, heartbeat,
    rebuild: () => rebuild(roomDir),
    mutations: M,
  };
}

// CLI wrapper: loops tick(); --port starts the loopback HTTP surface (lib/http.mjs).
export async function serve({ roomDir, tickMs = 400, port, once = false, log = out, ...rest } = {}) {
  const lock = readJson(path.join(path.resolve(roomDir), F.lock), null);
  let lockProbe;
  if (lock && lock.pid && lock.pid !== process.pid && lockHolderAlive(lock)) {
    lockProbe = await probeLockHolder(lock, { spawn: typeof rest.spawn === 'function' ? rest.spawn : spawnClean });
    log(`[service] service.lock names pid ${lock.pid}; OS probe: ${lockProbe}`);
  }
  const svc = createRoomService({ roomDir, log, lockProbe, ...rest });
  let http = null;
  if (port !== undefined && port !== null && port !== false && port !== '') {
    const { startHttp } = await import('./http.mjs');
    http = await startHttp({ service: svc, port: Number(port), log });
    log(`[service] UI ${http.url}#${svc.adminToken}`);
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  // Closing the launcher's console window is the documented way to stop: Windows delivers it as
  // SIGHUP (Ctrl+Break as SIGBREAK). Each of them ends the loop so close() removes service.lock.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  for (const sig of signals) process.on(sig, stop);
  const hb = setInterval(() => svc.heartbeat(), LOCK_HEARTBEAT_MS);
  if (hb.unref) hb.unref();
  try {
    do {
      // One failed tick (e.g. a write that still fails after the guard's retries) is logged and the
      // loop goes on; everything a tick decided before the failure is already in events.jsonl.
      try { await svc.tick(); } catch (e) { log(`[service] tick failed: ${e && (e.code || e.message)}; retrying next tick`); }
      if (once) break;
      await sleep(tickMs);
    } while (!stopping && !svc.state.closed);
  } finally {
    clearInterval(hb);
    for (const sig of signals) process.off(sig, stop);
    if (http) await http.close();
    await svc.close();
  }
  return svc.state;
}

// resolveCodexThread(thread, {home}) -> {id, byName, note?}. A wake thread may be registered as the
// thread's UUID or as its exact name (README, admin add-seat --wake-thread). Codex keeps the names in
// $CODEX_HOME/session_index.jsonl, one {id, thread_name, updated_at} line per rename; the newest line
// per id is its current name. Read-only. A UUID is returned as is; a name held by exactly one thread
// becomes that thread's id; a name held by several gives id null (the push is refused, never
// guessed); a name the index does not know is returned as is (it may be an id the index lacks).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resolveCodexThread(thread, { home } = {}) {
  const t = String(thread || '');
  if (!t || UUID_RE.test(t)) return { id: t || null, byName: false, ...(t ? {} : { note: '没有登记线程' }) };
  let text;
  try { text = fs.readFileSync(path.join(home || codexHome(), 'session_index.jsonl'), 'utf8'); } catch {
    return { id: t, byName: false, note: `CODEX_HOME 里没有 session_index.jsonl，无法把线程名「${t}」换成线程 id` };
  }
  const latest = new Map(); // id -> {name, at}
  text.split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (!o || typeof o.id !== 'string' || !UUID_RE.test(o.id) || typeof o.thread_name !== 'string') return;
    const at = typeof o.updated_at === 'string' ? o.updated_at : '';
    const prev = latest.get(o.id);
    if (!prev || !prev.at || !at || at >= prev.at) latest.set(o.id, { name: o.thread_name, at: at || (prev && prev.at) || '' });
  });
  const hits = [...latest].filter(([, v]) => v.name === t).map(([id]) => id);
  if (hits.length === 1) return { id: hits[0], byName: true };
  if (hits.length > 1) return { id: null, byName: true, note: `有 ${hits.length} 个 Codex 线程都叫「${t}」，不知道该推给哪一个；请把线程改成不重复的名字，或登记线程 id` };
  return { id: t, byName: false, note: `session_index.jsonl 里没有叫「${t}」的线程（线程要先在 Codex 里重命名成这个名字）` };
}

// codexThreadIdle(threadId, {home}) -> {idle, note, file}. Read-only look at the thread's native
// rollout ($CODEX_HOME/sessions/**/rollout-<ts>-<threadId>.jsonl, newest by mtime): idle when no
// task_started / turn_started is left open by a later task_complete / turn_complete / turn_aborted.
// No rollout found, or an unreadable one: idle null (unknown), never a guess.
const TURN_OPEN = new Set(['task_started', 'turn_started']);
const TURN_CLOSE = new Set(['task_complete', 'turn_complete', 'turn_aborted', 'task_aborted']);
export async function codexThreadIdle(threadId, { home } = {}) {
  if (!threadId || !/^[A-Za-z0-9-]+$/.test(String(threadId))) return { idle: null, note: '线程 id 不可用' };
  const root = path.join(home || codexHome(), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const found = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1); } else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) found.push(p);
    }
  };
  walk(root, 4);
  if (!found.length) return { idle: null, note: '找不到该线程的 rollout 日志' };
  let file = found[0];
  let best = -1;
  for (const f of found) { try { const m = fs.statSync(f).mtimeMs; if (m > best) { best = m; file = f; } } catch { /* vanished */ } }
  let open = false;
  let seen = 0;
  const stream = fs.createReadStream(file, { encoding: 'utf8', flags: 'r' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes('"event_msg"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const t = obj && obj.type === 'event_msg' && obj.payload ? obj.payload.type : null;
      if (TURN_OPEN.has(t)) { open = true; seen++; } else if (TURN_CLOSE.has(t)) { open = false; seen++; }
    }
  } catch (e) { return { idle: null, note: `读取 rollout 失败：${e.code || e.message}`, file }; } finally { rl.close(); stream.destroy(); }
  return { idle: !open, note: open ? '最近的回合尚未结束' : (seen ? '最近的回合已结束' : '线程还没有回合'), file };
}

// lockHolderAlive(lock, {nowMs, isAlive}) lives in lib/common.mjs (re-exported above) so that
// admin.mjs serviceRunning applies the same test (INTERFACES §1 service.lock).

// The PowerShell the probe runs. Windows PowerShell 5.1 writes redirected output in the OEM code page
// (936 on a Chinese system), so a non-ASCII image name such as 圆桌 would come back as mojibake and
// never match the lock. The name is therefore sent as base64 of its UTF-8 bytes ("b64:<...>"), which
// is ASCII in every code page; the start time is ASCII already.
// The script calls .NET directly and no cmdlet. Measured on a GitHub Actions windows-latest runner
// (CI run 37261907203): with Get-Process this probe hit the 15 s timeout; every PowerShell child there
// that called a cmdlet (Get-Process, Add-Type, Get-CimInstance) took 15-40 s, while two cmdlet-free
// children through the same spawnClean finished within 1.8 s (seat.test W3). Inferred, not measured:
// the cost is cmdlet discovery (module autoload) under spawnClean's whitelist environment.
// A pid that is not running prints NO_PROCESS and exits LOCK_PROBE_GONE_EXIT.
export const LOCK_PROBE_GONE_EXIT = 3;
export function lockProbeScript(pid) {
  return `$p = $null; try { $p = [System.Diagnostics.Process]::GetProcessById(${Number(pid)}) } catch { $x = $_.Exception; while ($null -ne $x.InnerException) { $x = $x.InnerException }; if ($x -is [System.ArgumentException]) { [Console]::Out.Write('NO_PROCESS' + [char]10); exit ${LOCK_PROBE_GONE_EXIT} }; throw }; 'b64:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.ProcessName)) + '|' + $p.StartTime.ToUniversalTime().ToString('o')`;
}
// "b64:<base64 utf-8 name>|<start>" (or a plain "<name>|<start>") -> [name, start].
export function parseLockProbeOutput(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const i = line.indexOf('|');
  let name = i === -1 ? line : line.slice(0, i);
  const started = i === -1 ? '' : line.slice(i + 1);
  if (name.startsWith('b64:')) {
    const b = name.slice(4);
    name = b && /^[A-Za-z0-9+/]*={0,2}$/.test(b) ? Buffer.from(b, 'base64').toString('utf8') : null; // null: unreadable
  }
  return [name, started];
}

// probeLockHolder(lock, {spawn}) -> 'alive' | 'stale' | 'unknown'. Asks Windows (one-shot
// PowerShell through lib/spawn.mjs) for the start time and image of the process holding the pid:
// a process that started after the lock's writer did, or is not node, is not the writer.
export async function probeLockHolder(lock, { spawn = spawnClean, isAlive = pidAlive, nowMs = Date.now() } = {}) {
  if (!lock || !Number.isInteger(lock.pid)) return 'stale';
  if (!lockHolderAlive(lock, { nowMs, isAlive })) return 'stale';
  if (process.platform !== 'win32' && spawn === spawnClean) return 'unknown';
  const writerStart = Date.parse(lock.procStartedAt || '');
  let r;
  try {
    r = await spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lockProbeScript(lock.pid)], { timeoutMs: 15_000, maxOutputBytes: 4096 });
  } catch { return 'unknown'; }
  if (!r || r.spawnError || r.timedOut) return 'unknown';
  if (r.code === LOCK_PROBE_GONE_EXIT && /(?:^|\n)NO_PROCESS\r?\n/.test(String(r.stdout || ''))) return 'stale';
  if (r.code !== 0) return /Cannot find a process|找不到/.test(String(r.stderr || '')) ? 'stale' : 'unknown';
  const [name, started] = parseLockProbeOutput(r.stdout);
  if (name === null) return 'unknown';
  // A lock written by a host-embedded service names its image; older locks assume node.
  const expected = typeof lock.image === 'string' && lock.image ? lock.image : 'node';
  if (name && name.trim().toLowerCase() !== expected.toLowerCase()) return 'stale';
  const t = Date.parse(started || '');
  if (Number.isFinite(writerStart) && Number.isFinite(t) && t > writerStart + LOCK_START_TOLERANCE_MS) return 'stale';
  return Number.isFinite(writerStart) && Number.isFinite(t) ? 'alive' : 'unknown';
}
