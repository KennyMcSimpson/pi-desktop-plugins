// Embedding API (INTERFACES §15) for a host process that runs rooms in-process: PI-Desktop's
// Electron main, tests, scripts. Nothing here prints or exits. Every command result comes back as
//   { code, status, fields, lines, error? }
// where `status` is the first word of the first line (the seat/admin contract: TURN, TURN_OVER,
// NOT_YOUR_TURN, ACCEPTED, REJECTED, QUEUED, SEAT, INIT, ...), `fields` its key=value pairs, and
// `lines` everything the command printed. Commands go through the exact functions `room.mjs` calls,
// with the parameters turned into the same argv a user would type, so an embedded call and a CLI
// call cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, randomHex, readJson, ROOM_FILES as F, OUTBOX_FILES as O, LOCK_HEARTBEAT_MS } from './common.mjs';
import { createGuard } from './guard.mjs';

// ---------------------------------------------------------------- argv building

// params -> argv. Arrays repeat the flag (`arg: ['git','diff']` -> --arg git --arg diff), except
// `declare`, which takes its paths after a single flag (seat `artifacts --declare p1 p2`). `true`
// is a bare flag; null/undefined/false are omitted. Values that start with '-' use --key=value.
export function toArgv(params = {}) {
  const argv = [];
  for (const [k, v] of Object.entries(params)) {
    if (k === '_' || v === undefined || v === null || v === false) continue;
    if (v === true) { argv.push(`--${k}`); continue; }
    if (Array.isArray(v)) {
      if (k === 'declare') { argv.push('--declare', ...v.map(String)); continue; }
      for (const x of v) argv.push(String(x).startsWith('-') ? `--${k}=${x}` : `--${k}`, ...(String(x).startsWith('-') ? [] : [String(x)]));
      continue;
    }
    const s = String(v);
    if (s.startsWith('-')) argv.push(`--${k}=${s}`); else argv.push(`--${k}`, s);
  }
  return argv;
}

export function parseResultLine(line) {
  const s = String(line || '').trim();
  const sp = s.indexOf(' ');
  const status = sp === -1 ? s : s.slice(0, sp);
  const fields = {};
  for (const m of s.matchAll(/(?:^|\s)([A-Za-z_][\w.-]*)=(\S+)/g)) fields[m[1]] = m[2];
  return { status, fields };
}

async function run(fn, args) {
  const lines = [];
  const io = { out: (l) => { lines.push(String(l)); }, env: process.env, readStdin: null };
  try {
    const rc = await fn(args, io);
    const code = Number.isInteger(rc) ? rc : 0;
    const head = lines.find((l) => l.trim()) || '';
    return { code, ...parseResultLine(head), lines };
  } catch (e) {
    if (e && e.name === 'CliError') return { code: Number.isInteger(e.exitCode) ? e.exitCode : 9, status: 'ERROR', fields: {}, lines, error: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- admin (user-side) commands

// admin(sub, params, positional) -> result. `sub` is any ADMIN_COMMANDS key (init, add-seat, task,
// start, cancel, ..., show, log). Pass --dir or --id inside params. Queued commands return QUEUED
// and take effect on the service's next tick.
export async function admin(sub, params = {}, positional = []) {
  const { ADMIN_COMMANDS } = await import('./admin.mjs');
  const fn = ADMIN_COMMANDS[sub];
  if (!fn) return { code: 9, status: 'ERROR', fields: {}, lines: [], error: `unknown admin command ${sub}` };
  const argv = [sub, ...positional.map(String), ...toArgv(params)];
  const args = parseArgs(argv);
  args.__argv = argv;
  return run(fn, args);
}

// createRoom({id | dir, preset, wall, ...}) -> {roomDir, ...result}
export async function createRoom(params) {
  const r = await admin('init', params);
  return { ...r, roomDir: r.fields.dir ? path.resolve(r.fields.dir) : null };
}

// addSeat({dir, seat, role, agent, wait, cwd, hosted, surface, tier, reviews, audit, 'thread-id', 'session-id', 'wake-thread', name}) -> result
//   surface: 'tool:<model-visible tool name>' for a host conversation that acts only through that tool (INTERFACES §5a)
// The service must not be running (the CLI rule); add seats before openRoom().
export async function addSeat(params) {
  const r = await admin('add-seat', params);
  const join = r.lines.map((l) => /^JOIN (.+)$/.exec(l)).find(Boolean);
  return { ...r, joinPath: join ? path.resolve(join[1]) : null };
}

// ---------------------------------------------------------------- seat-side commands

// `TURN attempt=<id> nonce=<n> packet=<path> sha256=<hex>`: the packet path is the one field that
// can contain spaces (a rooms root under C:\Users\First Last), so parseResultLine's whitespace split
// would cut it. Every other field is a token and sha256 closes the line, so the path is everything
// between ` packet=` and the final ` sha256=`.
export function turnPacketPath(line) {
  const m = / packet=(.+?) sha256=(\S+)\s*$/.exec(String(line || ''));
  return m ? m[1] : null;
}

// seatClient({roomDir, seatId}) -> methods for one seat. A host that is itself a seat (a PI
// conversation) uses this; so do tests. Speech text is written into the seat's own outbox under
// drafts/ (the only place a seat writes) and submitted from there.
export function seatClient({ roomDir, seatId }) {
  const seatDir = path.join(path.resolve(roomDir), F.seats, seatId);
  const seat = readJson(path.join(seatDir, 'seat.json'));
  async function cmd(name, params = {}, positional = []) {
    const { SEAT_COMMANDS } = await import('./seat.mjs');
    const fn = SEAT_COMMANDS[name];
    if (!fn) return { code: 9, status: 'ERROR', fields: {}, lines: [], error: `unknown seat command ${name}` };
    const argv = [...positional.map(String), ...toArgv({ seat: seatDir, ...params })];
    const args = parseArgs(argv);
    args.__argv = argv;
    return run(fn, args);
  }
  function draft(text) {
    const dir = path.join(seat.outbox, 'drafts');
    const g = createGuard({ allowed: [seat.outbox], logPath: path.join(seat.outbox, O.writeLog), who: `seat:${seatId}` });
    g.mkdir(dir);
    const p = path.join(dir, `${Date.now()}-${randomHex(3)}.md`);
    g.writeFile(p, String(text));
    return p;
  }
  return {
    seatId, seatDir, seat,
    cmd,
    // wait({timeoutSec, once}) -> TURN (fields: attempt, nonce, packet, sha256) | TURN_OVER | NOT_YOUR_TURN | ...
    // fields.packet is the whole path, spaces included (turnPacketPath).
    wait: async ({ timeoutSec, once } = {}) => {
      const r = await cmd('wait', { timeout: timeoutSec, once: once === true });
      if (r.status === 'TURN') {
        const p = turnPacketPath(r.lines.find((l) => l.trim().startsWith('TURN ')));
        if (p) r.fields.packet = p;
      }
      return r;
    },
    status: ({ log = false, whoami = false } = {}) => cmd('status', { log, whoami }),
    submit: ({ attemptId, text, file }) => cmd('submit', { attempt: attemptId, file: file || draft(text) }),
    leave: () => cmd('leave'),
    pass: ({ attemptId }) => cmd('pass', { attempt: attemptId }),
    point: ({ attemptId, seq, text }) => cmd('point', { attempt: attemptId, seq, text }),
    quote: ({ attemptId, seq, text }) => cmd('quote', { attempt: attemptId, seq, text }),
    mark: ({ attemptId, item, status, text }) => cmd('mark', { attempt: attemptId, item, status, text }),
    misquoted: ({ attemptId, seq, text }) => cmd('misquoted', { attempt: attemptId, seq, text }),
    verdict: ({ attemptId, value, artifact, text }) => cmd('verdict', { attempt: attemptId, artifact, text }, [value]),
    disclose: ({ attemptId, argv, reason }) => cmd('disclose', { attempt: attemptId, arg: argv, reason }),
    assign: ({ attemptId, text, file }) => cmd('assign', { attempt: attemptId, file: file || draft(text) }),
    artifacts: ({ attemptId, paths, baseline, exclude }) => cmd('artifacts', { attempt: attemptId, baseline, exclude, declare: paths }),
    readPacket: (packetPath) => fs.readFileSync(packetPath, 'utf8'),
  };
}

// ---------------------------------------------------------------- running a room in-process

// openRoom({roomDir, tickMs, port, hostedProviders, piProvider, piApiKey, log}) -> handle
// Starts the room service in this process (the same createRoomService `serve` uses), ticks it on a
// timer, keeps service.lock's heartbeat fresh, and optionally serves the loopback UI. close() stops
// the loop, the HTTP server and the service (which removes service.lock).
export async function openRoom({ roomDir, tickMs = 400, port, log = () => {}, ...rest }) {
  const { createRoomService } = await import('./service.mjs');
  const svc = createRoomService({ roomDir, log, ...rest });
  let http = null;
  if (port !== undefined && port !== null && port !== false) {
    const { startHttp } = await import('./http.mjs');
    http = await startHttp({ service: svc, port: Number(port), log });
  }
  let stopped = false;
  let timer = null;
  let running = Promise.resolve();
  const hb = setInterval(() => { try { svc.heartbeat(); } catch { /* next beat */ } }, LOCK_HEARTBEAT_MS);
  if (hb.unref) hb.unref();
  const loop = () => {
    if (stopped) return;
    running = Promise.resolve()
      .then(() => svc.tick())
      .catch((e) => log(`[room] tick failed: ${e && (e.code || e.message)}; retrying next tick`))
      .then(() => { if (!stopped && !svc.state.closed) { timer = setTimeout(loop, tickMs); if (timer.unref) timer.unref(); } });
  };
  loop();
  return {
    roomDir: svc.roomDir,
    service: svc,
    url: http ? http.url : null,
    adminToken: svc.adminToken,
    view: () => svc.view(),
    events: (since = 0) => svc.events.filter((e) => typeof e.seq === 'number' && e.seq > since),
    // admin(cmd, params): straight to the running service (same handlers as admin-queue records).
    admin: (cmd, params = {}) => svc.admin({ cmd, ...params }),
    tickNow: () => svc.tick(),
    get closed() { return stopped || svc.state.closed; },
    async close() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(hb);
      await running;
      if (http) await http.close();
      await svc.close();
    },
  };
}
