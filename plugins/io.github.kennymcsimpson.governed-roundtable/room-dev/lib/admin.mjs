// Admin commands: run by the user in their own terminal (INTERFACES §1-§3, plan §8.1). They hold the
// admin token and write only the room directory, through the guard, so every write appears in
// write-log as who=admin. Commands that change a running room are queued as admin-queue/*.json
// ({cmd, ...params, token, ts}); the service executes them and moves them to admin-queue/done/.
//
// Every command returns an exit code (0 on success) and throws CliError for refusals and usage
// errors, so tests drive it in-process; room.mjs turns that into the process exit code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ROOM_FILES as F, nowIso, sha256, randomHex, readJson, readJsonl, fwd, isInside, appRoot, defaultRoomsRoot, roomMjsPath, realPathNative, virtualizationRedirect, lockHolderAlive } from './common.mjs';
import { createGuard } from './guard.mjs';
import { renderJoin, renderRoomCmd, AGENT_KIND_NAMES, defaultWaitMode, needsQuoting, seatRuntimeFor } from './join.mjs';
import { codexHome } from './codex.mjs';
import { CliError } from './seat.mjs';
import { validateRoom, DEFAULT_ALLOWLIST, readAdjudications, rejectRateSignal, reviewerSeats, reviewerAgentOf } from './supervision.mjs';
import { parseAssignDraft } from './structured.mjs';
import { accumulate, emptyUsage, formatUsage } from './usage.mjs';
import { loadTemplates } from './packet.mjs';
import { isCodexThreadId } from './audit.mjs';
import { savePiKey, forgetPiKey, piKeyStatus, savedPiKeyPath, validatePiKey } from './hosted/dpapi.mjs';
import { parseSurfaceArg } from './surface.mjs';

export const ROOM_SCHEMA_VERSION = 2;
export const PRESETS = Object.freeze(['implement-review', 'discussion', 'report', 'cross-check', 'division', 'simplified']);
export const ROLES = Object.freeze(['executor', 'reviewer', 'lead', 'participant']);
export const WAIT_MODES = Object.freeze(['background', 'turn_over', 'manual']);
export const TIERS = Object.freeze(['discussion', 'readonly', 'workspace', 'full']);
export const HOSTED_TIERS = Object.freeze(['discussion', 'exec', 'reviewer']);
export const DEFAULT_TIER_BY_ROLE = Object.freeze({ executor: 'workspace', reviewer: 'readonly', lead: 'readonly', participant: 'discussion' });
const PRIVATE_DIR = 'private';
const ID_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^[A-Za-z0-9_.:-]+$/;

const defaultIo = { out: (line) => process.stdout.write(`${line}\n`), env: process.env, readStdin: null };
function ioOf(io) { return { ...defaultIo, ...(io || {}) }; }

// ---------------------------------------------------------------- locations

function claudeConfigHome(env = process.env) { return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

// Real location of a path that may not exist yet: realpath of the nearest existing ancestor plus
// the missing tail. Other processes resolve paths the same way, so containment is judged on this.
export function realOf(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realPathNative(cur).replace(/^\\\\\?\\/, ''), ...tail);
}
export function insideReal(child, parent) { return isInside(realOf(child), realOf(parent)); }

// Chinese refusal when an absolute Windows path has a component that ordinary Windows programs open
// under a different name, else null. Node opens `AppData.` or `AppData ` verbatim, but Win32 path
// normalisation strips a trailing dot or space, so an agent handed `C:\Users\x\AppData.\Local\y`
// lands in `C:\Users\x\AppData\Local\y` (inside AppData, past every containment check made on the
// literal name). Also refused: characters Windows does not allow in a name and reserved device
// names. Other platforms allow those names, so nothing is checked there.
const WIN_BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
export function winNameProblem(p, { platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  const abs = path.win32.resolve(String(p));
  const root = path.win32.parse(abs).root;
  for (const c of abs.slice(root.length).split(/[\\/]/)) {
    if (!c) continue;
    if (WIN_BAD_CHARS.test(c)) return `路径 ${fwd(abs)} 里的「${c}」含有 Windows 不允许出现在名字里的字符（< > : " | ? * 或控制字符）。`;
    if (/[. ]$/.test(c)) return `路径 ${fwd(abs)} 里的「${c}」以句点或空格结尾：普通 Windows 程序打开它时会去掉结尾的句点和空格，实际落到另一个文件夹（例如 AppData. 会变成 AppData）。请去掉结尾的句点或空格。`;
    if (WIN_RESERVED.test(c)) return `路径 ${fwd(abs)} 里的「${c}」是 Windows 保留的设备名，不能用作文件夹名。`;
  }
  return null;
}

// The git work tree `dir` belongs to: the nearest real ancestor (or `dir` itself) holding a `.git`
// entry, which is a directory in a normal clone and a gitdir file in a worktree or submodule. Null
// when there is none. Existence checks only; git is never run on a seat directory (INTERFACES §1).
export function repoRootOf(dir) {
  let cur = realOf(dir);
  for (;;) {
    let hit = false;
    try { fs.lstatSync(path.join(cur, '.git')); hit = true; } catch { /* none here */ }
    if (hit) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Chinese refusal when the room directory sits inside the git work tree of `cwd` (plan §3.2: the
// room is never inside a governed repository, so admin.token and seat tokens never land in one).
function repoProblem(roomDir, cwd, who = '席位工作目录') {
  const root = repoRootOf(cwd);
  if (!root || !insideReal(roomDir, root)) return null;
  return `房间目录 ${fwd(roomDir)} 在${who} ${fwd(cwd)} 所属的 git 仓库 ${fwd(root)} 之内；请把房间放到仓库外（默认根目录 ${fwd(defaultRoomsRoot())}，或用 --dir / 环境变量 ROOM_DEV_HOME 指定）。`;
}

// Template hashes recorded in room.json (INTERFACES §2): sha256 of the preamble and of each role
// template, as packets use them (CRLF normalised by lib/packet.mjs), plus the combined hash that
// packet manifests carry as templateHash. Reads the template files only.
export function templateHashes() {
  const { templates, templateHash } = loadTemplates();
  const roles = {};
  for (const name of Object.keys(templates).sort()) {
    const m = /^role-(.+)$/.exec(name);
    if (m) roles[m[1]] = sha256(templates[name]);
  }
  return { preamble: sha256(templates.preamble), roles, all: templateHash };
}

// Chinese refusal text when `dir` is not where it says it is (MSIX AppData redirection or a link),
// else null. `redirect` is injectable for tests.
export function locationProblem(dir, { redirect = virtualizationRedirect, what = '房间目录' } = {}) {
  const r = redirect(dir);
  if (!r) return null;
  if (r.packaged) {
    return `${what} ${fwd(r.asked)} 的写入被重定向到 ${fwd(r.real)}。`
      + '这是 MSIX 打包应用（例如 Claude 桌面应用）对 AppData 的写入虚拟化：只有同一包上下文里的进程看得到原路径，'
      + '从开始菜单打开的 Codex Desktop、Claude Code 等 agent 会找不到它，席位命令和房间服务就对不上。'
      + `请改用 %USERPROFILE% 下的目录（默认 ${fwd(defaultRoomsRoot())}），或用环境变量 ROOM_DEV_HOME 指定根目录。`;
  }
  return `${what} ${fwd(r.asked)} 的真实位置是 ${fwd(r.real)}（经过了链接或重定向）。其他进程解析到的位置可能和你看到的不同；请直接使用真实路径。`;
}

function roomDirOf(args) {
  if (args.dir && args.dir !== true) return path.resolve(String(args.dir));
  if (args.id && args.id !== true) {
    if (!ID_RE.test(String(args.id))) throw new CliError('--id <roomId> may contain letters, digits, - and _ only');
    return path.join(defaultRoomsRoot(), String(args.id));
  }
  throw new CliError('--dir <roomDir> (or --id <roomId> under the default rooms root) is required');
}
function guardFor(roomDir) { return createGuard({ allowed: [roomDir], logPath: path.join(roomDir, F.writeLog), who: 'admin' }); }
function readRoomJson(roomDir) {
  const room = readJson(path.join(roomDir, F.room), null);
  if (!room) throw new CliError(`no room.json in ${fwd(roomDir)}; run admin init first`);
  if (!Array.isArray(room.seats)) room.seats = [];
  return room;
}

// Same liveness test as the service itself (lib/common.mjs lockHolderAlive): a lock whose pid is
// gone, or whose heartbeat is older than LOCK_STALE_MS, belongs to a service that is not running.
export function serviceRunning(roomDir, opts) {
  return lockHolderAlive(readJson(path.join(roomDir, F.lock), null), opts);
}

// ---------------------------------------------------------------- admin queue

// Admin queue record: {cmd, ...params, token, ts}. Exported so the format has one definition.
export function queueRecord(cmd, params, token, ts = nowIso()) {
  return { cmd, ...params, token, ts };
}

export function queue(roomDir, cmd, params, io) {
  const o = ioOf(io);
  let token;
  try { token = fs.readFileSync(path.join(roomDir, F.adminToken), 'utf8').trim(); } catch { throw new CliError(`no admin.token in ${fwd(roomDir)}`); }
  const guard = guardFor(roomDir);
  const qdir = path.join(roomDir, F.adminQueue);
  if (!fs.existsSync(path.join(qdir, 'done'))) guard.mkdir(path.join(qdir, 'done'));
  const name = `${Date.now()}-${randomHex(3)}.json`;
  guard.atomicWrite(path.join(qdir, name), JSON.stringify(queueRecord(cmd, params, token)));
  o.out(`QUEUED ${cmd} -> ${name}${serviceRunning(roomDir) ? '' : ' (房间服务未运行，启动后才会执行)'}`);
  return 0;
}

// ---------------------------------------------------------------- init

function num(v, name, { min = 0, allowNull = false } = {}) {
  if (v === undefined) return undefined;
  if (allowNull && (v === 'null' || v === 'none')) return null;
  const n = Number(v);
  if (v === true || !Number.isFinite(n) || n < min) throw new CliError(`--${name} must be a number >= ${min}`);
  return n;
}

export function cmdInit(args, io) {
  const o = ioOf(io);
  const roomDir = roomDirOf(args);
  const id = args.id && args.id !== true ? String(args.id) : path.basename(roomDir);
  if (!ID_RE.test(id)) throw new CliError('room id may contain letters, digits, - and _ only (pass --id)');
  if (fs.existsSync(path.join(roomDir, F.room))) throw new CliError(`room already exists: ${fwd(roomDir)}`);
  const preset = args.preset === undefined ? undefined : String(args.preset);
  if (preset !== undefined && !PRESETS.includes(preset)) throw new CliError(`--preset ${PRESETS.join('|')}`);
  const env = o.env || process.env;
  for (const [label, home] of [['CODEX_HOME', codexHome()], ['CLAUDE_CONFIG_DIR', claudeConfigHome(env)]]) {
    if (insideReal(roomDir, home)) throw new CliError(`房间目录不能放在 ${label}（${fwd(home)}）之内：那是 agent 自己的共享状态，房间不碰它。`);
  }
  const redirect = o.redirect || virtualizationRedirect;
  // The nearest existing ancestor may already be redirected; refuse before writing anything.
  const early = locationProblem(realAncestor(roomDir), { redirect, what: '房间目录所在的目录' });
  if (early) throw new CliError(early);
  // A room inside any git work tree would put admin.token and seat tokens into that repository.
  const repo = repoRootOf(roomDir);
  if (repo) throw new CliError(`房间目录 ${fwd(roomDir)} 在 git 仓库 ${fwd(repo)} 之内；房间不能放进任何仓库（席位可能正在治理它）。请改用仓库外的目录（默认根目录 ${fwd(defaultRoomsRoot())}，或用 --dir / 环境变量 ROOM_DEV_HOME 指定）。`);
  const templates = templateHashes();
  const guard = guardFor(roomDir);
  guard.mkdir(roomDir);
  const problem = locationProblem(roomDir, { redirect });
  if (problem) throw new CliError(`${problem}（已创建的空目录可以手动删除。）`);
  for (const d of [F.packets, F.replies, F.seats, F.adminQueue, path.join(F.adminQueue, 'done'), PRIVATE_DIR]) guard.mkdir(path.join(roomDir, d));
  const room = {
    schema_version: ROOM_SCHEMA_VERSION,
    id,
    createdAt: nowIso(),
    ...(preset ? { preset } : {}),
    wallClockSec: num(args.wall, 'wall', { min: 1 }) ?? 2700,
    workWallClockSec: num(args['work-wall'], 'work-wall', { min: 1 }) ?? 3600,
    maxWorkConcurrent: num(args['max-work'], 'max-work', { min: 1 }) ?? 2,
    budget: {
      maxTokens: num(args['max-tokens'], 'max-tokens', { min: 1, allowNull: true }) ?? null,
      packetMaxBytes: num(args['packet-max-bytes'], 'packet-max-bytes', { min: 1024 }) ?? 200000,
    },
    disclosureAllowlist: DEFAULT_ALLOWLIST.map((a) => [...a]),
    templates,
    seats: [],
  };
  guard.writeFile(path.join(roomDir, F.room), JSON.stringify(room, null, 1));
  guard.writeFile(path.join(roomDir, F.adminToken), randomHex(16));
  guard.writeFile(path.join(roomDir, F.events), '');
  o.out(`INIT room=${id} dir=${fwd(roomDir)}${preset ? ` preset=${preset}` : ''}`);
  return 0;
}

function realAncestor(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
  return cur;
}

// ---------------------------------------------------------------- add-seat

// Claude transcripts that already exist for this cwd when the seat is created (plan §8.3): the
// auditor later opens only files created or modified after this. Read-only: readdir + stat.
export function claudeTranscriptBaseline(cwd, env = process.env) {
  const enc = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(claudeConfigHome(env), 'projects', enc);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return { dir, knownTranscripts: [] }; }
  const knownTranscripts = [];
  for (const name of names.sort()) {
    try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) knownTranscripts.push({ name, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) }); } catch { /* vanished */ }
  }
  return { dir, knownTranscripts };
}

function auditFrom(args, cwd, env, prev = null) {
  const kind = args.audit && args.audit !== true ? String(args.audit) : (args.kind && args.kind !== true ? String(args.kind) : (prev && prev.kind));
  if (!kind) return null;
  if (!['codex', 'claude'].includes(kind)) throw new CliError('--audit codex|claude');
  const threadId = typeof args['thread-id'] === 'string' ? args['thread-id'] : (prev && prev.kind === kind ? prev.threadId || null : null);
  const sessionId = typeof args['session-id'] === 'string' ? args['session-id'] : (prev && prev.kind === kind ? prev.sessionId || null : null);
  for (const [n, v] of [['thread-id', threadId], ['session-id', sessionId]]) if (v && !TOKEN_RE.test(v)) throw new CliError(`--${n} may contain letters, digits and - _ . : only`);
  // The auditor matches a Codex rollout by the exact thread uuid in its file name (NI-5); anything
  // else would register nothing, so it is refused here instead of silently auditing nothing.
  if (kind === 'codex' && threadId && !isCodexThreadId(threadId)) throw new CliError('--thread-id 必须是 Codex 线程的完整 UUID（形如 01a0f000-0000-7000-8000-000000000001）');
  const audit = { kind, threadId: threadId || null, cwd };
  if (sessionId) audit.sessionId = sessionId;
  if (kind === 'claude') audit.knownTranscripts = claudeTranscriptBaseline(cwd, env).knownTranscripts;
  return audit;
}

// --hosted pi:<tier>          the built-in Pi seat (lib/hosted/pi.mjs)
// --hosted lane:<name>[:<tier>] a seat run by a provider the embedding host injects into the service
//                             (createRoomService({hostedProviders: {lane: ...}})), e.g. a PI-Desktop
//                             v-subagent lane such as claude-code or anyrouter. The plain CLI service
//                             has no such provider; its turns then fail with HOSTED_PROVIDER_MISSING.
function hostedLabel(h) { return `${h.kind === 'lane' ? `lane:${h.lane}:${h.tier}` : `pi:${h.tier}`}${h.model ? ` model=${h.model}` : ''}`; }

function parseHosted(v) {
  if (v === undefined) return null;
  const s = String(v);
  const pi = /^pi:([a-z]+)$/.exec(s);
  if (pi && HOSTED_TIERS.includes(pi[1])) return { kind: 'pi', tier: pi[1] };
  const lane = /^lane:([A-Za-z0-9_.-]+)(?::([a-z]+))?$/.exec(s);
  if (lane && (!lane[2] || HOSTED_TIERS.includes(lane[2]))) return { kind: 'lane', lane: lane[1], tier: lane[2] || 'discussion' };
  throw new CliError(`--hosted pi:${HOSTED_TIERS.join('|pi:')}|lane:<name>[:${HOSTED_TIERS.join('|')}]`);
}

function parseList(v, name) {
  if (v === undefined) return undefined;
  const list = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of list) if (!ID_RE.test(s)) throw new CliError(`--${name}: bad seat id ${s}`);
  return list;
}

// Validation errors that are final for this seat. Others (no reviewer yet, a review target not
// added yet, no lead yet) are reported as hints because seats are added one at a time.
const HARD_ROOM_ERRORS = new Set(['SEAT_ID_DUPLICATE', 'ROLE_INVALID', 'MULTIPLE_LEADS', 'EXECUTOR_IS_LEAD', 'LEAD_TAKES_WORK', 'REVIEWER_TAKES_WORK', 'PARTICIPANT_IS_LEAD', 'REVIEW_SELF', 'REVIEW_CYCLE', 'MULTIPLE_REVIEWERS', 'REVIEWS_NOT_ARRAY']);

export function cmdAddSeat(args, io) {
  const o = ioOf(io);
  const env = o.env || process.env;
  const redirect = o.redirect || virtualizationRedirect;
  const roomDir = roomDirOf(args);
  if (serviceRunning(roomDir)) throw new CliError('stop the room service before adding seats');
  const room = readRoomJson(roomDir);
  const roomProblem = locationProblem(roomDir, { redirect });
  if (roomProblem) throw new CliError(roomProblem);
  const seatId = args.seat;
  if (!seatId || seatId === true || !ID_RE.test(seatId)) throw new CliError('--seat <id> (letters, digits, - _) is required');
  if (room.seats.some((s) => s.seatId === seatId)) throw new CliError(`seat ${seatId} exists`);
  const role = args.role && args.role !== true ? String(args.role) : 'participant';
  if (!ROLES.includes(role)) throw new CliError(`--role ${ROLES.join('|')}`);
  const hosted = parseHosted(args.hosted);
  // --model: the model a hosted seat asks for (built-in Pi: the provider/model id; lane: passed to the
  // host's lane, e.g. AnyRouter's gpt-6-astra). Only for hosted seats: an embedded agent's model is
  // chosen in that agent, never by the room.
  if (args.model !== undefined) {
    if (!hosted) throw new CliError('--model 只用于托管席位（--hosted pi:<档位> 或 lane:<通道>）；外部 agent 的模型在它自己那里选');
    const m = String(args.model === true ? '' : args.model).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(m)) throw new CliError('--model <模型 id>：字母、数字和 . _ : / @ -，最长 128 个字符');
    hosted.model = m;
  }
  // --surface (lib/surface.mjs): only a tool seat stores one; a hosted seat's reply is its submission.
  const ps = parseSurfaceArg(args.surface);
  if (ps.error) throw new CliError(ps.error);
  const surface = ps.surface;
  if (surface && hosted) throw new CliError('--surface 只用于不是托管的席位：托管席位的回复正文就是它的提交，房间按 ASCII 标记读它');
  const agent = hosted ? (hosted.kind === 'lane' ? 'hosted-lane' : 'hosted-pi') : (args.agent && args.agent !== true ? String(args.agent) : 'generic');
  if (!hosted && !AGENT_KIND_NAMES.includes(agent)) throw new CliError(`--agent ${AGENT_KIND_NAMES.join('|')}`);
  const waitMode = args.wait && args.wait !== true ? String(args.wait) : (hosted ? 'manual' : defaultWaitMode(agent));
  if (!WAIT_MODES.includes(waitMode)) throw new CliError(`--wait ${WAIT_MODES.join('|')}`);
  const declaredTier = args.tier && args.tier !== true ? String(args.tier) : DEFAULT_TIER_BY_ROLE[role];
  if (!TIERS.includes(declaredTier)) throw new CliError(`--tier ${TIERS.join('|')}`);
  const reviews = parseList(args.reviews, 'reviews');
  const wakeMax = num(args['wake-max'], 'wake-max', { min: 1 });
  if (!args.cwd || args.cwd === true) throw new CliError('--cwd <seat working directory> is required (where the agent is allowed to write)');
  const cwd = path.resolve(String(args.cwd));
  const badName = winNameProblem(cwd, { platform: o.platform || process.platform });
  if (badName) throw new CliError(`席位工作目录不能用：${badName}`);

  // Containment, judged on real locations (other processes resolve paths the same way).
  if (insideReal(roomDir, cwd) || insideReal(cwd, roomDir)) throw new CliError('席位工作目录和房间目录不能互相包含：房间只写房间目录，席位只写自己工作目录下的发件箱。');
  const roomsRoot = defaultRoomsRoot();
  if (insideReal(roomsRoot, cwd)) throw new CliError(`席位工作目录 ${fwd(cwd)} 包含了房间根目录 ${fwd(roomsRoot)}；请换一个更具体的目录。`);
  for (const [label, home] of [['CODEX_HOME', codexHome()], ['CLAUDE_CONFIG_DIR', claudeConfigHome(env)]]) {
    if (insideReal(cwd, home) || insideReal(home, cwd)) throw new CliError(`席位工作目录不能在 ${label}（${fwd(home)}）之内，也不能包含它。`);
  }
  for (const s of room.seats) if (s.cwd && insideReal(roomDir, s.cwd)) throw new CliError(`房间目录在席位 ${s.seatId} 的工作目录之内`);
  const early = locationProblem(realAncestor(cwd), { redirect, what: '席位工作目录所在的目录' });
  if (early) throw new CliError(early);
  // The seat working directory is the user's (or the agent's) directory, not the room's: the room
  // never writes it (plan §1.6 clause 4), not even to create it. The user creates it.
  if (!fs.existsSync(cwd)) throw new CliError(`席位工作目录 ${fwd(cwd)} 不存在；请先自己创建它（房间不写席位工作目录，也不替你创建）。`);
  if (!fs.statSync(cwd).isDirectory()) throw new CliError(`席位工作目录 ${fwd(cwd)} 不是目录。`);
  const cwdProblem = locationProblem(cwd, { redirect, what: '席位工作目录' });
  if (cwdProblem) throw new CliError(cwdProblem);
  // The room must not sit inside the git work tree of this seat, nor of any seat added before.
  for (const [who, dir] of [['席位工作目录', cwd], ...room.seats.filter((s) => s.cwd).map((s) => [`席位 ${s.seatId} 的工作目录`, s.cwd])]) {
    const problem = repoProblem(roomDir, dir, who);
    if (problem) throw new CliError(problem);
  }

  const seat = {
    seatId, name: args.name && args.name !== true ? String(args.name) : seatId, role, agent, waitMode, cwd,
    outbox: path.join(cwd, '.room-outbox', seatId),
    roomDir, createdAt: nowIso(),
    wallClockSec: num(args.wall, 'wall', { min: 1 }),
    waitTimeoutSec: num(args['wait-timeout'], 'wait-timeout', { min: 0 }),
    declaredTier,
    // --wake-kind defaults to codex-queue; any other kind (e.g. pi-session) is delivered by a waker the
    // embedding host injects (createRoomService({wakers})); the CLI service has none and records that.
    wake: args['wake-thread'] && args['wake-thread'] !== true
      ? { enabled: true, kind: args['wake-kind'] && args['wake-kind'] !== true && /^[a-z][a-z0-9-]*$/.test(String(args['wake-kind'])) ? String(args['wake-kind']) : 'codex-queue', thread: String(args['wake-thread']), maxPerTurn: wakeMax ?? 1 }
      : { enabled: false, maxPerTurn: wakeMax ?? 1 },
    audit: auditFrom(args, cwd, env),
    hosted,
    ...(surface ? { surface } : {}),
    ...(reviews ? { reviews } : {}),
  };
  if (surface && seat.wake.enabled && seat.wake.kind === 'codex-queue') throw new CliError('工具席位不能登记 Codex queue 唤醒（那条唤醒文案是一条命令行）；用 --wake-kind <宿主的唤醒种类>，或不登记唤醒');
  // No node on PATH but created by the desktop app (ROOM_SEAT_RUNTIME): the seat runs room.mjs on
  // the app's exe through its room.cmd (lib/join.mjs). With a node on PATH nothing is recorded.
  const runtime = hosted ? null : seatRuntimeFor({ env });
  if (runtime) seat.runtime = runtime;
  // The room.mjs this seat's JOIN.md, allow rule and room.cmd name. Packets, wake texts and lobby
  // hints rendered later by another copy (the desktop app's bundled one, or the repository CLI) keep
  // using it (lib/join.mjs recordedRoomMjs).
  if (!hosted) seat.roomMjs = path.resolve(roomMjsPath());
  const candidate = { ...room, seats: [...room.seats, seat] };
  const v = validateRoom(candidate);
  const hard = v.errors.filter((e) => HARD_ROOM_ERRORS.has(e.code));
  if (hard.length) throw new CliError(`房间配置不成立：${hard.map((e) => e.message).join('；')}`);

  const guard = guardFor(roomDir);
  const seatDir = path.join(roomDir, F.seats, seatId);
  guard.mkdir(seatDir);
  guard.writeFile(path.join(seatDir, 'token'), randomHex(24));
  guard.writeFile(path.join(seatDir, 'seat.json'), JSON.stringify(seat, null, 1));
  const joinMd = renderJoin({ room, seat, seatDir, roomDir, roomMjs: roomMjsPath(), agent });
  guard.writeFile(path.join(seatDir, 'JOIN.md'), joinMd);
  guard.writeFile(path.join(seatDir, 'room.cmd'), renderRoomCmd({ roomMjs: roomMjsPath(), runtime: seat.runtime || null }));
  room.seats.push({ ...seat, joinSha256: sha256(joinMd) });
  guard.atomicWrite(path.join(roomDir, F.room), JSON.stringify(room, null, 1));

  o.out(`SEAT ${seatId} role=${role} agent=${agent} wait=${waitMode} tier=${declaredTier} cwd=${fwd(cwd)}${hosted ? ` hosted=${hostedLabel(hosted)}` : ''}${surface ? ` surface=tool:${surface.tool}` : ''}`);
  o.out(`JOIN ${fwd(path.join(seatDir, 'JOIN.md'))}`);
  o.out(`ROOMCMD ${fwd(path.join(seatDir, 'room.cmd'))}`);
  if (hosted && hosted.kind === 'lane') o.out(`这个席位由嵌入房间服务的宿主通过通道 ${hosted.lane} 托管；单独用命令行起的服务没有这个通道，轮到它时会记 HOSTED_PROVIDER_MISSING。`);
  else if (hosted) o.out('这个席位由房间内置 Pi 托管，不需要交给外部 agent；API key 在启动服务时用环境变量 ROOM_PI_API_KEY 或 serve --pi-key-stdin 交给它（只在内存），或事先用 admin pi-key --save 以 DPAPI 加密保存，服务启动时没有别的 key 就用它。');
  else o.out(`对这个 agent 说：读 ${fwd(path.join(seatDir, 'JOIN.md'))}，按它入席。`);
  if ([roomMjsPath(), seatDir, cwd].some(needsQuoting)) o.out('提示：路径含空格或特殊字符，JOIN.md 里的命令加了引号；允许规则要按带引号的原样写。');
  if (fs.existsSync(path.join(cwd, '.git'))) o.out(`提示：${fwd(cwd)} 是 git 仓库。请自己把 .room-outbox/ 加进 .git/info/exclude（房间不写它）。`);
  const sameCwd = room.seats.filter((s) => s.seatId !== seatId && s.cwd && realOf(s.cwd).toLowerCase() === realOf(cwd).toLowerCase());
  if (sameCwd.length) o.out(`提示：席位 ${sameCwd.map((s) => s.seatId).join('、')} 用同一个工作目录；同目录的 agent 可能共享自动记忆，这是你自己的设置，房间不碰。`);
  if (seat.audit && seat.audit.kind === 'codex' && !seat.audit.threadId) o.out('提示：登记了 codex 审计但没有 --thread-id；之后用 admin set-audit 补上，否则审计结果为 unknown。');
  for (const w of v.warnings) o.out(`提示：${w.message}`);
  for (const e of v.errors.filter((x) => !HARD_ROOM_ERRORS.has(x.code))) o.out(`提示（建房完成前需解决）：${e.message}`);
  return 0;
}

// Register (or change) the audit source of a seat after the fact, e.g. once a Codex thread id is known.
export function cmdSetAudit(args, io) {
  const o = ioOf(io);
  const roomDir = roomDirOf(args);
  if (!args.seat || args.seat === true) throw new CliError('--seat <id>');
  const room = readRoomJson(roomDir);
  const seat = room.seats.find((s) => s.seatId === args.seat);
  if (!seat) throw new CliError(`no seat ${args.seat}`);
  const audit = auditFrom({ ...args, audit: args.kind || args.audit || (seat.audit && seat.audit.kind) || 'codex' }, seat.cwd, o.env || process.env, seat.audit);
  seat.audit = audit;
  const guard = guardFor(roomDir);
  guard.atomicWrite(path.join(roomDir, F.room), JSON.stringify(room, null, 1));
  const seatDir = path.join(roomDir, F.seats, seat.seatId);
  const seatJson = readJson(path.join(seatDir, 'seat.json'));
  seatJson.audit = audit;
  guard.atomicWrite(path.join(seatDir, 'seat.json'), JSON.stringify(seatJson, null, 1));
  const shown = { ...audit, knownTranscripts: audit.knownTranscripts ? audit.knownTranscripts.length : undefined };
  o.out(`AUDIT seat=${seat.seatId} ${JSON.stringify(shown)}`);
  return 0;
}

// ---------------------------------------------------------------- queued commands

function textOf(args, { required = true, what = '--text <文本> 或 --file <路径>' } = {}) {
  let t = null;
  if (args.file && args.file !== true) {
    const p = String(args.file);
    if (!fs.existsSync(p)) throw new CliError(`file not found: ${fwd(p)}`);
    t = fs.readFileSync(p, 'utf8');
  } else if (typeof args.text === 'string') t = args.text;
  if (required && (!t || !t.trim())) throw new CliError(what);
  return t;
}
function positional(args, i, name, re = TOKEN_RE) {
  const v = (args._ || [])[i] ?? args[name];
  if (v === undefined || v === true || !re.test(String(v))) throw new CliError(`${name} is required`);
  return String(v);
}

export function cmdTask(args, io) { return queue(roomDirOf(args), 'task', { text: textOf(args) }, io); }
export function cmdStart(args, io) {
  if (!args.order || args.order === true) throw new CliError('--order A,B,A');
  const order = String(args.order).split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of order) if (!ID_RE.test(s)) throw new CliError(`--order: bad seat id ${s}`);
  return queue(roomDirOf(args), 'start', { order }, io);
}
export function cmdCancel(args, io) { return queue(roomDirOf(args), 'cancel', {}, io); }
export function cmdSkip(args, io) { return queue(roomDirOf(args), 'skip', {}, io); }
// The user's "wait" choice after a seat's turn ran out in a governed room (#6a): the same seat gets
// a fresh attempt for the same turn. The service answers NO_DECISION_PENDING when nothing waits.
export function cmdRetry(args, io) {
  const seat = args.seat && args.seat !== true ? String(args.seat) : null;
  if (seat && !ID_RE.test(seat)) throw new CliError(`bad seat id ${seat}`);
  return queue(roomDirOf(args), 'retry', seat ? { seatId: seat } : {}, io);
}
export function cmdWake(args, io) {
  if (!args.seat || args.seat === true) throw new CliError('--seat <id>');
  return queue(roomDirOf(args), 'wake', { seatId: String(args.seat) }, io);
}
export function cmdClose(args, io) { return queue(roomDirOf(args), 'close', {}, io); }
export function cmdSay(args, io) { return queue(roomDirOf(args), 'say', { text: textOf(args) }, io); }
export function cmdInterrupt(args, io) {
  const text = textOf(args, { required: false });
  return queue(roomDirOf(args), 'interrupt', text ? { text } : {}, io);
}
export function cmdConfirmTask(args, io) {
  const roomDir = roomDirOf(args);
  if (args.file && args.file !== true) {
    // The user edited the draft: the edited assignments replace the drafted ones.
    const parsed = parseAssignDraft(textOf(args));
    const fatal = parsed.errors.filter((e) => e.fatal);
    if (fatal.length) throw new CliError(`任务单草案无法解析：${fatal.map((e) => `第 ${e.lineNo} 行 ${e.message}`).join('；')}`);
    return queue(roomDir, 'confirm-task', { assignments: parsed.assignments }, io);
  }
  return queue(roomDir, 'confirm-task', {}, io);
}
export function cmdReverse(args, io) { return queue(roomDirOf(args), 'reverse', {}, io); }
export function cmdReassign(args, io) {
  if (!args.seat || args.seat === true || !args.to || args.to === true) throw new CliError('reassign needs --seat <from> --to <seat>');
  for (const s of [args.seat, args.to]) if (!ID_RE.test(String(s))) throw new CliError(`bad seat id ${s}`);
  return queue(roomDirOf(args), 'reassign', { seatId: String(args.seat), toSeatId: String(args.to), text: textOf(args, { required: false }) || '' }, io);
}
export function cmdReconcile(args, io) {
  const attemptId = positional(args, 1, 'attempt');
  const action = (args._ || [])[2] ?? args.action;
  if (!['replay', 'void'].includes(action)) throw new CliError('reconcile <attemptId> replay|void');
  return queue(roomDirOf(args), 'reconcile', { attemptId, action }, io);
}
export function cmdApproveDisclose(args, io) { return queue(roomDirOf(args), 'approve-disclose', { id: positional(args, 1, 'id') }, io); }
export function cmdDenyDisclose(args, io) {
  const id = positional(args, 1, 'id');
  const reason = typeof args.reason === 'string' ? args.reason : '';
  if (!reason.trim()) throw new CliError('deny-disclose <id> --reason <理由>');
  return queue(roomDirOf(args), 'deny-disclose', { id, reason }, io);
}
export function cmdAcceptStale(args, io) {
  const manifestSha = positional(args, 1, 'manifestSha', /^[0-9a-f]{64}$/);
  return queue(roomDirOf(args), 'accept-stale', { manifestSha }, io);
}

// pi-key (INTERFACES §9). The plaintext key never touches disk. There is no file or admin-queue
// handoff to a service. The key reaches the service in one of four ways:
//   1. ROOM_PI_API_KEY in the environment of `room.mjs serve`;
//   2. `room.mjs serve --pi-key-stdin`, the key piped to the service's stdin;
//   3. this command with --port <n>: POST /api/admin on 127.0.0.1:<n> (the service started with
//      --port), authenticated with the room's admin token, the key in the request body only;
//   4. (P3) this command with --save: the key is DPAPI-protected (CurrentUser, lib/hosted/dpapi.mjs)
//      and the blob stored at appRoot()/secrets/pi-key.dpapi. A service that got no key from 1-3
//      unprotects it at start. --status and --forget inspect and remove that file.
// 1-3 are in memory only; 4 is the only thing written, and only as a DPAPI blob. Without --port,
// --save, --status or --forget this command writes nothing and explains the ways. Nothing here prints
// the key; --save and --status print its length and the first 8 hex of its sha256.
export function readPiKey(io) {
  const o = ioOf(io);
  const env = o.env || process.env;
  if (typeof env.ROOM_PI_API_KEY === 'string' && env.ROOM_PI_API_KEY.trim()) return env.ROOM_PI_API_KEY.trim();
  if (typeof o.readStdin === 'function') return String(o.readStdin() || '').trim();
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}

const PI_KEY_HOWTO = '交 key 的方式（①②③ 只在内存，不落盘）：'
  + '① 在启动服务的终端里设置环境变量 ROOM_PI_API_KEY，再运行 node room.mjs serve --dir <房间目录>；'
  + '② 把 key 从管道交给服务：<输出 key 的命令> | node room.mjs serve --dir <房间目录> --pi-key-stdin；'
  + '③ 服务带 --port <端口> 运行时，运行 admin pi-key --dir <房间目录> --port <端口>，key 只经本机回环交给正在运行的服务；'
  + '④ 只在 Windows 上：<输出 key 的命令> | node room.mjs admin pi-key --save，key 用 DPAPI 按当前 Windows 用户加密后存到 '
  + '%USERPROFILE%\\room-dev\\secrets\\pi-key.dpapi（ROOM_DEV_HOME 可改根），之后启动的服务没有 ①②③ 的 key 时就用它；'
  + 'admin pi-key --status 查看，--forget 删除。';

// POST {token, cmd:'pi-key', key, seatId?} to the service's loopback admin endpoint. Resolves to
// {status, body}; never logs the request body.
function postAdmin(port, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/admin', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Host: `127.0.0.1:${port}` },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}

const PI_KEY_LOCAL_MODES = Object.freeze(['save', 'status', 'forget']);

// --save / --status / --forget: the DPAPI-protected key of this Windows user (application level,
// not per room, so no --dir). `io.piKeyFile` and `io.dpapi` are test hooks; the CLI uses the
// default path under appRoot() and the real DPAPI.
async function piKeyLocal(mode, args, o) {
  const file = o.piKeyFile ? path.resolve(o.piKeyFile) : savedPiKeyPath();
  const dpapiOpts = o.dpapi || {};
  if (mode === 'save') {
    const key = readPiKey(o);
    const bad = validatePiKey(key);
    if (bad === 'EMPTY') throw new CliError('没有拿到 API key：用管道从标准输入传入，或设置环境变量 ROOM_PI_API_KEY（不要写在命令行参数里）。');
    if (bad) throw new CliError('API key 只能是一行，且不能含 NUL。');
    let r;
    try { r = await savePiKey(key, { file, ...dpapiOpts }); } catch (e) {
      // Every message from lib/hosted/dpapi.mjs starts with its ASCII code and never contains the key.
      const msg = e && e.code ? e.message : `ERROR：${e && e.message ? e.message : e}`;
      throw new CliError(`没有保存：${msg}${e && e.code === 'DPAPI_UNAVAILABLE' ? ` 可以改用只在内存的交法。${PI_KEY_HOWTO}` : ''}`);
    }
    o.out(`SAVED ${fwd(r.path)} length=${r.length} sha256=${r.sha256}（已用 Windows DPAPI 按当前用户加密保存；房间服务启动时没有别的 key 来源就用它；本命令不显示 key）`);
    return 0;
  }
  if (mode === 'forget') {
    const r = forgetPiKey({ file });
    if (r.removed) o.out(`FORGOTTEN ${fwd(r.path)}（已删除保存的 key 文件；已在运行的服务手里的 key 不受影响，重启后才不再使用）`);
    else o.out(`NOT_SAVED ${fwd(r.path)}（没有保存的 key，什么也没删）`);
    return 0;
  }
  const s = await piKeyStatus({ file, ...dpapiOpts });
  if (!s.saved) o.out(`PI_KEY_STATUS saved=no path=${fwd(s.path)}（没有保存的 key；用 <输出 key 的命令> | node room.mjs admin pi-key --save 保存）`);
  else if (s.decrypts === true) o.out(`PI_KEY_STATUS saved=yes decrypts=yes length=${s.length} sha256=${s.sha256} path=${fwd(s.path)}（当前 Windows 用户能解密；本命令不显示 key）`);
  else if (s.decrypts === null) o.out(`PI_KEY_STATUS saved=yes decrypts=unknown code=${s.code} path=${fwd(s.path)}（这里用不了 DPAPI，无法判断能否解密）`);
  else o.out(`PI_KEY_STATUS saved=yes decrypts=no code=${s.code} path=${fwd(s.path)}（当前 Windows 用户解不开：可能换了用户或机器，或文件被改动过。用 admin pi-key --save 重新保存，或 --forget 删除）`);
  return 0;
}

export async function cmdPiKey(args, io) {
  const o = ioOf(io);
  const modes = PI_KEY_LOCAL_MODES.filter((m) => args[m] !== undefined);
  if (modes.length > 1 || (modes.length && args.port !== undefined)) throw new CliError('--save、--status、--forget、--port 一次只能用一个。');
  if (modes.length) {
    // `--save sk-…` would put the key into argv and shell history; the value is never echoed.
    if (args[modes[0]] !== true) throw new CliError(`--${modes[0]} 不带值。key 只从标准输入或环境变量 ROOM_PI_API_KEY 读取，不要写在命令行上。`);
    return piKeyLocal(modes[0], args, o);
  }
  const roomDir = roomDirOf(args);
  readRoomJson(roomDir);
  const seatId = args.seat && args.seat !== true ? String(args.seat) : null;
  if (seatId && !ID_RE.test(seatId)) throw new CliError(`bad seat id ${seatId}`);
  if (args.port === undefined || args.port === true) throw new CliError(`admin pi-key 不再经文件或 admin-queue 交 key（那样明文 key 会落盘）。${PI_KEY_HOWTO}`);
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError('--port <端口> 必须是 1-65535 的整数（服务启动时 --port 给的那个）。');
  if (!serviceRunning(roomDir)) throw new CliError(`房间服务没有运行。${PI_KEY_HOWTO}`);
  const key = readPiKey(o);
  if (!key) throw new CliError('没有拿到 API key：用管道从标准输入传入，或设置环境变量 ROOM_PI_API_KEY。');
  if (/[\r\n]/.test(key)) throw new CliError('API key 只能是一行。');
  let token;
  try { token = fs.readFileSync(path.join(roomDir, F.adminToken), 'utf8').trim(); } catch { throw new CliError(`no admin.token in ${fwd(roomDir)}`); }
  let r;
  try { r = await postAdmin(port, { token, cmd: 'pi-key', key, ...(seatId ? { seatId } : {}) }); } catch (e) {
    throw new CliError(`连不上 127.0.0.1:${port} 上的房间服务（${e.code || e.message}）。确认服务是用 --port ${port} 启动的。${PI_KEY_HOWTO}`);
  }
  if (r.status !== 200 || !r.body || r.body.ok === false) {
    const why = r.body && (r.body.error || r.body.reason) ? `${r.body.error || r.body.reason}` : `HTTP ${r.status}`;
    throw new CliError(`房间服务拒绝了 pi-key：${why}。`);
  }
  o.out(`SENT pi-key -> 127.0.0.1:${port}${seatId ? ` seat=${seatId}` : ''}（key 只经本机回环交给正在运行的服务，只在内存里，不落盘；本命令不显示 key）`);
  return 0;
}

// ---------------------------------------------------------------- export

export async function cmdExport(args, io) {
  const o = ioOf(io);
  const roomDir = roomDirOf(args);
  const room = readRoomJson(roomDir);
  const { exportRoom } = await import('./export.mjs');
  const stamp = nowIso().replace(/[:.]/g, '-');
  const out = args.out && args.out !== true ? path.resolve(String(args.out)) : path.join(appRoot(), 'exports', `${room.id}-${stamp}.zip`);
  if (insideReal(out, roomDir)) throw new CliError('导出文件不能写进房间目录本身');
  const r = await exportRoom({ roomDir, out, redact: args.redact === true, log: o.out });
  return r.ok ? 0 : 2;
}

// ---------------------------------------------------------------- log / show

export function cmdLog(args, io) {
  const o = ioOf(io);
  const roomDir = roomDirOf(args);
  for (const ev of readJsonl(path.join(roomDir, F.events))) {
    const extra = Object.entries(ev).filter(([k]) => !['seq', 'ts', 'type', 'text'].includes(k)).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
    o.out(`${String(ev.seq).padStart(4)} ${ev.ts} ${ev.type} ${extra}${typeof ev.text === 'string' ? ` text=${JSON.stringify(ev.text.slice(0, 120))}` : ''}`);
  }
  return 0;
}

const short = (s, n = 12) => (typeof s === 'string' ? s.slice(0, n) : '-');
const oneLine = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// Pure: the lines `admin show` prints, folded from events (the contract) with state.json for the
// round position. Unknown values print as 未知, never as 0.
export function summarizeRoom({ room, state, events = [], adjudications = [] }) {
  const L = [];
  const st = state || {};
  const order = Array.isArray(st.order) ? st.order : [];
  const turn = Number.isInteger(st.turnIndex) ? `${st.turnIndex + 1}/${order.length}` : '-';
  if (state) L.push(`phase=${st.phase || '-'} round=${st.roundId ?? '-'} epoch=${st.epoch ?? '-'} order=${order.join(',') || '-'} turn=${turn} current=${st.currentSeat || '-'} attempt=${st.attempt ? st.attempt.attemptId : '-'} closed=${!!st.closed}`);
  else L.push('NO_STATE（服务还没运行过；以下只按 events 汇总）');
  if (room) L.push(`room=${room.id} preset=${room.preset || '-'} seats=${(room.seats || []).length}`);

  const left = new Set(events.filter((e) => e.type === 'seat_left').map((e) => e.seatId));
  const joined = new Set(events.filter((e) => e.type === 'seat_joined').map((e) => e.seatId));
  const tainted = new Map();
  for (const e of events) if (e.type === 'audit_observed') tainted.set(e.seatId, (tainted.get(e.seatId) || false) || !!e.tainted);
  for (const s of (room && room.seats) || []) {
    const status = left.has(s.seatId) ? 'left' : joined.has(s.seatId) ? 'joined' : ((st.seats && st.seats[s.seatId] && st.seats[s.seatId].status) || 'not_joined');
    L.push(`seat ${s.seatId} role=${s.role} agent=${s.agent || '-'} wait=${s.waitMode} tier=${s.declaredTier || '-'} status=${status} audit=${s.audit ? s.audit.kind : 'none'}${s.hosted ? ` hosted=${hostedLabel(s.hosted)}` : ''}${tainted.get(s.seatId) ? ' tainted' : ''}`);
  }
  if (st.task && st.task.text) L.push(`task: ${oneLine(st.task.text, 200)}`);

  const reconciled = new Set(events.filter((e) => e.type === 'reconciled').map((e) => e.attemptId));
  for (const e of events) if (e.type === 'needs_reconcile' && !reconciled.has(e.attemptId)) L.push(`needs_reconcile attempt=${e.attemptId} seat=${e.seatId} -> admin reconcile ${e.attemptId} replay|void`);

  // items
  const items = new Map();
  for (const e of events) {
    if (e.type === 'point_added') items.set(e.itemId, { itemId: e.itemId, seatId: e.seatId, aboutSeq: e.aboutSeq, text: e.text, status: null });
    if (e.type === 'item_marked') { const it = items.get(e.itemId) || { itemId: e.itemId, seatId: '-', text: '' }; it.status = e.status; it.markText = e.text; items.set(e.itemId, it); }
  }
  const summaries = events.filter((e) => e.type === 'summary_published');
  const lastSummary = summaries.length ? summaries[summaries.length - 1] : null;
  const unansweredSet = new Set(lastSummary && Array.isArray(lastSummary.unanswered) ? lastSummary.unanswered : []);
  // A whole-message item is named m<seq> (lib/structured.mjs messageItemId); its author and text are
  // the accepted submission with that msgSeq.
  const bySeq = new Map(events.filter((e) => e.type === 'submission_accepted' && Number.isInteger(e.msgSeq)).map((e) => [e.msgSeq, e]));
  for (const id of unansweredSet) {
    if (items.has(id)) continue;
    const m = /^m(\d+)$/.exec(id);
    const msg = m ? bySeq.get(Number(m[1])) : null;
    items.set(id, { itemId: id, seatId: msg ? msg.seatId : '-', aboutSeq: msg ? msg.msgSeq : undefined, text: msg ? msg.text || '' : '', status: null });
  }
  const statusOf = (it) => it.status || (unansweredSet.has(it.itemId) ? 'unanswered' : '未标注');
  const counts = {};
  for (const it of items.values()) counts[statusOf(it)] = (counts[statusOf(it)] || 0) + 1;
  L.push(`items total=${items.size}${Object.entries(counts).map(([k, v]) => ` ${k}=${v}`).join('')}${lastSummary ? ` summary=v${lastSummary.version}` : ''}`);
  for (const it of items.values()) L.push(`  item ${it.itemId} seat=${it.seatId} status=${statusOf(it)}${it.aboutSeq !== undefined ? ` about=${it.aboutSeq}` : ''} ${oneLine(it.text, 100)}`);

  // artifacts + verdicts
  const stale = new Map();
  for (const e of events) {
    if (e.type === 'artifacts_recomputed') stale.set(e.manifestSha, !!e.stale);
    if (e.type === 'stale_accepted') stale.set(e.manifestSha, 'accepted_stale');
  }
  for (const e of events.filter((x) => x.type === 'artifacts_frozen')) {
    const s = stale.get(e.manifestSha);
    L.push(`artifacts seat=${e.seatId} manifest=${short(e.manifestSha)} files=${e.fileCount ?? '未知'} bytes=${e.bytes ?? '未知'} baseline=${e.baseline ?? '-'}${e.copyTorn ? ' copyTorn' : ''}${s === true ? ' stale' : s === 'accepted_stale' ? ' accepted_stale' : ''}`);
  }
  const verdicts = events.filter((e) => e.type === 'verdict_recorded');
  L.push(`verdicts total=${verdicts.length}`);
  for (const e of verdicts) {
    const s = stale.get(e.artifactSha);
    L.push(`  verdict seat=${e.seatId} attempt=${e.attemptId} artifact=${short(e.artifactSha)} verdict=${e.verdict ?? 'none'} annotation=${e.annotation || 'none'}${s === true ? ' (清单已过期)' : ''}`);
  }

  // disclosures
  const disc = new Map();
  for (const e of events) {
    if (e.type === 'disclose_requested') disc.set(e.id, { id: e.id, seatId: e.seatId, argv: e.argv, reason: e.reason, status: 'requested' });
    const d = e.id !== undefined ? disc.get(e.id) : null;
    if (!d) continue;
    if (e.type === 'disclose_approved') d.status = 'approved';
    if (e.type === 'disclose_denied') { d.status = 'denied'; d.denyReason = e.reason; }
    if (e.type === 'disclose_executed') { d.status = 'executed'; d.exitCode = e.exitCode; d.truncated = e.truncated; }
  }
  L.push(`disclosures total=${disc.size} pending=${[...disc.values()].filter((d) => d.status === 'requested').length}`);
  for (const d of disc.values()) L.push(`  disclose ${d.id} seat=${d.seatId} status=${d.status} argv=${JSON.stringify(d.argv)}${d.exitCode !== undefined ? ` exit=${d.exitCode}` : ''}${d.truncated ? ' truncated' : ''}${d.status === 'requested' ? ` -> admin approve-disclose ${d.id} | admin deny-disclose ${d.id} --reason …` : ''}`);

  // usage
  let usage = emptyUsage();
  for (const e of events) if (e.type === 'usage_reported') usage = accumulate(usage, e);
  L.push(`usage: ${formatUsage(usage, { maxTokens: room && room.budget ? room.budget.maxTokens : null })}`);

  // reject-rate signal per reviewer agent kind (cross-room adjudications.jsonl)
  // Same reviewer set and agent kind as the service's view().adjudications: explicit reviewers plus
  // the default reviewer (the lead) of every producer.
  const reviewers = room ? reviewerSeats(room) : [];
  const kinds = [...new Set(reviewers.map((s) => reviewerAgentOf(s)))];
  if (!kinds.length) L.push('reject_rate: 本房间没有审方席位');
  for (const k of kinds) {
    const preset = (room && room.preset) || 'none'; // the service files a preset-less room under 'none'
    const sig = rejectRateSignal(adjudications, { reviewerAgent: k, preset });
    L.push(`reject_rate agent=${k} preset=${preset} n=${sig.n} k=${sig.k} status=${sig.status} ${sig.message}`);
  }
  return L;
}

export function cmdShow(args, io) {
  const o = ioOf(io);
  const roomDir = roomDirOf(args);
  const room = readJson(path.join(roomDir, F.room), null);
  const state = readJson(path.join(roomDir, F.state), null);
  const events = readJsonl(path.join(roomDir, F.events));
  const adjPath = args.adjudications && args.adjudications !== true ? path.resolve(String(args.adjudications)) : path.join(appRoot(), 'adjudications.jsonl');
  const adjudications = readAdjudications(adjPath);
  for (const line of summarizeRoom({ room, state, events, adjudications })) o.out(line);
  if (args.messages !== false && state && Array.isArray(state.messages)) {
    for (const m of state.messages) o.out(`--- [${m.seatId} seq=${m.seq} escaped=${m.escaped}]\n${String(m.text || '').slice(0, 1500)}`);
  }
  return 0;
}

export const ADMIN_COMMANDS = Object.freeze({
  init: cmdInit, 'add-seat': cmdAddSeat, 'set-audit': cmdSetAudit,
  task: cmdTask, start: cmdStart, cancel: cmdCancel, skip: cmdSkip, retry: cmdRetry, wake: cmdWake, close: cmdClose,
  say: cmdSay, interrupt: cmdInterrupt, 'confirm-task': cmdConfirmTask,
  'approve-disclose': cmdApproveDisclose, 'deny-disclose': cmdDenyDisclose, 'accept-stale': cmdAcceptStale,
  reverse: cmdReverse, reassign: cmdReassign, reconcile: cmdReconcile, 'pi-key': cmdPiKey,
  export: cmdExport, log: cmdLog, show: cmdShow,
});
