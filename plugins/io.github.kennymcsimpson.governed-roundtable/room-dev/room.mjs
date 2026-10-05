#!/usr/bin/env node
// Entry point. Seat commands import only lib/seat.mjs; they never load the service, so a seat
// process cannot write the room directory by construction. Before a seat command runs, this process
// clears its own environment down to a short whitelist (plan §1.6 clause 3): the seat command is a
// child of the agent and inherits the agent's API keys, and it needs none of them.
//
//   Seat (run by an agent; first stdout word is the result; exit 0 / REJECTED 2 / PENDING, NO_SERVICE 8 / error 9):
//     node room.mjs wait      --seat <seatDir> [--timeout S] [--once]
//     node room.mjs submit    --seat <seatDir> --attempt <id> --file <path>
//     node room.mjs status    --seat <seatDir> [--log] [--whoami]
//     node room.mjs leave     --seat <seatDir>
//     node room.mjs artifacts --seat <seatDir> --attempt <id> --declare <path>... [--baseline none|whole|<sha>] [--exclude <glob>]...
//     node room.mjs point     --seat <seatDir> --attempt <id> --seq N --text "..."
//     node room.mjs quote     --seat <seatDir> --attempt <id> --seq N --text "..."
//     node room.mjs mark      --seat <seatDir> --attempt <id> --item <id> --status accepted|rejected|deferred --text "..."
//     node room.mjs verdict   pass|reject|disclose --seat <seatDir> --attempt <id> --artifact <manifestSha> --text "..."
//     node room.mjs disclose  --seat <seatDir> --attempt <id> --arg git --arg diff --reason "..."
//                             (one --arg per argv element, no quoting needed; --arg=--stat for a leading '-';
//                              or --argv-file <JSON array file>; --argv <JSON> is still accepted)
//     node room.mjs pass      --seat <seatDir> --attempt <id>
//     node room.mjs misquoted --seat <seatDir> --attempt <id> --seq N --text "..."
//     node room.mjs assign    --seat <seatDir> --attempt <id> --file <draft.md>
//   Service (run by the user):
//     node room.mjs serve --dir <roomDir> [--tick ms] [--once] [--port n] [--pi-key-stdin]
//                         (hosted Pi key: ROOM_PI_API_KEY in this process's environment, or piped to stdin
//                          with --pi-key-stdin; it is held in memory only and never written to disk.
//                          Without either, a room with hosted seats unprotects the key saved by
//                          `admin pi-key --save`, if there is one)
//   Admin (run by the user; --dir <roomDir> or --id <roomId> under the default rooms root):
//     node room.mjs admin init      --id <id> [--dir <roomDir>] [--preset ...] [--wall s] [--work-wall s] [--max-work n] [--max-tokens n] [--packet-max-bytes n]
//     node room.mjs admin add-seat  --dir <roomDir> --seat <id> --role executor|reviewer|lead|participant --cwd <dir>
//                                   [--agent claude-code|codex-desktop|codex-cli|opencode|gemini-cli|kimi|dsh|pi-user|generic]
//                                   [--wait background|turn_over|manual] [--tier discussion|readonly|workspace|full]
//                                   [--reviews A,B] [--hosted pi:discussion|pi:exec|pi:reviewer]
//                                   [--surface cli|tool:<model-visible tool name>]
//                                   [--wake-thread <codex thread>] [--wake-max n] [--audit codex|claude --thread-id <id> --session-id <id>]
//                                   [--name ..] [--wall s] [--wait-timeout s]
//     node room.mjs admin set-audit --dir <roomDir> --seat <id> --kind codex|claude [--thread-id <id>] [--session-id <id>]
//     node room.mjs admin task|say  --dir <roomDir> --text "..." | --file <path>
//     node room.mjs admin start     --dir <roomDir> --order A,B,A
//     node room.mjs admin cancel|skip|close|reverse|confirm-task [--file <edited draft>] --dir <roomDir>
//     node room.mjs admin interrupt --dir <roomDir> [--text "..."]
//     node room.mjs admin retry     --dir <roomDir> [--seat <id>]   (a seat's turn ran out in a governed room: same seat, fresh attempt)
//     node room.mjs admin wake      --dir <roomDir> --seat <id>
//     node room.mjs admin reassign  --dir <roomDir> --seat <from> --to <seat> [--text "..."]
//     node room.mjs admin reconcile <attemptId> replay|void --dir <roomDir>
//     node room.mjs admin approve-disclose <id> --dir <roomDir>
//     node room.mjs admin deny-disclose <id> --reason "..." --dir <roomDir>
//     node room.mjs admin accept-stale <manifestSha> --dir <roomDir>
//     node room.mjs admin pi-key    --dir <roomDir> --port <n> [--seat <id>]   (key from stdin or ROOM_PI_API_KEY;
//                                   sent over loopback to a service started with --port n; never written to disk)
//     node room.mjs admin pi-key    --save | --status | --forget   (Windows; no --dir: the key of this Windows user.
//                                   --save reads stdin or ROOM_PI_API_KEY, stores only a DPAPI blob at
//                                   <ROOM_DEV_HOME or %USERPROFILE%\room-dev>\secrets\pi-key.dpapi and prints
//                                   SAVED <path> length=<n> sha256=<8 hex>; never the key)
//     node room.mjs admin export    --dir <roomDir> [--out <zip>] [--redact]
//     node room.mjs admin log|show  --dir <roomDir>
//   Audit (run by the user):
//     node room.mjs audit --seat <seatDir> [--packet <id>] [--verbose]
//   Lobby (what the desktop app 圆桌.exe runs in its utility process, app/main.mjs; or by hand):
//     node room.mjs lobby [--port N] [--open]
//                         (loopback page on 127.0.0.1:N, default 7380 or a free port when that is busy, for
//                          creating rooms and seats, opening a room's UI and giving it a task. Prints its URL
//                          once, with the per-launch lobby token in the fragment; --open opens it in the
//                          default browser. Runs until Ctrl+C or the console window closes, or, inside the
//                          app, until the app sends {t:'quit'}; then stops every room it opened)
import fs from 'node:fs';
import { parseArgs } from './lib/common.mjs';

const SEAT_CMDS = new Set(['wait', 'submit', 'status', 'leave', 'artifacts', 'point', 'quote', 'mark', 'verdict', 'disclose', 'pass', 'misquoted', 'assign']);

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
args.__argv = rest;

// The hosted Pi key for `serve --pi-key-stdin`: the first line of stdin, kept in memory only.
// A terminal stdin is refused (no echo-free prompt here); pipe the key in.
function readKeyFromStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  try { text = fs.readFileSync(0, 'utf8'); } catch { return ''; }
  return (text.split(/\r?\n/).find((l) => l.trim()) || '').trim();
}

// `lobby`: the page the desktop app shows (or a browser, for the developer path). The lobby token is
// printed only inside the one URL line; the app parses that line and never logs the token.
async function runLobby(a) {
  let port;
  if (a.port !== undefined) {
    port = Number(a.port);
    if (a.port === true || !Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write('ERROR --port 要是 0 到 65535 的整数\n'); return 9; }
  }
  const { startLobby } = await import('./lib/lobby.mjs');
  const log = (l) => process.stdout.write(`${l}\n`);
  const lobby = await startLobby({ ...(port !== undefined ? { port } : {}), log, openBrowser: a.open === true });
  log(`圆桌启动器：${lobby.url}`);
  // Under the desktop app (utilityProcess: process.parentPort) the app window shows the page, so the
  // browser / console-window hint would only mislead its log.
  if (!process.parentPort) log(a.open === true
    ? '正在默认浏览器里打开上面的地址；没打开就把它复制到浏览器。关闭本窗口或按 Ctrl+C 即退出，并停止从这里打开的房间。'
    : '在浏览器里打开上面的地址。关闭本窗口或按 Ctrl+C 即退出，并停止从这里打开的房间。');
  log(`房间目录：${lobby.roomsRoot}`);
  // Closing the console window arrives as SIGHUP, Ctrl+Break as SIGBREAK (the same set as serve()).
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
  await new Promise((resolve) => { for (const sig of signals) process.once(sig, resolve); });
  log('正在退出：停止从这里打开的房间……');
  await lobby.close();
  log('已退出。');
  return 0;
}

function report(e) {
  if (e && e.exitCode !== undefined && e.name === 'CliError') { process.stderr.write(`ERROR ${e.message}\n`); return e.exitCode; }
  process.stderr.write(`ERROR ${e && e.stack ? e.stack : e}\n`);
  return 9;
}

async function main() {
  if (SEAT_CMDS.has(cmd)) {
    const seat = await import('./lib/seat.mjs');
    seat.scrubEnv(process.env);
    return seat.SEAT_COMMANDS[cmd](args);
  }
  switch (cmd) {
    case 'serve': {
      if (!args.dir || args.dir === true) { process.stderr.write('ERROR serve needs --dir <roomDir>\n'); return 9; }
      const piApiKey = args['pi-key-stdin'] === true ? readKeyFromStdin() : null;
      if (piApiKey === '') { process.stderr.write('ERROR --pi-key-stdin: 标准输入里没有 key（用管道传入，例如 <输出 key 的命令> | node room.mjs serve ... --pi-key-stdin）\n'); return 9; }
      const { serve } = await import('./lib/service.mjs');
      await serve({ roomDir: args.dir, tickMs: Number(args.tick || 400), once: args.once === true, ...(args.port ? { port: Number(args.port) } : {}), ...(piApiKey ? { piApiKey } : {}) });
      return 0;
    }
    case 'admin': {
      const sub = args._[0];
      const a = await import('./lib/admin.mjs');
      const fn = a.ADMIN_COMMANDS[sub];
      if (!fn) { process.stderr.write(`ERROR unknown admin command ${sub || '(none)'}; one of ${Object.keys(a.ADMIN_COMMANDS).join(' ')}\n`); return 9; }
      return fn(args);
    }
    case 'audit': {
      const { cmdAudit } = await import('./lib/audit.mjs');
      await cmdAudit(args);
      return 0;
    }
    case 'lobby': return runLobby(args);
    default:
      process.stdout.write(`usage: node room.mjs <${[...SEAT_CMDS].join('|')}|serve|admin|audit|lobby> ... (see header of room.mjs)\n`);
      return cmd ? 9 : 0;
  }
}

main().then((code) => { process.exitCode = Number.isInteger(code) ? code : 0; }, (e) => { process.exitCode = report(e); });
