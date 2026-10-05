// The lobby (启动圆桌): a loopback page where the user creates rooms and seats, gets the one sentence
// to say to each agent, opens a room's UI and gives it a task, without typing CLI commands (plan
// §1.8: 双击启动器, 在 UI 里给席位起名、选职责、选等待方式).
//
//   GET  /, /lobby.js, /lobby.css           ui/lobby.html, ui/lobby.js, ui/lobby.css (fixed list)
//   GET  /lobby/api/meta                    presets, roles, agent kinds, wait modes, rooms root
//   GET  /lobby/api/rooms                   rooms under roomsRoot (no token in the answer)
//   GET  /lobby/api/seat-defaults?id=&seat= suggested seat folder %USERPROFILE%\room-seats\<id>-<seat>
//   GET  /lobby/api/folder?path=<abs>       {exists, isDir} of one absolute path (read-only), so the
//                                           page can untick 替我新建这个空文件夹 for an existing folder
//   POST /lobby/api/create {token, id, preset, seats:[...]}   createRoom + addSeat (lib/api.mjs)
//   POST /lobby/api/open   {token, id}       api.openRoom({roomDir, port: 0}) in this process
//   POST /lobby/api/stop   {token, id}       close that handle
//   POST /lobby/api/task   {token, id, text} handle.admin('task')
//   POST /lobby/api/start  {token, id, order} handle.admin('start')
//
// Same gate as lib/http.mjs: 127.0.0.1 only, Host/Origin/Sec-Fetch-Site checked on every request,
// same security headers, JSON bodies capped at MAX_BODY_BYTES, no query string on a POST. The lobby
// token is random per launch; it travels in the URL fragment of the one printed URL and in POST
// bodies, never in a query string, a header or a log line. GET answers carry no secret: a room UI url
// with its admin token comes back only from POST /lobby/api/open.
//
// Room and seat writes go through lib/api.mjs createRoom / addSeat, i.e. the same functions as
// `room admin init` / `admin add-seat`, with every CLI rule. The only thing the lobby writes itself:
// an empty new seat folder when the user ticked 替我新建这个空文件夹 (createCwd), after the location
// checks below, and the removal of what one failed create request made (its room directory and the
// empty folders it created), so a refused create leaves nothing behind.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHostOrigin, tokenEquals, send, jsonBody, UI_DIR } from './http.mjs';
import { defaultRoomsRoot, randomHex, readJson, fwd, roomMjsPath, lockHolderAlive, ROOM_FILES as F, virtualizationRedirect } from './common.mjs';
import { createRoom, addSeat, openRoom } from './api.mjs';
import { PRESETS, ROLES, WAIT_MODES, HOSTED_TIERS, realOf, insideReal, repoRootOf, locationProblem, winNameProblem } from './admin.mjs';
import { AGENT_KINDS, AGENT_KIND_NAMES, cmdPath, seatCommandPrefix } from './join.mjs';
import { codexHome } from './codex.mjs';
import { spawnClean } from './spawn.mjs';

export const DEFAULT_LOBBY_PORT = 7380;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_SEATS = 12;
const PENDING_NOTE = /^提示（建房完成前需解决）：/;

const STATIC = Object.freeze({
  '/': ['lobby.html', 'text/html; charset=utf-8'],
  '/lobby.html': ['lobby.html', 'text/html; charset=utf-8'],
  '/lobby.js': ['lobby.js', 'text/javascript; charset=utf-8'],
  '/lobby.css': ['lobby.css', 'text/css; charset=utf-8'],
});

export const PRESET_INFO = Object.freeze({
  'implement-review': '实现→审查：执行者干活并冻结产物，主力兼审方开会、逐条标注、给 verdict（Work → Meet → Summary）。',
  discussion: '讨论：只开会和汇总，没有干活阶段（Meet → Summary）。',
  report: '汇报会：带产物的席位先声明产物，再开会、汇总（Meet → Summary）。',
  'cross-check': '材料交叉核对：各席位读指定资料，开会互相核对（Meet → Summary）。',
  division: '分工后开会：主力先起草任务单，你确认后执行者分头干活，再开会审查（Assign → Work → Meet → Summary）。',
  simplified: '简化版：你的一个 agent 加一个房间内置 Pi 席位（agent 选「房间内置 Pi」，默认只讨论；启动房间前用 ROOM_PI_API_KEY 或 admin pi-key --save 准备好 key）。',
});
export const ROLE_INFO = Object.freeze({ lead: '主力（开题、汇总、审查）', executor: '执行者（干活、交产物）', reviewer: '审方（只给 verdict）', participant: '参与者（只发言）' });
export const WAIT_INFO = Object.freeze({ background: '后台等待（Claude Code 推荐）', turn_over: '交卷即退（Codex 推荐，靠唤醒推送）', manual: '手动（你提醒它）' });
export const HOSTED_INFO = Object.freeze({ discussion: '只讨论（不用工具）', exec: '执行（在工作文件夹里读写，高危操作要你批准）', reviewer: '审方（只读工具）' });
const CODEX_AGENTS = new Set(['codex-desktop', 'codex-cli']);

// Suggested seat folder: outside AppData, outside any repository the room could sit in.
export function suggestedSeatCwd(roomId, seatId, home = os.homedir()) {
  return path.join(home, 'room-seats', `${roomId}-${seatId}`);
}

// Default Codex thread name for a seat: unique per room, since the wake push finds the thread by
// name in CODEX_HOME/session_index.jsonl (lib/service.mjs resolveCodexThread).
export function defaultWakeThread(roomId, seatId) { return `room-${roomId}-${seatId}`; }

export function joinSentence(joinPath) { return `读 ${path.resolve(joinPath)}，按它入席。`; }

// The agent-specific line shown under the sentence on each 入席 card. `prefix` is the seat's command
// prefix (lib/join.mjs seatCommandPrefix): `node <room.mjs>`, or the seat's room.cmd for a seat that
// runs on the desktop app's own runtime.
export function seatHint({ agent, cwd, wakeThread, hosted, prefix = `node ${cmdPath(roomMjsPath())}` }) {
  if (hosted) return '这个席位由房间内置 Pi 托管，不需要发给任何 agent；启动房间前用 ROOM_PI_API_KEY 或 admin pi-key --save 准备好 key。';
  const dir = path.resolve(cwd);
  const rule = `Bash(${prefix}:*)`;
  switch (agent) {
    case 'codex-desktop':
      return `在 Codex Desktop 里新建一个线程，项目文件夹选 ${dir}，沙箱用 workspace-write；${wakeThread ? `把线程重命名为「${wakeThread}」（名字要和别的线程都不一样：轮到它时房间在 Codex 的线程索引里按这个名字找到它并推送提醒），` : '没有登记线程名，轮到它时要你自己提醒它；'}然后把上面这句话发给它。`;
    case 'codex-cli':
      return `在 ${dir} 里启动 Codex CLI（workspace-write），把上面这句话发给它；弹审批时只放行 ${prefix} 这一个命令前缀。${wakeThread ? `线程名登记为「${wakeThread}」。` : ''}`;
    case 'claude-code':
      return `在 ${dir} 里新开一个 Claude Code 会话，把上面这句话发给它；第一次运行 room 命令弹权限提示时，只允许 JOIN.md 里写的这一条规则：${rule}`;
    default: {
      const label = (AGENT_KINDS[agent] || AGENT_KINDS.generic).label;
      return `在 ${dir} 里打开 ${label}，把上面这句话发给它；弹权限提示时只放行 ${prefix} 这一个命令前缀。`;
    }
  }
}

function claudeConfigHome(env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function realAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
  return cur;
}
// The topmost folder on the way to `p` that does not exist yet (`p` itself when its parent exists):
// what a recursive mkdir of `p` creates first, and the highest folder its undo may remove.
function firstMissing(p) {
  let cur = path.resolve(p);
  for (;;) {
    const parent = path.dirname(cur);
    if (parent === cur || fs.existsSync(parent)) return cur;
    cur = parent;
  }
}
// Path equality as Windows sees it: without a \\?\ (or \\?\UNC\) prefix, case-insensitive on win32.
function plainPath(p) {
  const s = String(p || '');
  if (/^\\\\\?\\UNC\\/i.test(s)) return `\\\\${s.slice(8)}`;
  return s.replace(/^\\\\\?\\/, '');
}
export function samePath(a, b, platform = process.platform) {
  if (!a || !b) return false;
  const x = path.resolve(plainPath(a));
  const y = path.resolve(plainPath(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// Chinese refusal when the lobby must not create `cwd` for a seat of the room at `roomDir`, else
// null. Checked before anything is created; add-seat then applies the full CLI rules on top.
export function seatFolderProblem(cwd, { roomDir, roomsRoot, env = process.env, redirect = virtualizationRedirect, home = os.homedir(), platform = process.platform } = {}) {
  if (!path.isAbsolute(cwd)) return `工作文件夹 ${cwd} 要写完整的绝对路径（例如 ${fwd(suggestedSeatCwd('demo', 'A'))}）。`;
  // Before the AppData check: `AppData.` or `AppData ` passes a literal comparison, but a Windows
  // program opening the path lands in AppData.
  const badName = winNameProblem(cwd, { platform });
  if (badName) return badName;
  const appData = [env.LOCALAPPDATA, env.APPDATA, path.join(home, 'AppData')].filter(Boolean);
  for (const a of appData) {
    if (insideReal(cwd, a)) return `工作文件夹 ${fwd(cwd)} 在 AppData（${fwd(a)}）下：从 MSIX 打包应用里起的进程写那里会被重定向，别的 agent 看不到。请换到用户目录下（例如 ${fwd(path.join(home, 'room-seats'))}）。`;
  }
  const early = locationProblem(realAncestor(cwd), { redirect, what: '工作文件夹所在的目录' });
  if (early) return early;
  for (const [label, home] of [['CODEX_HOME', codexHome(env)], ['CLAUDE_CONFIG_DIR', claudeConfigHome(env)]]) {
    if (insideReal(cwd, home) || insideReal(home, cwd)) return `工作文件夹不能在 ${label}（${fwd(home)}）之内，也不能包含它：那是 agent 自己的共享状态。`;
  }
  for (const d of [roomsRoot, roomDir].filter(Boolean)) {
    if (insideReal(cwd, d) || insideReal(d, cwd)) return `工作文件夹 ${fwd(cwd)} 和房间目录 ${fwd(d)} 不能互相包含。`;
  }
  const repo = repoRootOf(cwd);
  if (repo && roomDir && insideReal(roomDir, repo)) return `工作文件夹 ${fwd(cwd)} 所属的 git 仓库 ${fwd(repo)} 包含了房间目录；房间不能在任何仓库之内。`;
  return null;
}

function refusal(status, error, message) { return { status, body: { ok: false, error, message } }; }
class LobbyRefusal extends Error {
  constructor(error, message, status = 400) { super(message); this.error = error; this.status = status; }
}

// Opens `url` in the default browser. Windows: rundll32 url.dll,FileProtocolHandler keeps the
// fragment (cmd's start and explorer.exe can drop it). Through lib/spawn.mjs like every child.
export async function openInBrowser(url, { spawn = spawnClean, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    return spawn(path.join(sysRoot, 'System32', 'rundll32.exe'), ['url.dll,FileProtocolHandler', url], { timeoutMs: 15_000, maxOutputBytes: 4096 });
  }
  return spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeoutMs: 15_000, maxOutputBytes: 4096 });
}

// Port number of a loopback url such as http://127.0.0.1:51234/, or null.
export function portOfUrl(url) {
  try { const u = new URL(url); const p = Number(u.port); return Number.isInteger(p) && p > 0 ? p : null; } catch { return null; }
}

// startLobby({port, roomsRoot, log, openBrowser, parentPort, exit}) -> Promise<{url, port, token, close()}>
//
// Inside the desktop app the lobby runs in an Electron utilityProcess (app/main.mjs), where
// process.parentPort exists. Then the lobby (a) tells the app about every room UI it opens or stops,
// {t: 'room-opened' | 'room-closed', id, port} (no token), so the app opens only those ports as room
// windows; (b) on {t: 'quit'} closes every room it opened (removing their service.lock) and exits 0.
// `parentPort` and `exit` are injectable for tests; the CLI (no parentPort) behaves as before.
export async function startLobby({ port = DEFAULT_LOBBY_PORT, roomsRoot = defaultRoomsRoot(), log = () => {}, openBrowser = false, env = process.env, redirect = virtualizationRedirect, uiDir = UI_DIR, parentPort = process.parentPort, exit = (code) => process.exit(code) } = {}) {
  const root = path.resolve(roomsRoot);
  const token = randomHex(24);
  const handles = new Map(); // roomId -> openRoom handle
  let boundPort = 0;
  let closing = false;
  const parent = parentPort && typeof parentPort.on === 'function' ? parentPort : null;
  const notify = (msg) => {
    if (!parent || typeof parent.postMessage !== 'function') return;
    try { parent.postMessage(msg); } catch (e) { log(`[lobby] could not notify the app: ${e && e.message}`); }
  };
  // Every mutating request runs one at a time: two creates of the same id, or an open racing a stop,
  // never interleave.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const roomDirOf = (id) => path.join(root, id);
  const roomUrl = (h) => (h && h.url ? h.url : null);

  const prefixOf = (roomDir, s) => seatCommandPrefix({ seat: s, seatDir: path.join(roomDir, F.seats, s.seatId), roomMjs: roomMjsPath() });
  function seatView(roomDir, s) {
    const joinPath = path.join(roomDir, F.seats, s.seatId, 'JOIN.md');
    return {
      seatId: s.seatId, role: s.role, agent: s.agent, cwd: s.cwd, waitMode: s.waitMode,
      wakeThread: s.wake && s.wake.enabled ? s.wake.thread : null,
      hosted: s.hosted ? (s.hosted.kind === 'lane' ? `lane:${s.hosted.lane}:${s.hosted.tier}` : `pi:${s.hosted.tier}`) : null,
      joinPath,
      sentence: s.hosted ? null : joinSentence(joinPath),
      hint: seatHint({ agent: s.agent, cwd: s.cwd, wakeThread: s.wake && s.wake.enabled ? s.wake.thread : null, hosted: !!s.hosted, prefix: prefixOf(roomDir, s) }),
    };
  }

  function listRooms() {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name); } catch { names = []; }
    const rooms = [];
    for (const id of names) {
      const roomDir = roomDirOf(id);
      const room = readJson(path.join(roomDir, F.room), null);
      if (!room || typeof room !== 'object') continue;
      const h = handles.get(id);
      let st = null;
      if (h) { try { st = h.view(); } catch { st = null; } }
      if (!st) st = readJson(path.join(roomDir, F.state), null);
      const lock = readJson(path.join(roomDir, F.lock), null);
      // `id` is the directory name: open / stop / task / start and `handles` all resolve rooms by it.
      // room.json's own id (admin init --dir <root>\foo --id bar is allowed) is shown, not used.
      rooms.push({
        id,
        roomId: typeof room.id === 'string' ? room.id : null,
        idMismatch: typeof room.id === 'string' && room.id !== id,
        createdAt: room.createdAt || null,
        preset: room.preset || null,
        phase: st && st.phase ? st.phase : 'idle',
        roundId: st && Number.isInteger(st.roundId) ? st.roundId : 0,
        closed: !!(st && st.closed),
        currentSeat: st && st.currentSeat ? st.currentSeat : null,
        task: st && st.task && typeof st.task.text === 'string' ? st.task.text : null,
        seats: (Array.isArray(room.seats) ? room.seats : []).map((s) => seatView(roomDir, s)),
        serviceRunning: lockHolderAlive(lock),
        openedHere: !!h,
        url: h ? roomUrl(h) : null,
      });
    }
    rooms.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return rooms;
  }

  // ---- create: validate everything first, then createRoom + addSeat; undo on any failure.
  function parseSeats(seats, roomId) {
    if (!Array.isArray(seats) || !seats.length) throw new LobbyRefusal('NO_SEATS', '至少要有一个席位。');
    if (seats.length > MAX_SEATS) throw new LobbyRefusal('TOO_MANY_SEATS', `一个房间最多 ${MAX_SEATS} 个席位。`);
    const seen = new Set();
    return seats.map((raw, i) => {
      const s = raw && typeof raw === 'object' ? raw : {};
      const seatId = typeof s.seatId === 'string' ? s.seatId.trim() : '';
      if (!ID_RE.test(seatId)) throw new LobbyRefusal('BAD_SEAT_ID', `第 ${i + 1} 个席位的编号「${seatId}」不合法：只能用字母、数字、- 和 _。`);
      if (seen.has(seatId.toLowerCase())) throw new LobbyRefusal('SEAT_ID_DUPLICATE', `席位编号 ${seatId} 重复了。`);
      seen.add(seatId.toLowerCase());
      const role = typeof s.role === 'string' ? s.role : 'participant';
      if (!ROLES.includes(role)) throw new LobbyRefusal('BAD_ROLE', `席位 ${seatId} 的职责「${role}」不认识；可选：${ROLES.join('、')}。`);
      const hosted = typeof s.hosted === 'string' && s.hosted.trim() ? s.hosted.trim() : null;
      const agent = typeof s.agent === 'string' && s.agent ? s.agent : 'generic';
      if (!hosted && !AGENT_KIND_NAMES.includes(agent)) throw new LobbyRefusal('BAD_AGENT', `席位 ${seatId} 的 agent「${agent}」不认识；可选：${AGENT_KIND_NAMES.join('、')}。`);
      const wait = typeof s.wait === 'string' && s.wait ? s.wait : null;
      if (wait && !WAIT_MODES.includes(wait)) throw new LobbyRefusal('BAD_WAIT', `席位 ${seatId} 的等待方式「${wait}」不认识；可选：${WAIT_MODES.join('、')}。`);
      const cwdRaw = typeof s.cwd === 'string' ? s.cwd.trim() : '';
      if (!cwdRaw) throw new LobbyRefusal('NO_CWD', `席位 ${seatId} 没填工作文件夹。`);
      if (!path.isAbsolute(cwdRaw)) throw new LobbyRefusal('CWD_NOT_ABSOLUTE', `席位 ${seatId} 的工作文件夹要写完整的绝对路径：${cwdRaw}`);
      const cwd = path.resolve(cwdRaw);
      const badName = winNameProblem(cwd);
      if (badName) throw new LobbyRefusal('CWD_BAD_NAME', `席位 ${seatId} 的工作文件夹不能用：${badName}`);
      const createCwd = s.createCwd === true;
      let wakeThread = null;
      if (!hosted && CODEX_AGENTS.has(agent)) {
        // The default name carries the room id: every lobby room has a seat A, and the wake push
        // resolves the name through Codex's thread index, where it has to be unique.
        if (s.wakeThread === undefined || s.wakeThread === null) wakeThread = defaultWakeThread(roomId, seatId);
        else if (typeof s.wakeThread === 'string') wakeThread = s.wakeThread.trim() || null;
        if (wakeThread && (wakeThread.length > 128 || /[\x00-\x1f"]/.test(wakeThread))) throw new LobbyRefusal('BAD_WAKE_THREAD', `席位 ${seatId} 的 Codex 线程名不合法（不超过 128 个字符，不含引号和控制字符）。`);
      }
      return { seatId, role, agent, hosted, wait, cwd, createCwd, wakeThread };
    });
  }

  async function create(body) {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!ID_RE.test(id)) throw new LobbyRefusal('BAD_ID', `房间编号「${id}」不合法：只能用字母、数字、- 和 _。`);
    const preset = typeof body.preset === 'string' && body.preset ? body.preset : null;
    if (preset && !PRESETS.includes(preset)) throw new LobbyRefusal('BAD_PRESET', `预设「${preset}」不认识；可选：${PRESETS.join('、')}。`);
    const seats = parseSeats(body.seats, id);
    const roomDir = roomDirOf(id);
    if (fs.existsSync(roomDir)) throw new LobbyRefusal('ROOM_EXISTS', `房间 ${id} 已经存在（${fwd(roomDir)}）。换一个编号，或在房间列表里打开它。`, 409);
    const cwdKeys = new Map();
    for (const s of seats) {
      if (s.createCwd) {
        if (fs.existsSync(s.cwd)) throw new LobbyRefusal('CWD_EXISTS', `席位 ${s.seatId} 的工作文件夹 ${fwd(s.cwd)} 已经存在；启动器只新建不存在的空文件夹。取消勾选「替我新建这个空文件夹」就直接用它。`);
        const key = realOf(s.cwd).toLowerCase();
        if (cwdKeys.has(key)) throw new LobbyRefusal('CWD_DUPLICATE', `席位 ${cwdKeys.get(key)} 和 ${s.seatId} 要新建同一个文件夹 ${fwd(s.cwd)}。`);
        cwdKeys.set(key, s.seatId);
        const problem = seatFolderProblem(s.cwd, { roomDir, roomsRoot: root, env, redirect });
        if (problem) throw new LobbyRefusal('CWD_LOCATION', `席位 ${s.seatId}：${problem}`);
      } else if (!fs.existsSync(s.cwd)) {
        throw new LobbyRefusal('CWD_MISSING', `席位 ${s.seatId} 的工作文件夹 ${fwd(s.cwd)} 不存在。先自己建好它，或勾选「替我新建这个空文件夹」。`);
      } else if (!fs.statSync(s.cwd).isDirectory()) {
        throw new LobbyRefusal('CWD_NOT_DIR', `席位 ${s.seatId} 的工作文件夹 ${fwd(s.cwd)} 不是文件夹。`);
      }
    }

    const made = []; // {leaf, first}: folders this request may have created, removed again on failure
    let roomMade = false;
    const undo = () => {
      if (roomMade) { try { fs.rmSync(roomDir, { recursive: true, force: true }); } catch (e) { log(`[lobby] could not remove ${fwd(roomDir)}: ${e.code || e.message}`); } }
      for (const m of made.reverse()) {
        // Only empty folders, from the leaf up to and including `first` (the topmost folder that did
        // not exist before this request), never above it. A folder a failed mkdir never made (ENOENT)
        // is stepped over, so the parents it did make are still removed.
        let cur = path.resolve(m.leaf);
        for (;;) {
          try { fs.rmdirSync(cur); } catch (e) { if (!e || e.code !== 'ENOENT') break; }
          if (samePath(cur, m.first)) break;
          const parent = path.dirname(cur);
          if (parent === cur) break;
          cur = parent;
        }
      }
    };
    const out = [];
    let pending = [];
    try {
      roomMade = true; // the directory did not exist a moment ago; whatever is there now is ours
      const init = await createRoom({ dir: roomDir, id, ...(preset ? { preset } : {}) });
      if (init.code !== 0) throw new LobbyRefusal('INIT_REFUSED', `建房被拒绝：${init.error || init.lines.join(' ')}`);
      for (const s of seats) {
        if (s.createCwd) {
          // Recorded before mkdir, from plain existence checks: mkdirSync's own return value carries
          // a \\?\ prefix on Windows and is missing when mkdir throws halfway.
          made.push({ leaf: s.cwd, first: firstMissing(s.cwd) });
          try { fs.mkdirSync(s.cwd, { recursive: true }); } catch (e) {
            throw new LobbyRefusal('CWD_CREATE_FAILED', `席位 ${s.seatId} 的工作文件夹 ${fwd(s.cwd)} 没能新建（${e && (e.code || e.message)}）。换一个位置，或先自己建好它再取消勾选「替我新建这个空文件夹」。`);
          }
          const after = locationProblem(s.cwd, { redirect, what: '新建的工作文件夹' });
          if (after) throw new LobbyRefusal('CWD_LOCATION', `席位 ${s.seatId}：${after}`);
        }
        // Claude Code seats register the transcript baseline the auditor needs (read-only). A codex
        // audit needs the thread uuid, which nobody knows yet; `admin set-audit` adds it later.
        const audit = !s.hosted && s.agent === 'claude-code' ? 'claude' : null;
        const r = await addSeat({
          dir: roomDir, seat: s.seatId, role: s.role, cwd: s.cwd,
          ...(s.hosted ? { hosted: s.hosted } : { agent: s.agent }),
          ...(s.wait ? { wait: s.wait } : {}),
          ...(s.wakeThread ? { 'wake-thread': s.wakeThread } : {}),
          ...(audit ? { audit } : {}),
        });
        if (r.code !== 0 || !r.joinPath) throw new LobbyRefusal('SEAT_REFUSED', `席位 ${s.seatId} 没建成：${r.error || r.lines.join(' ')}`);
        // add-seat's 「建房完成前需解决」 lines describe the room so far; only the last seat's are final.
        const notes = r.lines.filter((l) => /^提示/.test(l) && !PENDING_NOTE.test(l));
        pending = r.lines.filter((l) => PENDING_NOTE.test(l)).map((l) => l.replace(PENDING_NOTE, ''));
        // The seat record says whether it runs on node or on the app's runtime (lib/join.mjs).
        const rec = readJson(path.join(path.dirname(r.joinPath), 'seat.json'), {}) || {};
        out.push({ ...s, joinPath: r.joinPath, sentence: s.hosted ? null : joinSentence(r.joinPath), hint: seatHint({ ...s, hosted: !!s.hosted, prefix: prefixOf(roomDir, { ...rec, seatId: s.seatId }) }), notes, createdCwd: s.createCwd });
      }
    } catch (e) {
      undo();
      throw e;
    }
    log(`[lobby] room ${id} created with ${out.length} seat(s) at ${fwd(roomDir)}`);
    return { ok: true, id, roomDir, preset, roomNotes: pending, seats: out.map(({ seatId, role, agent, hosted, cwd, wakeThread, joinPath, sentence, hint, notes, createdCwd }) => ({ seatId, role, agent, hosted, cwd, wakeThread, joinPath, sentence, hint, notes, createdCwd })) };
  }

  function knownRoom(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new LobbyRefusal('BAD_ID', '房间编号不合法。');
    const roomDir = roomDirOf(id);
    if (!fs.existsSync(path.join(roomDir, F.room))) throw new LobbyRefusal('NO_ROOM', `没有房间 ${id}（${fwd(roomDir)}）。`, 404);
    return roomDir;
  }
  function openHandle(id) {
    const h = handles.get(id);
    if (!h) throw new LobbyRefusal('NOT_OPEN', `房间 ${id} 不是由这个启动器打开的；先点「打开房间界面」。`, 409);
    return h;
  }

  async function open(body) {
    const id = body.id;
    const roomDir = knownRoom(id);
    const existing = handles.get(id);
    if (existing) return { ok: true, id, url: `${roomUrl(existing)}#${existing.adminToken}`, already: true };
    const lock = readJson(path.join(roomDir, F.lock), null);
    let lockProbe;
    if (lockHolderAlive(lock)) {
      if (lock.pid === process.pid) throw new LobbyRefusal('SERVICE_RUNNING', `房间 ${id} 的服务已经在本进程的别处运行，启动器不再打开第二个。`, 409);
      const { probeLockHolder } = await import('./service.mjs');
      lockProbe = await probeLockHolder(lock);
      if (lockProbe !== 'stale') throw new LobbyRefusal('SERVICE_RUNNING', `房间 ${id} 的服务已经在别处运行（pid ${lock.pid}）。请到那个窗口里用它，或先关掉它再从这里打开。`, 409);
    }
    let h;
    try {
      h = await openRoom({ roomDir, port: 0, log: (l) => log(`[room ${id}] ${l}`), ...(lockProbe ? { lockProbe } : {}) });
    } catch (e) {
      if (e && e.code === 'SERVICE_RUNNING') throw new LobbyRefusal('SERVICE_RUNNING', e.message, 409);
      throw new LobbyRefusal('OPEN_FAILED', `房间 ${id} 没能打开：${e && e.message ? e.message : e}`, 500);
    }
    if (closing) { await h.close(); throw new LobbyRefusal('CLOSING', '启动器正在退出。', 503); }
    handles.set(id, h);
    log(`[lobby] room ${id} opened; UI on ${h.url}`);
    notify({ t: 'room-opened', id, port: portOfUrl(h.url) });
    return { ok: true, id, url: `${h.url}#${h.adminToken}` };
  }

  async function stop(body) {
    const id = body.id;
    knownRoom(id);
    const h = openHandle(id);
    handles.delete(id);
    await h.close();
    log(`[lobby] room ${id} stopped`);
    notify({ t: 'room-closed', id, port: portOfUrl(h.url) });
    return { ok: true, id };
  }

  function adminResult(r, what) {
    if (r && r.ok === false) throw new LobbyRefusal(r.error || 'REFUSED', `${what}被房间拒绝：${r.message || r.error}`, 409);
    return { ok: true, ...(r && typeof r === 'object' ? r : {}) };
  }
  async function task(body) {
    const id = body.id;
    knownRoom(id);
    const h = openHandle(id);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new LobbyRefusal('NO_TEXT', '任务不能是空的。');
    return { id, ...adminResult(await h.admin('task', { text }), '任务') };
  }
  async function start(body) {
    const id = body.id;
    knownRoom(id);
    const h = openHandle(id);
    let order;
    if (body.order !== undefined && body.order !== null) {
      if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== 'string' || !ID_RE.test(x))) throw new LobbyRefusal('BAD_ORDER', '发言顺序要是席位编号的列表。');
      const known = new Set((h.service.room.seats || []).map((s) => s.seatId));
      const unknown = body.order.filter((x) => !known.has(x));
      if (unknown.length) throw new LobbyRefusal('BAD_ORDER', `发言顺序里有不存在的席位：${unknown.join('、')}。`);
      order = body.order.slice();
    }
    return { id, ...adminResult(await h.admin('start', order && order.length ? { order } : {}), '开始') };
  }

  const POSTS = { create, open, stop, task, start };

  function meta() {
    return {
      ok: true,
      roomsRoot: root,
      seatsRoot: path.join(os.homedir(), 'room-seats'),
      presets: PRESETS.map((id) => ({ id, desc: PRESET_INFO[id] || '' })),
      roles: ROLES.map((id) => ({ id, label: ROLE_INFO[id] || id })),
      agents: AGENT_KIND_NAMES.map((id) => ({ id, label: AGENT_KINDS[id].label, wait: AGENT_KINDS[id].wait })),
      waitModes: WAIT_MODES.map((id) => ({ id, label: WAIT_INFO[id] || id })),
      // Built-in Pi seat tiers; the page sends hosted: 'pi:<tier>' for a seat run by the room itself.
      hostedTiers: HOSTED_TIERS.map((id) => ({ id, label: HOSTED_INFO[id] || id })),
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const gate = checkHostOrigin(req.headers, boundPort);
      if (!gate.ok) { send(res, gate.status, { ok: false, error: gate.error }); return; }
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${boundPort}`); } catch { send(res, 400, { ok: false, error: 'BAD_URL' }); return; }
      const p = url.pathname;

      if (p.startsWith('/lobby/api/')) {
        const name = p.slice('/lobby/api/'.length);
        if (name === 'rooms' || name === 'meta' || name === 'seat-defaults' || name === 'folder') {
          if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
          if (name === 'rooms') { send(res, 200, { ok: true, roomsRoot: root, rooms: listRooms() }); return; }
          if (name === 'meta') { send(res, 200, meta()); return; }
          if (name === 'folder') {
            // Existence of one absolute path, nothing else: no listing, no content, no write.
            const p = url.searchParams.get('path') || '';
            if (!p || p.length > 1024 || !path.isAbsolute(p)) { send(res, 400, { ok: false, error: 'BAD_ARGS', message: '只查绝对路径。' }); return; }
            let st = null;
            try { st = fs.statSync(path.resolve(p)); } catch { st = null; }
            send(res, 200, { ok: true, exists: !!st, isDir: !!(st && st.isDirectory()) });
            return;
          }
          const id = url.searchParams.get('id') || '';
          const seat = url.searchParams.get('seat') || '';
          if (!ID_RE.test(id) || !ID_RE.test(seat)) { send(res, 400, { ok: false, error: 'BAD_ARGS', message: '房间编号和席位编号只能用字母、数字、- 和 _。' }); return; }
          const cwd = suggestedSeatCwd(id, seat);
          send(res, 200, { ok: true, cwd, exists: fs.existsSync(cwd) });
          return;
        }
        const fn = Object.prototype.hasOwnProperty.call(POSTS, name) ? POSTS[name] : null;
        if (!fn) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        const body = await jsonBody(req, res, url);
        if (!body) return;
        if (!tokenEquals(body.token, token)) {
          log(`[lobby] ${name} refused: bad or missing lobby token`);
          send(res, 401, { ok: false, error: 'BAD_TOKEN', message: '启动器令牌不对或缺失：请从启动器窗口打印的链接重新打开本页。' });
          return;
        }
        if (closing) { send(res, 503, { ok: false, error: 'CLOSING', message: '启动器正在退出。' }); return; }
        const { token: _drop, ...rest } = body;
        try {
          const r = await serial(() => fn(rest));
          send(res, 200, r);
        } catch (e) {
          if (e instanceof LobbyRefusal) { const x = refusal(e.status, e.error, e.message); send(res, x.status, x.body); return; }
          throw e;
        }
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      const f = Object.prototype.hasOwnProperty.call(STATIC, p) ? STATIC[p] : null;
      if (!f) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
      send(res, 200, fs.readFileSync(path.join(uiDir, f[0])), f[1]);
    } catch (e) {
      log(`[lobby] ${req.method} ${String(req.url || '').split('?')[0]}: ${e && e.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'INTERNAL', message: `启动器内部错误：${e && e.message}` });
    }
  });

  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  const wanted = Number(port);
  try {
    await listen(Number.isInteger(wanted) && wanted >= 0 ? wanted : DEFAULT_LOBBY_PORT);
  } catch (e) {
    if (!e || (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') || wanted === 0) throw e;
    log(`[lobby] port ${wanted} is busy (${e.code}); using a free port instead`);
    await listen(0);
  }
  boundPort = server.address().port;
  const base = `http://127.0.0.1:${boundPort}/`;
  const url = `${base}#${token}`;
  if (openBrowser) {
    openInBrowser(url).then((r) => { if (r && (r.spawnError || r.timedOut)) log('[lobby] could not open the browser; open the printed link by hand'); }, () => log('[lobby] could not open the browser; open the printed link by hand'));
  }

  let closed = null;
  let onParentMessage = null;
  const lobby = {
    url,
    base,
    port: boundPort,
    token,
    roomsRoot: root,
    handles,
    close() {
      if (closed) return closed;
      closing = true;
      closed = (async () => {
        await chain.catch(() => {});
        for (const [id, h] of [...handles]) {
          try { await h.close(); } catch (e) { log(`[lobby] closing room ${id}: ${e && e.message}`); }
          handles.delete(id);
          notify({ t: 'room-closed', id, port: portOfUrl(h.url) });
        }
        await new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); });
        if (parent && onParentMessage) {
          const off = parent.off || parent.removeListener;
          if (typeof off === 'function') off.call(parent, 'message', onParentMessage);
        }
      })();
      return closed;
    },
  };
  if (parent) {
    // Electron delivers {data, ports}; a plain emitter (tests) may deliver the message itself.
    onParentMessage = (e) => {
      const msg = e && typeof e === 'object' && 'data' in e ? e.data : e;
      if (!msg || typeof msg !== 'object' || msg.t !== 'quit') return;
      log('[lobby] quit requested by the app: stopping the rooms opened here');
      lobby.close().then(() => exit(0), (err) => { log(`[lobby] close failed: ${err && err.message}`); exit(1); });
    };
    parent.on('message', onParentMessage);
  }
  return lobby;
}
