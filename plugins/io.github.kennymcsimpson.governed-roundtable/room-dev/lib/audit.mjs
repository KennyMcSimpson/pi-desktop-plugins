// Read-only audit of an agent's native logs (plan §8.3, §7.2, §5.3; INTERFACES §7).
//
// Two questions, answered per packet / per attempt:
//   (A) delivery: did the packet reach the agent's process (the TURN header shows up as a tool
//       result) and did the agent go and read the packet file (a tool call mentions it)?
//   (B) observation: inside the attempt's turn window, which tool calls were writes, which were
//       commands outside the allowlist, which were reads? A write in a review turn taints the verdict.
//
// Everything here is observational. A rejected apply_patch leaves no record, so the report can only
// ever say "未观测到" (not observed), never "no writes happened". Files are opened read-only in Node's
// default share mode (libuv opens with FILE_SHARE_READ|WRITE|DELETE, so an agent that keeps appending
// is never blocked), streamed line by line, closed when done, and limited to the files registered
// for the seat (plus deterministic children: Codex threads named by a SubAgentActivity line of a
// registered rollout, found by exact id in the file name; Claude subagents/ and tool-results/).
// Every file this module opens is reported in `opened`. Registered files can be read
// incrementally: a cursor saved by the previous audit says where to resume (plan §8.3 读法).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOM_FILES as F, readJson, readJsonl, out, fwd } from './common.mjs';
import { codexHome } from './codex.mjs';

export function encodeClaudeProjectDir(cwd) { return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'); }
export function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

// ---------------------------------------------------------------------------------------------
// File access: read-only, streamed, closed when done.
// ---------------------------------------------------------------------------------------------

function walk(dir, depth, acc) {
  if (depth < 0 || !fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, acc); else acc.push(p);
  }
  return acc;
}

// Streams `file` from byte `start`, splitting on LF (a trailing CR is dropped, as readline's
// crlfDelay did). Splitting raw bytes on 0x0a is UTF-8 safe and lets the caller resume later:
//   lines:    lines handed to fn (a final line without LF included)
//   complete: lines that ended in LF
//   end:      byte offset just past the last LF seen (a half-appended last line is not counted
//             there, so the next read starting at `end` sees it again, whole)
//   stopped:  fn returned false
async function eachLine(file, fn, { start = 0 } = {}) {
  const stream = fs.createReadStream(file, { flags: 'r', start });
  const decode = (buf) => { const s = buf.toString('utf8'); return s.endsWith('\r') ? s.slice(0, -1) : s; };
  let n = 0;
  let complete = 0;
  let pos = start;
  let end = start;
  let carry = [];
  let stopped = false;
  try {
    outer: for await (const chunk of stream) {
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl === -1) { if (from < chunk.length) carry.push(chunk.subarray(from)); break; }
        const part = chunk.subarray(from, nl);
        const buf = carry.length ? Buffer.concat([...carry, part]) : part;
        carry = [];
        n++; complete++;
        end = pos + nl + 1;
        if (fn(decode(buf), n) === false) { stopped = true; break outer; }
        from = nl + 1;
      }
      pos += chunk.length;
    }
    if (!stopped && carry.length) { n++; if (fn(decode(Buffer.concat(carry)), n) === false) stopped = true; }
  } finally { stream.destroy(); }
  return { lines: n, complete, end, stopped };
}

// Where to resume a registered file from a cursor saved by an earlier audit ({offset, lines, ...}).
// A cursor past the end of the file (the file shrank or was replaced) is discarded: read from 0.
function resumePoint(file, prev) {
  const size = fs.statSync(file).size;
  const ok = prev && typeof prev === 'object' && Number.isInteger(prev.offset) && prev.offset >= 0
    && prev.offset <= size && Number.isInteger(prev.lines) && prev.lines >= 0;
  if (!ok) return { size, cursor: null, reset: !!prev, unchanged: false };
  return { size, cursor: prev, reset: false, unchanged: prev.offset === size && size > 0 };
}

async function fileContains(file, needle) {
  let found = false;
  await eachLine(file, (l) => { if (l.includes(needle)) { found = true; return false; } return true; });
  return found;
}

// First line of a file, parsed as JSON. Reads in chunks until the first newline or `maxBytes`,
// then closes. Used to probe Codex rollout headers (session_meta) without streaming the whole file.
// Real headers carry the full base instructions (measured ~23 KB on Codex 0.159), so the cap is
// generous; a header longer than the cap is reported as unreadable (null), never guessed at.
export function readSessionHeader(file, maxBytes = 1 << 20) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(Math.min(65536, maxBytes));
    const parts = [];
    let total = 0;
    let nlAt = -1;
    while (total < maxBytes) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - total), total);
      if (n <= 0) break;
      const piece = Buffer.from(chunk.subarray(0, n));
      const nl = piece.indexOf(0x0a);
      if (nl !== -1) { parts.push(piece.subarray(0, nl)); nlAt = total + nl; break; }
      parts.push(piece);
      total += n;
    }
    if (nlAt === -1 && total >= maxBytes) return null;
    const first = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
    try { return JSON.parse(first); } catch { return null; }
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

// Thread id(s) a Codex rollout header says it descends from (plan §8.3: parent_thread_id / forked_from_id).
export function codexParentIds(header) {
  if (!header || header.type !== 'session_meta' || !header.payload) return [];
  const p = header.payload;
  const ids = new Set();
  if (p.parent_thread_id) ids.add(p.parent_thread_id);
  if (p.forked_from_id) ids.add(p.forked_from_id);
  const spawn = p.source && typeof p.source === 'object' && p.source.subagent && p.source.subagent.thread_spawn;
  if (spawn && spawn.parent_thread_id) ids.add(spawn.parent_thread_id);
  return [...ids];
}

function codexThreadIdOf(header) {
  if (!header || header.type !== 'session_meta' || !header.payload) return null;
  return header.payload.id || header.payload.session_id || null;
}

// Codex thread ids are canonical UUIDs (the id the user picked in Desktop). Rollout files are named
// rollout-<timestamp>-<uuid>.jsonl; the id is taken from the anchored tail of the name and
// compared exactly, never by substring (a short id like '2026' would match every rollout).
export const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export function isCodexThreadId(id) { return typeof id === 'string' && CODEX_THREAD_ID_RE.test(id); }
export function rolloutThreadId(file) {
  const m = ROLLOUT_ID_RE.exec(path.basename(String(file || '')));
  return m ? m[1].toLowerCase() : null;
}

// Rollouts under sessions/ and archived_sessions/ indexed by the thread id in their file name.
// Directory listing only: no file is opened.
function indexRolloutsById(home) {
  const byId = new Map();
  for (const root of ['sessions', 'archived_sessions']) {
    for (const f of walk(path.join(home, root), 4, []).sort()) {
      const id = rolloutThreadId(f);
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(f);
    }
  }
  return byId;
}

// Child thread ids a rollout line names: event_msg item_* carrying a SubAgentActivity item with an
// agent_thread_id (Codex writes one when spawn_agent starts a child thread).
function namedChildIds(line) {
  if (!line.includes('SubAgentActivity')) return [];
  let o;
  try { o = JSON.parse(line); } catch { return []; }
  const it = o && o.payload && o.payload.item;
  if (!it || it.type !== 'SubAgentActivity' || !isCodexThreadId(it.agent_thread_id)) return [];
  return [it.agent_thread_id.toLowerCase()];
}

// Codex thread `threadId` and the child threads deterministically reachable from it (plan §8.3).
// Only registered rollouts are opened:
//   1. the thread's own rollout(s) are found by exact id in the file name (names only);
//   2. those rollouts are streamed for SubAgentActivity lines naming a child thread id;
//   3. each named child's rollout is found by exact id in the file name, its header is read to
//      confirm the id and to take parent_thread_id / forked_from_id and
//      subagent_history_start_ordinal, and its own rollout is streamed in turn (grandchildren).
// A fork whose parent log does not name it is not deterministically reachable: it is not looked
// for (no header scan of other rollouts) and coverage of such forks is reported as unknown.
// `opened` lists every file this call opened; on a fresh state it equals the registered set.
// opts.childThreads [{id, parent}] and opts.discoveryCursors {file: {offset, lines, size, threadId,
// inheritedPrefix}} come from an earlier call (its `persist`): named children are remembered, and
// each rollout is read for new names only from where the previous call stopped. `since` is
// accepted for compatibility and not used: nothing is selected by modification time any more.
export async function findCodexChildThreads(threadId, since, home = codexHome(), opts = {}) {
  void since;
  const root = String(threadId || '').toLowerCase();
  const empty = { threadFiles: [], children: [], opened: [], missing: [], rejected: [], persist: { childThreads: [], discoveryCursors: {} } };
  if (!isCodexThreadId(root)) return empty;
  const byId = indexRolloutsById(home);
  const prevCursors = opts.discoveryCursors && typeof opts.discoveryCursors === 'object' ? opts.discoveryCursors : {};
  const opened = [];
  const markOpened = (f) => { if (!opened.includes(f)) opened.push(f); };
  const threadFiles = [];
  const children = [];
  const missing = [];
  const rejected = [];
  const cursors = {};
  const parentOf = new Map(); // child id -> id of the thread whose log named it
  for (const c of Array.isArray(opts.childThreads) ? opts.childThreads : []) {
    if (c && isCodexThreadId(c.id) && c.id.toLowerCase() !== root) parentOf.set(c.id.toLowerCase(), isCodexThreadId(c.parent) ? c.parent.toLowerCase() : root);
  }
  const queue = [root];
  const done = new Set();
  const enqueue = (id, namer) => { if (id === root || parentOf.has(id)) return; parentOf.set(id, namer); queue.push(id); };
  for (const id of parentOf.keys()) queue.push(id);
  while (queue.length) {
    const id = queue.shift();
    if (done.has(id)) continue;
    done.add(id);
    const files = byId.get(id) || [];
    if (id !== root && !files.length) missing.push({ id, parent: parentOf.get(id) });
    for (const f of files) {
      const prev = prevCursors[f];
      let rp;
      try { rp = resumePoint(f, prev && prev.threadId === id ? prev : null); } catch (e) { rejected.push({ file: f, id, error: e.code || String(e) }); continue; }
      let info = rp.cursor;
      if (!info) {
        // Header check, on a file already selected by exact id (bounded read).
        const h = readSessionHeader(f);
        markOpened(f);
        const hid = codexThreadIdOf(h);
        if (!hid || String(hid).toLowerCase() !== id) { rejected.push({ file: f, id, headerId: hid || null }); continue; }
        const start = h.payload.subagent_history_start_ordinal;
        // Prefer the parent the header names when it is a thread already known here (a fork of a
        // fork names its direct parent); otherwise the thread whose log named this one.
        const parents = codexParentIds(h).map((p) => String(p).toLowerCase());
        const known = parents.find((p) => p === root || parentOf.has(p));
        info = { offset: 0, lines: 0, threadId: id, inheritedPrefix: Number.isInteger(start) ? start : null, parent: id === root ? null : (known || parentOf.get(id) || null) };
      }
      if (id === root) threadFiles.push(f);
      else children.push({ file: f, id, parent: info.parent || parentOf.get(id), inheritedPrefix: Number.isInteger(info.inheritedPrefix) ? info.inheritedPrefix : null });
      if (rp.unchanged && rp.cursor) { cursors[f] = { ...info, size: rp.size }; continue; }
      markOpened(f);
      const named = [];
      let r;
      // A file that vanished mid-read stays registered (the attempt audit will report the error);
      // it gets no cursor, so the next call reads it from the start.
      try { r = await eachLine(f, (line) => { named.push(...namedChildIds(line)); }, { start: info.offset }); } catch { continue; }
      cursors[f] = { ...info, offset: r.end, lines: info.lines + r.complete, size: Math.max(rp.size, r.end) };
      for (const c of named) enqueue(c, id);
    }
  }
  const childThreads = [...parentOf].map(([cid, parent]) => ({ id: cid, parent }));
  return { threadFiles, children, opened, missing, rejected, persist: { childThreads, discoveryCursors: cursors } };
}

// Claude transcripts known at seat creation: [{name, size, mtimeMs}]. A transcript listed there
// whose size and mtime are unchanged is not a candidate (plan §8.3: only files created or modified
// after the seat was registered are opened while looking for the first packet id).
function unchangedSinceBaseline(file, baseline) {
  if (!Array.isArray(baseline) || !baseline.length) return false;
  const b = baseline.find((x) => x && x.name === path.basename(file));
  if (!b) return false;
  const st = fs.statSync(file);
  return st.size === b.size && Math.trunc(st.mtimeMs) === Math.trunc(b.mtimeMs);
}

// locateFiles(audit, since, firstPacketId)
//   -> { files, opened, candidates, children?, missing?, note, sessionId?, persist? }
//   files:      the registered set the attempt audit reads.
//   opened:     every file this call opened (content or header). Codex: ⊆ files (equal on a fresh
//               state). Claude: ⊆ files ∪ candidates.
//   candidates: Claude transcripts probed for the first packet id (Codex: always empty).
//   persist:    fields the caller should merge into seat.audit (through its guarded seat store) so
//               the next call does not repeat work: Claude {sessionId} once the transcript is found
//               by packet id; Codex {childThreads, discoveryCursors}.
export async function locateFiles(audit, since, firstPacketId) {
  const files = [];
  const opened = [];
  if (audit.kind === 'codex') {
    if (!audit.threadId) return { files, opened, candidates: [], note: 'no threadId registered' };
    if (!isCodexThreadId(audit.threadId)) {
      return { files, opened, candidates: [], note: `codex threadId ${JSON.stringify(String(audit.threadId))} is not a canonical thread uuid; nothing opened` };
    }
    const kids = await findCodexChildThreads(audit.threadId, since, codexHome(), { childThreads: audit.childThreads, discoveryCursors: audit.discoveryCursors });
    for (const f of [...kids.threadFiles, ...kids.children.map((c) => c.file)]) if (!files.includes(f)) files.push(f);
    const extra = [];
    if (kids.missing.length) extra.push(`${kids.missing.length} named child thread(s) without a rollout`);
    if (kids.rejected.length) extra.push(`${kids.rejected.length} rollout(s) whose header id differs from the file name, not registered`);
    extra.push('forks not named by a registered rollout: unknown');
    return {
      files, opened: kids.opened, candidates: [], children: kids.children, missing: kids.missing, rejected: kids.rejected,
      note: `codex thread ${audit.threadId}${kids.children.length ? ` +${kids.children.length} child thread(s)` : ''}; ${extra.join('; ')}`,
      persist: kids.persist,
    };
  }
  if (audit.kind === 'claude') {
    const dir = path.join(claudeHome(), 'projects', encodeClaudeProjectDir(audit.cwd));
    if (!fs.existsSync(dir)) return { files, opened, candidates: [], note: `claude project dir not found: ${dir}` };
    let sessionFile = null;
    let candidates = [];
    if (audit.sessionId && fs.existsSync(path.join(dir, `${audit.sessionId}.jsonl`))) {
      sessionFile = path.join(dir, `${audit.sessionId}.jsonl`);
    } else {
      if (!firstPacketId) return { files, opened, candidates, note: `claude project dir ${dir}: no packet issued yet, nothing opened` };
      const mtime = new Map();
      candidates = fs.readdirSync(dir).filter((e) => e.endsWith('.jsonl')).map((e) => path.join(dir, e))
        .filter((p) => fs.statSync(p).isFile())
        .filter((p) => { const m = fs.statSync(p).mtimeMs; mtime.set(p, m); return !since || m >= since; })
        .filter((p) => !unchangedSinceBaseline(p, audit.knownTranscripts))
        .sort((a, b) => mtime.get(b) - mtime.get(a));
      for (const c of candidates) {
        opened.push(c);
        if (await fileContains(c, firstPacketId)) { sessionFile = c; break; }
      }
    }
    if (!sessionFile) return { files, opened, candidates, note: `claude project dir ${dir}: no transcript contains the first packet id (${opened.length} candidates checked)` };
    files.push(sessionFile);
    // Deterministic children: <session>/subagents/**/*.jsonl (workflow agents sit two levels down,
    // subagents/workflows/<wf>/agent-*.jsonl) and <session>/tool-results/*.txt.
    const sub = sessionFile.replace(/\.jsonl$/, '');
    for (const [child, depth, exts] of [['subagents', 3, ['.jsonl']], ['tool-results', 1, ['.txt']]]) {
      const d = path.join(sub, child);
      if (!fs.existsSync(d)) continue;
      for (const g of walk(d, depth, []).sort()) if (exts.some((x) => g.endsWith(x))) files.push(g);
    }
    const sessionId = path.basename(sessionFile, '.jsonl');
    // Found by packet id: the caller registers it (plan §8.3 命中的登记为本席位会话), so later calls
    // take the sessionId path above and never probe candidates again.
    const persist = audit.sessionId === sessionId ? undefined : { sessionId };
    return { files, opened: [...new Set([...opened, ...files])], candidates, note: `claude session ${sessionId} in ${dir}`, sessionId, persist };
  }
  return { files, opened, note: `unknown audit kind ${audit.kind}` };
}

// ---------------------------------------------------------------------------------------------
// Command parsing (pure).
// ---------------------------------------------------------------------------------------------

// argv prefixes that are treated as reads. Anything else a command runs is "unknown-exec":
// not a write, not clean. `node <room.mjs>` / `room.cmd` is the room's own seat command, excluded
// from observation (plan §8.3).
export const READ_ONLY_ALLOWLIST = [
  ['get-content'], ['cat'], ['type'], ['rg'], ['grep'], ['findstr'], ['select-string'],
  ['ls'], ['dir'], ['get-childitem'], ['get-item'], ['test-path'], ['resolve-path'], ['pwd'], ['get-location'],
  ['head'], ['tail'], ['wc'], ['measure-object'], ['select-object'], ['sort-object'], ['format-table'], ['format-list'], ['out-null'],
  ['git', 'diff'], ['git', 'status'], ['git', 'log'], ['git', 'show'], ['git', 'ls-files'], ['git', 'rev-parse'], ['git', 'blame'],
];
// Wrappers that are stripped before matching (author machine: `rtk proxy <cmd>`).
export const COMMAND_WRAPPERS = [['rtk', 'proxy']];

// Commands whose purpose is to change files. Seen in a turn they are observed writes, not merely
// commands outside the allowlist.
export const WRITE_COMMANDS = new Set([
  'set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'move-item', 'copy-item', 'rename-item',
  'clear-content', 'tee-object', 'export-csv',
  'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy', 'ren', 'rename',
  'mkdir', 'md', 'touch', 'tee', 'truncate', 'ln',
]);
export const GIT_WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'checkout', 'switch', 'restore', 'reset', 'rm', 'mv', 'apply', 'am', 'stash', 'clean',
  'merge', 'rebase', 'cherry-pick', 'revert', 'pull', 'init', 'clone',
]);
// Flags that turn an allowlisted read into something that writes a file or runs a program.
const UNSAFE_FLAGS = [/^--output(=|$)/i, /^--ext-diff$/i, /^--pre(=|$)/i, /^--hostname-bin(=|$)/i];
const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'dash']);
const MAX_NEST = 4;

function baseLower(tok) {
  if (typeof tok !== 'string') return '';
  const b = tok.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();
  return b.replace(/\.(exe|cmd|bat|com)$/, '');
}
function baseWithExt(tok) {
  return typeof tok === 'string' ? tok.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase() : '';
}

// Shell-ish tokenizer: whitespace separated, single/double quotes group. No escape processing
// (Windows paths carry backslashes). Quotes are dropped from tokens.
export function tokenizeCommand(str) {
  const toks = [];
  let cur = '';
  let quote = null;
  let quoted = false;
  for (const c of String(str || '')) {
    if (quote) { if (c === quote) quote = null; else cur += c; continue; }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (/\s/.test(c)) { if (cur || quoted) { toks.push(cur); cur = ''; quoted = false; } continue; }
    cur += c;
  }
  if (cur || quoted) toks.push(cur);
  return toks;
}

const NULL_TARGET = /^(\$null|\/dev\/null|nul)$/i;

// Split a command line into pipeline/chain segments on unquoted  && || ; | & and newlines (a single
// `&` separates commands in cmd.exe and backgrounds one in sh; either way what follows runs).
// Redirections are taken out of the segments and reported: `redirect` is true when one targets a
// file (`> x`, `>> x`, `2> x`, `&> x`); fd duplication (`2>&1`) and null sinks ($null, /dev/null,
// nul) are benign. `subexpr` flags $( ) or a backtick, `scriptblock` an unquoted `{`: either can run
// something the tokens do not show.
export function splitCommandChain(str) {
  const segments = [];
  const redirectTargets = [];
  let cur = '';
  let quote = null;
  let subexpr = false;
  let scriptblock = false;
  const s = String(str || '');
  const isBreak = (ch) => ch === undefined || /\s/.test(ch) || ch === ';' || ch === '|' || ch === '&';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '>' || (c === '&' && next === '>')) {
      if (c === '&') i++;
      // A stream number glued to the operator (2>, 3>>, *>) belongs to the operator.
      if (/(^|\s)[0-9*]$/.test(cur)) cur = cur.slice(0, -1);
      i++;
      if (s[i] === '>') i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      if (s[i] === '&') { i++; while (/[0-9]/.test(s[i] || '')) i++; i--; continue; }
      let target = '';
      let q = null;
      while (i < s.length) {
        const ch = s[i];
        if (q) { if (ch === q) q = null; else target += ch; i++; continue; }
        if (ch === '"' || ch === "'") { q = ch; i++; continue; }
        if (isBreak(ch)) break;
        target += ch; i++;
      }
      i--;
      redirectTargets.push({ target, benign: !target || NULL_TARGET.test(target) });
      continue;
    }
    if ((c === '$' && next === '(') || c === '`') { subexpr = true; cur += c; continue; }
    if (c === '{') { scriptblock = true; cur += c; continue; }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) { segments.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  segments.push(cur);
  const fileTargets = redirectTargets.filter((r) => !r.benign);
  return {
    segments: segments.map((x) => x.trim()).filter(Boolean),
    redirect: fileTargets.length > 0,
    redirectTargets,
    subexpr,
    scriptblock,
  };
}

function stripWrappers(tokens, wrappers) {
  let t = tokens;
  let changed = true;
  while (changed && t.length) {
    changed = false;
    for (const w of wrappers) {
      if (w.length <= t.length && w.every((x, i) => baseLower(t[i]) === x)) { t = t.slice(w.length); changed = true; }
    }
  }
  return t;
}

// `git -C <dir> --no-pager status` -> ['git', 'status']; `git -c k=v ...` returns null (a config
// override can name a program to run).
function normaliseGit(t) {
  const res = [t[0]];
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    if (t[i] === '-C') { i += 2; continue; }
    const f = t[i].toLowerCase();
    if (t[i] === '-c' || f.startsWith('--config-env') || f.startsWith('--exec-path')) return null;
    if (f === '--no-pager' || t[i] === '-p' || t[i] === '-P' || f === '--paginate' || f === '--no-optional-locks') { i++; continue; }
    if (f.startsWith('--git-dir=') || f.startsWith('--work-tree=')) { i++; continue; }
    return null;
  }
  return res.concat(t.slice(i));
}

const PS_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath', '-destination', '-target']);
const PS_VALUE_FLAGS = new Set(['-value', '-encoding', '-itemtype', '-erroraction', '-filter', '-include', '-exclude', '-inputobject', '-delimiter']);

// Best-effort target paths of a write command, for evidence only.
function writeCommandPaths(t) {
  const verb = baseLower(t[0]);
  const psStyle = verb.includes('-');
  const res = [];
  for (let i = 1; i < t.length; i++) {
    const lt = t[i].toLowerCase();
    if (PS_PATH_FLAGS.has(lt)) { if (t[i + 1] !== undefined) res.push(t[++i]); continue; }
    if (lt.startsWith('-')) { if (PS_VALUE_FLAGS.has(lt)) i++; continue; }
    if (/^\/[a-z0-9:]{1,3}$/i.test(t[i])) continue; // cmd-style switch (/s, /q, /y)
    if (psStyle && res.length) continue;
    res.push(t[i]);
  }
  return res;
}

const CLASS_RANK = { room: 0, read: 1, unknown: 2, write: 3 };

// One argv-shaped command (wrappers allowed). Returns {cls:'read'|'room'|'write'|'unknown', reason, paths?, command?}.
function classifySegment(tokens, opts, depth) {
  const t = stripWrappers(tokens, opts.wrappers || COMMAND_WRAPPERS);
  if (!t.length) return { cls: 'read', reason: 'empty' };
  const first = baseLower(t[0]);
  if (SHELLS.has(first)) {
    if (depth >= MAX_NEST) return { cls: 'unknown', reason: 'shell nesting too deep' };
    const u = unwrapShellArgv(t);
    if (u.opaque) return { cls: 'unknown', reason: u.reason };
    const r = classifyCommandLine(u.command, opts, depth + 1);
    return { ...r, command: u.command };
  }
  if ((first === 'node' && t.length >= 2 && baseWithExt(t[1]) === 'room.mjs') || baseWithExt(t[0]) === 'room.cmd') {
    return { cls: 'room', reason: 'room command' };
  }
  if (WRITE_COMMANDS.has(first)) return { cls: 'write', reason: `write command: ${first}`, paths: writeCommandPaths(t) };
  if (first === 'sed' && t.slice(1).some((x) => /^-i/.test(x) || x === '--in-place')) return { cls: 'write', reason: 'write command: sed -i', paths: [] };
  let m = t;
  if (first === 'git') {
    const g = normaliseGit(t);
    if (!g) return { cls: 'unknown', reason: 'git with configuration override' };
    m = g;
    if (m[1] && GIT_WRITE_SUBCOMMANDS.has(m[1].toLowerCase())) return { cls: 'write', reason: `write command: git ${m[1].toLowerCase()}`, paths: [] };
  }
  const unsafe = m.find((x) => UNSAFE_FLAGS.some((re) => re.test(x)));
  for (const prefix of (opts.allowlist || READ_ONLY_ALLOWLIST)) {
    if (prefix.length > m.length) continue;
    if (prefix.every((x, i) => (i === 0 ? first : baseLower(m[i])) === String(x).toLowerCase())) {
      if (unsafe) return { cls: 'unknown', reason: `unsafe flag ${unsafe}` };
      return { cls: 'read', reason: prefix.join(' ') };
    }
  }
  return { cls: 'unknown', reason: `not in allowlist: ${first || t[0]}` };
}

function classifyCommandLine(cmd, opts, depth) {
  const { segments, redirect, redirectTargets, subexpr, scriptblock } = splitCommandChain(cmd);
  let cls = segments.length ? 'room' : 'read';
  let reason = segments.length ? 'room command' : 'empty';
  const paths = [];
  const bump = (c, r) => { if (CLASS_RANK[c] > CLASS_RANK[cls]) { cls = c; reason = r; } };
  for (const seg of segments) {
    const r = classifySegment(tokenizeCommand(seg), opts, depth);
    if (r.paths) paths.push(...r.paths);
    bump(r.cls, r.reason);
  }
  // A chain made only of room commands stays excluded (cls 'room'); room + reads ranks as a read.
  if (cls === 'read' && segments.length > 1) reason = 'allowlist';
  if (subexpr) bump('unknown', 'sub-expression');
  if (scriptblock) bump('unknown', 'script block');
  if (redirect) {
    for (const r of redirectTargets) if (!r.benign) paths.push(r.target);
    bump('write', 'redirection');
  }
  return { cls, reason, segments, paths };
}

function shape(r, command) {
  return {
    readOnly: r.cls === 'read' || r.cls === 'room',
    write: r.cls === 'write',
    roomOnly: r.cls === 'room',
    class: r.cls,
    reason: r.reason,
    segments: r.segments,
    paths: r.paths || [],
    command,
  };
}

// Is this command line, as a whole, made only of allowlisted reads (or the room's own commands)?
// `write` is true when a segment is a known write command or output is redirected to a file.
export function isReadOnlyCommand(cmd, opts = {}) {
  const r = classifyCommandLine(cmd, opts, 0);
  return shape(r, String(cmd ?? ''));
}

// argv as recorded by the agent (CommandExecution.command, local_shell_call.action.command).
// A shell wrapper (powershell -Command, cmd /c, bash -c) is unwrapped to its inner command string.
export function unwrapShellArgv(argv) {
  if (!Array.isArray(argv) || !argv.length) return { command: '', opaque: false };
  const exe = baseLower(argv[0]);
  const rest = argv.slice(1).map(String);
  if (exe === 'powershell' || exe === 'pwsh') {
    if (rest.some((a) => /^-(e|ec|en|enc\w*)$/i.test(a))) return { command: null, opaque: true, reason: 'encoded command' };
    const i = rest.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
    if (i !== -1) return { command: rest.slice(i + 1).join(' '), opaque: false };
    if (rest.some((a) => /^-f(i(le?)?)?$/i.test(a))) return { command: null, opaque: true, reason: 'script file' };
    return { command: rest.filter((a) => !/^-(noprofile|nologo|noninteractive|nop|noni)$/i.test(a)).join(' '), opaque: false };
  }
  if (exe === 'cmd') {
    const i = rest.findIndex((a) => /^\/[a-z]*[ck]$/i.test(a));
    if (i !== -1) return { command: rest.slice(i + 1).join(' '), opaque: false };
    return { command: rest.join(' '), opaque: false };
  }
  if (['bash', 'sh', 'zsh', 'dash'].includes(exe)) {
    const i = rest.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    if (i !== -1 && rest[i + 1] !== undefined) return { command: rest[i + 1], opaque: false };
    if (rest.length) return { command: null, opaque: true, reason: 'script file' };
    return { command: '', opaque: false };
  }
  return { argv, opaque: false };
}

export function isReadOnlyArgv(argv, opts = {}) {
  if (!Array.isArray(argv)) return isReadOnlyCommand(String(argv ?? ''), opts);
  const t = argv.map(String);
  const stripped = stripWrappers(t, opts.wrappers || COMMAND_WRAPPERS);
  const r = classifySegment(t, opts, 0);
  const u = stripped.length && SHELLS.has(baseLower(stripped[0])) ? unwrapShellArgv(stripped) : null;
  const command = u ? (u.opaque ? null : u.command) : t.join(' ');
  return shape(r, command);
}

// Codex code-mode: the `exec` custom tool takes JS source; commands sit in tools.exec_command({cmd:"..."}).
//   commands:    literal cmd strings
//   opaque:      template literals with ${...} interpolation (the command is not knowable)
//   unresolved:  exec_command( calls whose cmd is not a literal at all
//   stdinCalls:  write_stdin( calls (input typed into a running process)
//   writeHints:  write-ish tool or API calls in the code (string contents are ignored)
const JS_WRITE_HINTS = ['apply_patch', 'write_file', 'create_file', 'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'unlinkSync', 'unlink', 'rmSync', 'renameSync', 'copyFileSync', 'mkdirSync'];
function blankJsStrings(s) {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '""');
}
export function extractCodexExecCommands(src) {
  const commands = [];
  const opaque = [];
  const writeHints = [];
  const s = String(src || '');
  const re = /exec_command\s*\(\s*\{[^}]*?\bcmd\s*:\s*("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[2] !== undefined) { try { commands.push(JSON.parse(`"${m[2]}"`)); } catch { commands.push(m[2]); } }
    else if (m[3] !== undefined) commands.push(m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    else if (m[4].includes('${')) opaque.push(m[4]);
    else commands.push(m[4]);
  }
  const code = blankJsStrings(s);
  const calls = (code.match(/\bexec_command\s*\(/g) || []).length;
  const unresolved = Math.max(0, calls - commands.length - opaque.length);
  const stdinCalls = (code.match(/\bwrite_stdin\s*\(/g) || []).length;
  for (const hint of JS_WRITE_HINTS) {
    if (new RegExp(`\\b${hint}\\s*\\(`).test(code)) writeHints.push(hint);
  }
  return { commands, opaque, unresolved, stdinCalls, writeHints };
}

// Paths named by an apply_patch body (*** Add File: / *** Update File: / *** Delete File: / *** Move to:).
export function parsePatchPaths(patch) {
  const res = [];
  const re = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+?)\r?$/gm;
  let m;
  while ((m = re.exec(String(patch || '')))) {
    const op = m[1] === 'Move to' ? 'move' : m[1].split(' ')[0].toLowerCase();
    res.push({ op, path: m[2].trim() });
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Line classification (pure).
// ---------------------------------------------------------------------------------------------

const KIND_RANK = { write: 3, 'unknown-exec': 2, read: 1, other: 0 };

function execItem(source, command, argvOrNull, opts, callId) {
  const r = argvOrNull ? isReadOnlyArgv(argvOrNull, opts) : isReadOnlyCommand(command, opts);
  const cmd = argvOrNull ? (r.command ?? argvOrNull.join(' ')) : command;
  const base = { source, command: cmd, reason: r.reason, ...(callId ? { callId } : {}) };
  if (r.write) return { kind: 'write', paths: r.paths, ...base };
  if (r.roomOnly) return { kind: 'other', ...base, source: `${source}/room` };
  return { kind: r.readOnly ? 'read' : 'unknown-exec', ...base };
}

function execFromCommandField(source, cmd, opts, callId) {
  if (Array.isArray(cmd)) return execItem(source, null, cmd, opts, callId);
  return execItem(source, String(cmd ?? ''), null, opts, callId);
}

function parseArgs(p) {
  if (p.arguments === undefined) return {};
  if (typeof p.arguments === 'object' && p.arguments) return p.arguments;
  try { return JSON.parse(p.arguments); } catch { return {}; }
}

function classifyCodex(obj, opts) {
  const p = obj.payload || {};
  const t = p.type;
  if (obj.type === 'event_msg') {
    if (t === 'item_completed' && p.item) {
      const it = p.item;
      if (it.type === 'FileChange') return [{ kind: 'write', source: 'FileChange', paths: Object.keys(it.changes || {}), status: it.status, callId: it.id }];
      if (it.type === 'CommandExecution') return [execFromCommandField('CommandExecution', it.command, opts, it.id)];
      return [{ kind: 'other', source: it.type }];
    }
    if (t === 'patch_apply_begin' || t === 'patch_apply_end') return [{ kind: 'write', source: t, paths: Object.keys(p.changes || {}), callId: p.call_id }];
    if (t === 'exec_command_begin' && p.command) return [execFromCommandField('exec_command_begin', p.command, opts, p.call_id)];
    return [{ kind: 'other', source: `event_msg/${t}` }];
  }
  if (obj.type === 'response_item') {
    const callId = p.call_id;
    if (t === 'function_call') {
      const args = parseArgs(p);
      if (p.name === 'exec_command' || p.name === 'shell_command') return [execItem('function_call/' + p.name, String(args.cmd ?? args.command ?? ''), null, opts, callId)];
      if (p.name === 'shell' && Array.isArray(args.command)) return [execItem('function_call/shell', null, args.command, opts, callId)];
      if (p.name === 'write_stdin') return [{ kind: 'unknown-exec', source: 'function_call/write_stdin', command: String(args.chars ?? '').slice(0, 200), reason: 'input to a running process', callId }];
      if (p.name === 'apply_patch') return [{ kind: 'write', source: 'function_call/apply_patch', paths: parsePatchPaths(args.input ?? args.patch ?? '').map((x) => x.path), callId }];
      if (p.name === 'write_file' || p.name === 'create_file') return [{ kind: 'write', source: `function_call/${p.name}`, paths: [args.path || args.file_path || ''].filter(Boolean), callId }];
      return [{ kind: 'other', source: `function_call/${p.name}` }];
    }
    if (t === 'custom_tool_call') {
      if (p.name === 'apply_patch') return [{ kind: 'write', source: 'custom_tool_call/apply_patch', paths: parsePatchPaths(p.input).map((x) => x.path), callId }];
      if (p.name === 'exec') {
        const x = extractCodexExecCommands(p.input);
        const src = 'custom_tool_call/exec';
        const items = x.commands.map((c) => execItem(src, c, null, opts));
        for (const o of x.opaque) items.push({ kind: 'unknown-exec', source: src, command: o, reason: 'template interpolation' });
        for (let i = 0; i < x.unresolved; i++) items.push({ kind: 'unknown-exec', source: src, command: String(p.input || '').slice(0, 200), reason: 'cmd is not a literal' });
        for (let i = 0; i < x.stdinCalls; i++) items.push({ kind: 'unknown-exec', source: src, command: String(p.input || '').slice(0, 200), reason: 'input to a running process' });
        if (x.writeHints.length) items.push({ kind: 'write', source: src, paths: [], hints: x.writeHints, detail: String(p.input || '').slice(0, 200), callId });
        if (!items.length) items.push({ kind: 'unknown-exec', source: src, command: String(p.input || '').slice(0, 200), reason: 'no exec_command literal found' });
        return items;
      }
      return [{ kind: 'other', source: `custom_tool_call/${p.name}` }];
    }
    if (t === 'local_shell_call') {
      const cmd = p.action && p.action.command;
      return [execFromCommandField('local_shell_call', cmd, opts, callId)];
    }
    return [{ kind: 'other', source: `response_item/${t}` }];
  }
  return [{ kind: 'other', source: obj.type || 'unknown' }];
}

const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CLAUDE_EXEC_TOOLS = new Set(['Bash', 'PowerShell']);
const CLAUDE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function classifyClaude(obj, opts) {
  if (obj.type !== 'assistant') return [{ kind: 'other', source: obj.type || 'unknown' }];
  const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
  const items = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    const input = b.input || {};
    if (CLAUDE_WRITE_TOOLS.has(b.name)) items.push({ kind: 'write', source: `tool_use/${b.name}`, paths: [input.file_path || input.notebook_path || ''].filter(Boolean), toolUseId: b.id, callId: b.id });
    else if (CLAUDE_EXEC_TOOLS.has(b.name)) items.push({ ...execItem(`tool_use/${b.name}`, String(input.command || ''), null, opts, b.id), toolUseId: b.id });
    else if (CLAUDE_READ_TOOLS.has(b.name)) items.push({ kind: 'read', source: `tool_use/${b.name}`, paths: [input.file_path || input.path || input.pattern || ''].filter(Boolean), toolUseId: b.id });
    else items.push({ kind: 'other', source: `tool_use/${b.name}`, toolUseId: b.id });
  }
  return items.length ? items : [{ kind: 'other', source: 'assistant' }];
}

// classifyWrites(kind, lineObj) -> { kind: 'write'|'unknown-exec'|'read'|'other', detail, items }
// `items` holds one entry per tool call found on the line; `kind` is the most severe of them.
export function classifyWrites(kind, lineObj, opts = {}) {
  if (!lineObj || typeof lineObj !== 'object') return { kind: 'other', detail: 'not an object', items: [] };
  const items = kind === 'claude' ? classifyClaude(lineObj, opts) : classifyCodex(lineObj, opts);
  let top = items[0];
  for (const it of items) if (KIND_RANK[it.kind] > KIND_RANK[top.kind]) top = it;
  const detail = top.kind === 'write' ? `${top.source} ${(top.paths || []).join(', ') || top.command || ''}`.trim()
    : top.kind === 'other' ? top.source
      : `${top.source} ${top.command || ''}`.trim();
  return { kind: top.kind, detail, items };
}

// ---------------------------------------------------------------------------------------------
// Packet delivery (§7.2) and attempt observation (§5.3).
// ---------------------------------------------------------------------------------------------

// Which side of a tool exchange a line belongs to: "call" (the model asked a tool) or "result" (a tool answered).
function classifyLine(kind, obj) {
  if (kind === 'claude') {
    if (obj.type === 'assistant') return 'call';
    if (obj.type === 'user') return 'result';
    return 'other';
  }
  const p = obj.payload || {};
  const t = p.type || obj.type;
  if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(t)) return 'call';
  if (['function_call_output', 'custom_tool_call_output'].includes(t)) return 'result';
  if (obj.type === 'event_msg') return 'event';
  return 'other';
}

function packetPathForms(packetPath) {
  if (!packetPath) return [];
  const slash = String(packetPath).replace(/\\/g, '/');
  const back = slash.replace(/\//g, '\\');
  return [...new Set([slash, back, back.replace(/\\/g, '\\\\')].map((x) => x.toLowerCase()))];
}

function isToolResultsText(file) {
  return file.endsWith('.txt') && path.basename(path.dirname(file)) === 'tool-results';
}

const mentionsWaitIn = (s) => s.includes('wait --seat') || s.includes('TURN attempt=');
const mentionsPathIn = (s, forms) => { const l = s.toLowerCase(); return forms.some((pf) => l.includes(pf)); };

function packetHit(kind, line, i, obj, packetId, pathForms, file) {
  if (!line.includes(packetId)) return null;
  const hit = { file, line: i, side: obj ? classifyLine(kind, obj) : (isToolResultsText(file) ? 'result' : 'text'), mentionsWait: mentionsWaitIn(line), mentionsPath: mentionsPathIn(line, pathForms) };
  // Codex event_msg/item_completed CommandExecution carries the call (command) and the result
  // (aggregated_output) on one line: judge each half on its own.
  const it = obj && obj.type === 'event_msg' && obj.payload && obj.payload.type === 'item_completed' && obj.payload.item;
  if (kind !== 'claude' && it && it.type === 'CommandExecution') {
    const callText = JSON.stringify(it.command ?? '');
    const outText = [it.aggregated_output, it.stdout, it.formatted_output].filter((x) => typeof x === 'string').join('\n');
    hit.call = callText.includes(packetId) && mentionsPathIn(callText, pathForms) && !mentionsWaitIn(callText);
    hit.result = outText.includes(packetId) && (mentionsWaitIn(outText) || mentionsPathIn(outText, pathForms));
  }
  return hit;
}

function deliveryStatus(hits) {
  const ok = hits.filter((h) => !h.error);
  const header = ok.some((h) => h.result === true || (h.side === 'result' && (h.mentionsWait || h.mentionsPath)));
  const readCall = ok.some((h) => h.call === true || (h.side === 'call' && h.mentionsPath && !h.mentionsWait));
  return readCall && header ? 'present_in_native' : header ? 'header_only' : ok.length ? 'mentioned' : 'unknown';
}

// Streams one registered file. For a Codex child rollout whose header carries
// subagent_history_start_ordinal, lines with a smaller ordinal are the parent's inherited history:
// they are reported to `fn` with inherited=true and must not count as this thread's activity.
// With a cursor ({offset, lines, skipBefore, threadId}) reading resumes at `offset`; the header is
// not read again, so the inherited-prefix boundary and thread id come from the cursor. Line numbers
// stay absolute (cursor.lines + n). Returns {lines, end, cursor} where `cursor` is where the next
// read should resume (after the last complete line).
async function scanFile(kind, file, fn, cursor = null) {
  const isJsonl = file.endsWith('.jsonl');
  const base = cursor ? cursor.lines : 0;
  let skipBefore = cursor && Number.isInteger(cursor.skipBefore) ? cursor.skipBefore : null;
  let threadId = cursor && typeof cursor.threadId === 'string' ? cursor.threadId : null;
  const r = await eachLine(file, (line, n) => {
    const i = base + n;
    let obj = null;
    if (isJsonl) { try { obj = JSON.parse(line); } catch { obj = null; } }
    if (i === 1 && kind !== 'claude' && obj && obj.type === 'session_meta' && obj.payload) {
      threadId = obj.payload.id || null;
      if (Number.isInteger(obj.payload.subagent_history_start_ordinal)) skipBefore = obj.payload.subagent_history_start_ordinal;
    }
    const inherited = skipBefore !== null && obj !== null && Number.isInteger(obj.ordinal) && obj.ordinal < skipBefore;
    fn(line, i, obj, { inherited, skipBefore, threadId });
    return true;
  }, { start: cursor ? cursor.offset : 0 });
  return { lines: r.lines, end: r.end, cursor: { offset: r.end, lines: base + r.complete, skipBefore, threadId } };
}

export async function auditPacket({ kind, files, packetId, packetPath }) {
  const hits = [];
  const pathForms = packetPathForms(packetPath);
  for (const f of files) {
    try {
      await scanFile(kind, f, (line, i, obj, ctx) => {
        if (ctx.inherited) return;
        const h = packetHit(kind, line, i, obj, packetId, pathForms, f);
        if (h) hits.push(h);
      });
    } catch (e) { hits.push({ file: f, error: e.code || String(e) }); }
  }
  return { status: deliveryStatus(hits), hits: hits.filter((h) => !h.error), errors: hits.filter((h) => h.error) };
}

function toMs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

// Does a parsed line have the shape this kind of log is known to have? Codex rollout lines are
// {timestamp, ordinal?, type, payload}; Claude transcript lines carry uuid / sessionId / message.
function recognised(kind, obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return false;
  if (kind === 'claude') return 'uuid' in obj || 'sessionId' in obj || 'message' in obj;
  return obj.payload !== undefined && !('uuid' in obj) && !('message' in obj);
}

// Identity of a native log line across copies (sessions/ and archived_sessions/ hold the same rollout).
function lineIdentity(obj, ctx, file, i) {
  if (obj && typeof obj.uuid === 'string') return `u:${obj.uuid}`;
  if (obj && Number.isInteger(obj.ordinal) && obj.timestamp) return `o:${ctx.threadId || ''}:${obj.timestamp}#${obj.ordinal}`;
  return `f:${file}:${i}`;
}

// User-facing wording. Never "只读" / "无写操作": only what was and was not observed.
export function describeObservation(r) {
  const n = r.files.length;
  if (r.annotation === 'audit_failed') return `登记的 ${n} 份原生日志没有一份是可识别的形状，审计失败（audit_failed），无法得出观测结论。`;
  if (r.writes.length) {
    const paths = [...new Set(r.writes.flatMap((w) => (w.path ? [w.path] : [])))].slice(0, 5).join('、');
    return `在回合窗口内观测到 ${r.writes.length} 处写操作${paths ? `（${paths}）` : ''}，${r.unknownCommands.length} 条命令不在白名单内；verdict 应标 tainted。`;
  }
  return `在登记的 ${n} 份原生日志、回合窗口内未观测到写操作；${r.unknownCommands.length} 条命令不在白名单内（记 unknown，不记 clean），${r.reads.length} 条读取。未观测到不等于没有发生：被拒的写操作不会留下记录。`;
}

// auditAttempt -> audit_observed payload (INTERFACES §4).
//   seat: Seat (uses seat.seatId, seat.audit.kind); kind may be given directly instead.
//   files: the registered files (from locateFiles); turnWindow: {fromTs, toTs} ISO or ms, optional.
// Codex child rollouts carry an inherited prefix (ordinals before subagent_history_start_ordinal):
// those lines belong to the parent's history and are skipped, for observation and for packet hits.
// Lines with a timestamp outside the window are skipped for observation; packet delivery hits are
// keyed by packetId and need no window. The same line seen in two copies (sessions/ and
// archived_sessions/) and the same tool call seen twice (call + patch_apply_end) count once.
// Incremental reads (plan §8.3 读法): `cursors` is the `cursors` map an earlier auditAttempt
// returned ({file: {offset, lines, size, skipBefore, threadId, shapeOk}}; the caller persists it,
// e.g. on seat.audit.cursors). A file with a cursor is read only from its offset; a file that has
// not grown since is not opened at all; a file that shrank is read again from byte 0. The result
// carries the new `cursors`, each ending after the last complete line, so a half-appended line is
// read again, whole, next time.
export async function auditAttempt({ seat, kind, attemptId, files = [], packetId, packetPath, turnWindow, allowlist, wrappers, cursors: prevCursors }) {
  const k = kind || (seat && seat.audit && seat.audit.kind) || 'codex';
  const opts = { allowlist, wrappers };
  const fromMs = turnWindow ? toMs(turnWindow.fromTs) : null;
  const toMsV = turnWindow ? toMs(turnWindow.toTs) : null;
  const pathForms = packetPathForms(packetPath);
  const hits = [];
  const writes = [];
  const unknownCommands = [];
  const reads = [];
  const others = {};
  const fileReports = [];
  const errors = [];
  const seenWrite = new Set();
  const seenUnknown = new Set();
  const seenRead = new Set();
  let recognisedLines = 0;
  let jsonlFiles = 0;
  let shapeSeenBefore = false;
  const cursors = {};
  const prevMap = prevCursors && typeof prevCursors === 'object' ? prevCursors : {};

  for (const file of files) {
    if (file.endsWith('.jsonl')) jsonlFiles++;
    const rep = { file, lines: 0, skippedInherited: 0, skippedOutsideWindow: 0, parsed: 0 };
    try {
      const rp = resumePoint(file, prevMap[file]);
      if (rp.reset) rep.cursorReset = true;
      if (rp.cursor) {
        rep.resumedAt = rp.cursor.offset;
        if (Number.isInteger(rp.cursor.skipBefore)) rep.inheritedPrefix = rp.cursor.skipBefore;
        if (rp.cursor.shapeOk) shapeSeenBefore = true;
      }
      if (rp.unchanged) {
        rep.unchanged = true;
        cursors[file] = { ...rp.cursor, size: rp.size };
        fileReports.push(rep);
        continue;
      }
      let fileShape = false;
      const sr = await scanFile(k, file, (line, i, obj, ctx) => {
        if (ctx.skipBefore !== null) rep.inheritedPrefix = ctx.skipBefore;
        if (obj) { rep.parsed++; if (recognised(k, obj)) { recognisedLines++; fileShape = true; } }
        if (ctx.inherited) { rep.skippedInherited++; return; }
        if (packetId) { const h = packetHit(k, line, i, obj, packetId, pathForms, file); if (h) hits.push(h); }
        if (!obj) return;
        const ts = toMs(obj.timestamp);
        if (ts !== null && ((fromMs !== null && ts < fromMs) || (toMsV !== null && ts > toMsV))) { rep.skippedOutsideWindow++; return; }
        const id = lineIdentity(obj, ctx, file, i);
        const c = classifyWrites(k, obj, opts);
        for (const it of c.items) {
          if (it.kind === 'write') {
            const paths = it.paths && it.paths.length ? it.paths : [null];
            for (const p of paths) {
              const key = it.callId ? `c:${it.callId}|${p || ''}` : `${id}|${it.source}|${p || ''}`;
              if (seenWrite.has(key) || seenWrite.has(`${id}|${it.source}|${p || ''}`)) continue;
              seenWrite.add(key);
              seenWrite.add(`${id}|${it.source}|${p || ''}`);
              writes.push({ file, line: i, path: p || undefined, source: it.source, status: it.status, ts: obj.timestamp, hints: it.hints, command: it.command, reason: it.reason });
            }
          } else if (it.kind === 'unknown-exec') {
            const key = it.command || `${file}:${i}`;
            if (seenUnknown.has(key)) continue;
            seenUnknown.add(key);
            unknownCommands.push({ file, line: i, command: it.command, source: it.source, reason: it.reason, ts: obj.timestamp });
          } else if (it.kind === 'read') {
            const key = it.command || (it.paths || []).join(',') || `${file}:${i}`;
            if (seenRead.has(key)) continue;
            seenRead.add(key);
            reads.push({ file, line: i, command: it.command, path: it.paths && it.paths[0], source: it.source, ts: obj.timestamp });
          } else {
            others[it.source] = (others[it.source] || 0) + 1;
          }
        }
      }, rp.cursor);
      rep.lines = sr.lines;
      cursors[file] = { ...sr.cursor, size: Math.max(rp.size, sr.cursor.offset), shapeOk: fileShape || !!(rp.cursor && rp.cursor.shapeOk) };
    } catch (e) { errors.push({ file, error: e.code || String(e) }); rep.error = e.code || String(e); }
    fileReports.push(rep);
  }

  const delivery = deliveryStatus(hits);
  const status = delivery === 'present_in_native' || delivery === 'header_only' ? delivery : 'unknown';
  // A file read only from a cursor may carry no new lines; its shape was checked when it was first read.
  const shapeOk = jsonlFiles === 0 || recognisedLines > 0 || shapeSeenBefore;
  const tainted = shapeOk && writes.length > 0;
  const annotation = !shapeOk ? 'audit_failed' : tainted ? 'tainted' : 'none';
  const result = {
    type: 'audit_observed',
    seatId: seat ? seat.seatId : undefined,
    attemptId,
    packetId,
    status,
    delivery,
    writes,
    unknownCommands,
    reads,
    tainted,
    annotation,
    others,
    files: fileReports,
    errors,
    window: turnWindow ? { fromTs: turnWindow.fromTs, toTs: turnWindow.toTs } : null,
    packetHits: hits.length,
    cursors,
  };
  result.note = describeObservation(result);
  return result;
}

// Turn window of an attempt from the room's own events: packet_issued -> first terminal event.
export function turnWindowFor(events, attemptId, now = () => new Date().toISOString()) {
  const issued = events.find((e) => e.type === 'packet_issued' && e.attemptId === attemptId);
  if (!issued) return null;
  const terminal = events.find((e) => e.seq > issued.seq && e.attemptId === attemptId
    && ['submission_accepted', 'attempt_canceled', 'attempt_expired', 'seat_skipped', 'work_partial'].includes(e.type));
  return { fromTs: issued.ts, toTs: terminal ? terminal.ts : now() };
}

export async function cmdAudit(args) {
  const seatDir = args.seat;
  if (!seatDir) { out('ERROR --seat <seatDir>'); process.exit(9); }
  const seat = readJson(path.join(seatDir, 'seat.json'));
  if (!seat.audit) { out(`UNAUDITED seat ${seat.seatId} has no audit source registered`); process.exit(0); }
  const since = Date.parse(seat.createdAt) - 60000;
  const events = readJsonl(path.join(seat.roomDir, F.events));
  const packets = events.filter((e) => e.type === 'packet_issued' && e.seatId === seat.seatId && (!args.packet || e.packetId === args.packet) && (!args.attempt || e.attemptId === args.attempt));
  const firstPacket = events.find((e) => e.type === 'packet_issued' && e.seatId === seat.seatId);
  const { files, opened, note, sessionId, children } = await locateFiles(seat.audit, since, firstPacket && firstPacket.packetId);
  out(`AUDIT seat=${seat.seatId} kind=${seat.audit.kind} ${note}`);
  out(`registered_files=${files.length} opened_files=${opened.length}${sessionId ? ` session=${sessionId}` : ''}`);
  for (const f of files) out(`  ${fwd(f)} (${fs.statSync(f).size} bytes)${children && children.some((c) => c.file === f) ? ' child-thread' : ''}`);
  for (const p of packets) {
    const r = await auditPacket({ kind: seat.audit.kind, files, packetId: p.packetId, packetPath: p.path });
    out(`PACKET ${p.packetId} -> ${r.status} (${r.hits.length} mentions)`);
    if (args.verbose) {
      for (const h of r.hits) out(`    ${fwd(h.file)}:${h.line} side=${h.side} wait=${h.mentionsWait} path=${h.mentionsPath}`);
      for (const e of r.errors) out(`    error ${fwd(e.file)} ${e.error}`);
    }
    const win = turnWindowFor(events, p.attemptId);
    const o = await auditAttempt({ seat, attemptId: p.attemptId, files, packetId: p.packetId, packetPath: p.path, turnWindow: win });
    out(`OBSERVED attempt=${p.attemptId} status=${o.status} writes=${o.writes.length} unknown=${o.unknownCommands.length} reads=${o.reads.length} tainted=${o.tainted} annotation=${o.annotation}`);
    out(`  ${o.note}`);
    if (args.verbose) {
      for (const w of o.writes) out(`    write ${fwd(w.file)}:${w.line} ${w.source} ${w.path || w.command || ''}${w.status ? ` status=${w.status}` : ''}`);
      for (const u of o.unknownCommands) out(`    unknown ${fwd(u.file)}:${u.line} ${u.source} ${u.command || ''} (${u.reason})`);
      for (const rd of o.reads) out(`    read ${fwd(rd.file)}:${rd.line} ${rd.source} ${rd.command || rd.path || ''}`);
      for (const fr of o.files) out(`    file ${fwd(fr.file)} lines=${fr.lines} parsed=${fr.parsed} inherited_skipped=${fr.skippedInherited} outside_window=${fr.skippedOutsideWindow}${fr.error ? ` error=${fr.error}` : ''}`);
    }
  }
  if (!packets.length) out('no packets issued to this seat yet');
}
