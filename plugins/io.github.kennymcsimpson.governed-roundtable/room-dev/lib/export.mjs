// lib/export.mjs — export the public layer of a room as a zip (plan §8.6, §13.1 #12).
// CLI: node dist/export.mjs (a thin wrapper) or room admin export; embedded hosts import this module.
//
//   node dist/export.mjs <roomDir> <out.zip> [--redact]
//
// What goes in (public layer only):
//   room.json       with token-like fields and machine-local fields (cwd, outbox, roomDir) removed
//   events.jsonl    each event minus private fields: path, file, privatePath (top level) and
//                   token, proof, apiKey, cwd, outbox, roomDir (at any depth); torn lines dropped
//   packets/        packet bodies
//   manifests/      packet manifests
//   artifacts/      frozen artifact manifests
//   EXPORT.json     export record (room id, time, redaction report)
// What never goes in: private/, seats/ (tokens, JOIN.md, seat.json), admin.token, admin-queue/,
//   replies/, write-log.jsonl, state.json, service.lock, snapshots/.
//
// Before writing, every text entry is scanned for secrets (sk-... keys, ANTHROPIC_/OPENAI_ key
// assignments, "Bearer <token>", AWS access keys, GitHub tokens, PEM private-key blocks) and for
// absolute paths (drive letters such as C:\Users\..., UNC \\server\share\..., MSYS/WSL/Cygwin drive
// mounts /c/..., /mnt/c/..., /cygdrive/c/..., and /home/, /Users/, /root/; segments may contain
// spaces, e.g. C:\Users\John Smith\...). Any hit makes the
// export FAIL (exit 2, report on stdout) unless --redact is given, in which case each hit is replaced
// with <REDACTED:kind> and the export proceeds. The produced zip is read back and re-scanned; a hit
// surviving redaction is a bug and aborts.
//
// Exit codes: 0 exported; 2 blocked by scan hits; 9 error. Status words are ASCII, prose is Chinese.
// Build tooling run by the user, not the room service: it reads the room directory and writes only
// the output zip, directly (not through lib/guard.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ZipWriter, readZip } from './zip.mjs';

export const PUBLIC_DIRS = ['packets', 'manifests', 'artifacts'];
export const EXCLUDED = ['private', 'seats', 'admin.token', 'admin-queue', 'replies', 'write-log.jsonl', 'state.json', 'service.lock', 'snapshots'];
const PRIVATE_EVENT_TOP_KEYS = ['path', 'file', 'privatePath'];
const PRIVATE_DEEP_KEYS = ['token', 'proof', 'apiKey', 'adminToken', 'cwd', 'outbox', 'roomDir'];

// Path shapes. A path segment may contain single inner spaces ("C:\Users\John Smith\..."): a spaced
// segment is taken whole when a separator follows it, and as the final segment only when it runs up to
// a quote, a newline or the end of the text (a JSON string value, a line of its own). A final segment
// followed by prose stops at the first space; the user-name segment is never final in that case unless
// the path is the profile itself. A single backslash directly before a quote is not taken as a
// separator, so redacting inside a JSON string never eats the escape of a \" and the line stays JSON.
// Parentheses are segment characters ("Program Files (x86)"); a closing ")" of a Markdown link is then
// redacted along with the path, which over-redacts by one character and never leaks.
const SEGCH = String.raw`[^\s"'<>|*?\\/\[\]]`;
const SEP = String.raw`(?:\\\\|\\(?!")|\/)`;
const SPACED = `${SEGCH}+(?: ${SEGCH}+)*`;
const END = String.raw`(?=["'<>|\r\n]|$)`;
const WIN_TAIL = `(?:${SPACED}${SEP})*(?:${SPACED}${END}|${SEGCH}*)`;
const PSEG = String.raw`[^\s"'<>|/]`;
const PSPACED = `${PSEG}+(?: ${PSEG}+)*`;
const POSIX_TAIL = `(?:${PSPACED}\\/)*(?:${PSPACED}${END}|${PSEG}*)`;

// Order matters: PEM blocks first (multi-line), then key shapes, then paths (UNC before drive paths,
// MSYS/Cygwin/WSL drive mounts before the plain POSIX home shapes).
export const SCAN_PATTERNS = [
  { kind: 'pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  { kind: 'key-assignment', re: /\b(?:ANTHROPIC|OPENAI|AWS|GITHUB|GH)_[A-Z_]*(?:KEY|TOKEN|SECRET)\b\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{8,}/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  // \\server\share\... and its JSON-escaped form \\\\server\\share\\... (events.jsonl is JSON text).
  // The host must be at least two name characters and followed by a separator, so "\\n" or "\\d+" in
  // escaped text is not a UNC path.
  { kind: 'unc-path', re: new RegExp(String.raw`(?<![\w\\:])(?:\\\\\\\\|\\\\)[A-Za-z0-9][A-Za-z0-9.$_-]+(?:\\\\|\\(?!"))` + WIN_TAIL, 'g') },
  { kind: 'win-path', re: new RegExp(String.raw`\b[A-Za-z]:` + SEP + WIN_TAIL, 'g') },
  // /c/Users/..., /mnt/c/..., /cygdrive/c/... (Git Bash, WSL, Cygwin views of a Windows drive).
  { kind: 'msys-path', re: new RegExp(String.raw`(?<![\w/:.])\/(?:mnt\/|cygdrive\/)?[A-Za-z]\/` + POSIX_TAIL, 'g') },
  { kind: 'posix-home', re: new RegExp(String.raw`(?<![\w/:])\/(?:home|Users|root)\/` + POSIX_TAIL, 'g') },
];

export function scanText(text) {
  const hits = [];
  for (const { kind, re } of SCAN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({ kind, index: m.index, length: m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

export function redactText(text) {
  const report = {};
  let outText = text;
  for (const { kind, re } of SCAN_PATTERNS) {
    re.lastIndex = 0;
    outText = outText.replace(re, () => { report[kind] = (report[kind] || 0) + 1; return `<REDACTED:${kind}>`; });
  }
  return { text: outText, report };
}

export function sanitizeRoom(room) {
  const clean = stripDeep(room);
  if (Array.isArray(clean.seats)) {
    clean.seats = clean.seats.map((s) => {
      const seat = { ...s };
      for (const k of ['token', 'joinSha256']) delete seat[k];
      if (seat.audit && typeof seat.audit === 'object') seat.audit = { kind: seat.audit.kind };
      return seat;
    });
  }
  return clean;
}

export function stripDeep(value, keys = PRIVATE_DEEP_KEYS) {
  if (Array.isArray(value)) return value.map((v) => stripDeep(v, keys));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) continue;
      o[k] = stripDeep(v, keys);
    }
    return o;
  }
  return value;
}

export function sanitizeEvent(ev) {
  const top = { ...ev };
  for (const k of PRIVATE_EVENT_TOP_KEYS) delete top[k];
  return stripDeep(top);
}

function walkFiles(dir, rel) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, ent.name);
    const r = `${rel}/${ent.name}`;
    if (ent.isDirectory()) result.push(...walkFiles(abs, r));
    else if (ent.isFile()) result.push({ rel: r, abs });
  }
  return result;
}

// Collect the public-layer entries of a room as {name, text}. Pure with respect to the output: it
// only reads. Throws if the room directory is not a room.
export function collectPublicEntries(roomDir) {
  const roomPath = path.join(roomDir, 'room.json');
  if (!fs.existsSync(roomPath)) throw new Error(`不是房间目录（没有 room.json）：${roomDir}`);
  const room = JSON.parse(fs.readFileSync(roomPath, 'utf8'));
  const entries = [];
  entries.push({ name: 'room.json', text: JSON.stringify(sanitizeRoom(room), null, 1) });
  const eventsPath = path.join(roomDir, 'events.jsonl');
  if (fs.existsSync(eventsPath)) {
    const lines = [];
    for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      lines.push(JSON.stringify(sanitizeEvent(ev)));
    }
    entries.push({ name: 'events.jsonl', text: lines.length ? `${lines.join('\n')}\n` : '' });
  }
  for (const d of PUBLIC_DIRS) {
    for (const f of walkFiles(path.join(roomDir, d), d)) entries.push({ name: f.rel, text: fs.readFileSync(f.abs, 'utf8') });
  }
  return { room, entries };
}

export async function exportRoom({ roomDir, out, redact = false, log = () => {} }) {
  const absRoom = path.resolve(roomDir);
  const absOut = path.resolve(out);
  const { room, entries } = collectPublicEntries(absRoom);
  const hits = [];
  const redactions = [];
  const finalEntries = [];
  for (const e of entries) {
    const found = scanText(e.text);
    if (found.length === 0) { finalEntries.push(e); continue; }
    const byKind = {};
    for (const h of found) byKind[h.kind] = (byKind[h.kind] || 0) + 1;
    for (const [kind, count] of Object.entries(byKind)) hits.push({ entry: e.name, kind, count });
    if (!redact) continue;
    const r = redactText(e.text);
    for (const [kind, count] of Object.entries(r.report)) redactions.push({ entry: e.name, kind, count });
    finalEntries.push({ name: e.name, text: r.text });
  }
  if (hits.length && !redact) {
    for (const h of hits) log(`HIT entry=${h.entry} kind=${h.kind} count=${h.count}`);
    log(`EXPORT_BLOCKED hits=${hits.reduce((n, h) => n + h.count, 0)} entries=${new Set(hits.map((h) => h.entry)).size}`);
    log('导出被扫描拦住：上面列出的条目含密钥形状或绝对路径。确认后用 --redact 重新导出，命中处会换成 <REDACTED:kind>。');
    return { ok: false, hits, redactions: [], zipPath: null };
  }
  const record = {
    schema_version: 1,
    kind: 'room-dev-export',
    roomId: room.id,
    exportedAt: new Date().toISOString(),
    redact,
    redactions,
    included: finalEntries.map((e) => e.name),
    excluded: EXCLUDED,
  };
  const zip = new ZipWriter({ level: 6 });
  for (const e of finalEntries) zip.add(e.name, e.text);
  zip.add('EXPORT.json', JSON.stringify(record, null, 1));
  const bytes = zip.finish();
  // read back and re-scan: nothing that the scanner knows may survive in the archive
  const survivors = [];
  for (const e of readZip(bytes)) {
    if (!e.crc32Ok) throw new Error(`自检失败：${e.name} CRC 不符`);
    for (const h of scanText(e.data.toString('utf8'))) survivors.push({ entry: e.name, kind: h.kind });
  }
  if (survivors.length) throw new Error(`自检失败：脱敏后仍有命中 ${JSON.stringify(survivors.slice(0, 5))}`);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });
  fs.writeFileSync(absOut, bytes);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  for (const r of redactions) log(`REDACTED entry=${r.entry} kind=${r.kind} count=${r.count}`);
  log(`EXPORTED zip=${absOut.replace(/\\/g, '/')} entries=${finalEntries.length + 1} bytes=${bytes.length} sha256=${sha} redacted=${redactions.reduce((n, r) => n + r.count, 0)}`);
  return { ok: true, hits, redactions, zipPath: absOut, sha256: sha, entries: finalEntries.length + 1, bytes: bytes.length };
}

export function parseExportArgs(argv) {
  const opts = { redact: false, positional: [] };
  for (const a of argv) {
    if (a === '--redact') opts.redact = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
    else opts.positional.push(a);
  }
  return opts;
}
