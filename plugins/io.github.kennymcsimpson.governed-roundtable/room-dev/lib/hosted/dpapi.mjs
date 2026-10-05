// DPAPI storage of the built-in Pi API key (plan §8.5 "P3 用 DPAPI 落盘"; INTERFACES §1, §9).
//
// protect(plaintextUtf8) -> Buffer and unprotect(Buffer) -> string wrap Windows DPAPI
// (System.Security.Cryptography.ProtectedData, scope CurrentUser, a fixed per-app entropy) without
// any npm dependency: each call runs one Windows PowerShell 5.1 child through lib/spawn.mjs
// spawnClean (no shell, whitelist environment, timeout). Only base64 crosses the pipes, so the
// console code page (CP936 on the author machine) cannot corrupt anything.
//
// Where the secret travels (measured 2026-10-03, Windows 11 Pro 10.0.26200, PowerShell 5.1):
//   - argv: never. The PowerShell command is a fixed script with no data in it (PS_ARGS).
//   - env: never. spawnClean gets env {} and builds the whitelist only.
//   - temp file: never.
//   - stdin: yes, as one line of base64, read by the script with [Console]::In.ReadToEnd() as DATA.
// Why the script is in argv and not on stdin (`-Command -`): with `-Command -` PowerShell reads all
// of stdin up front as script text (a raw read of stdin from inside the script returned 0 bytes), so
// the secret would have to be part of the script. Script text is what PowerShell's script block
// logging records: without any policy set, PowerShell 5.1 auto-logged the probe script that called
// Add-Type, base64 secret included, as event 4104 in Microsoft-Windows-PowerShell/Operational. With
// the secret on stdin as data, no 4104 event carried it (same machine, same probe). A machine whose
// policy turns on transcription or full script block logging still never sees the secret in script
// text; the plaintext only ever crosses stdout (unprotect) as base64, written with [Console]::Out,
// not through the PowerShell host.
//
// Errors carry an ASCII code (DPAPI_UNAVAILABLE, DPAPI_FAILED) and never the secret: nothing from
// the child's stdin, stdout or stderr is quoted in an error except a strictly matched ASCII tag (an
// exception type name and HRESULT). stderr is never read into an error at all, because PowerShell
// echoes the offending script line there on a parse error.
//
// The stored file (savePiKey / forgetPiKey / piKeyStatus / loadSavedPiKey) is
// path.join(appRoot(), 'secrets', 'pi-key.dpapi'), NOT under AppData (INTERFACES §1: MSIX packaged
// processes have their AppData writes redirected). It is written through a guard rooted at
// appRoot()/secrets with its own write-log there, and checked with virtualizationRedirect().
import fs from 'node:fs';
import path from 'node:path';
import { appRoot, sha256, fwd, virtualizationRedirect } from '../common.mjs';
import { createGuard } from '../guard.mjs';
import { spawnClean } from '../spawn.mjs';

// Fixed per-app entropy: a blob made by another program for the same Windows user does not
// unprotect here without it, and ours does not unprotect there.
// (A string: a Buffer cannot be frozen, and a shared mutable Buffer could be altered by a caller.)
export const DPAPI_ENTROPY = 'room-dev/hosted-pi-key/dpapi-entropy/v1';
export const DPAPI_TIMEOUT_MS = 60_000;
export const PI_KEY_FILE = 'pi-key.dpapi';
export const SECRETS_DIR = 'secrets';

const OK_RE = /(?:^|\n)DPAPI_OK:([A-Za-z0-9+/]*={0,2})\r?\n/;
const ERR_RE = /(?:^|\n)DPAPI_ERR:([A-Za-z0-9_.:+-]{1,200})\r?\n/;
const TAG_LANGUAGE_MODE = 'LANGUAGE_MODE';

function dpapiError(code, message, extra) {
  const e = new Error(`${code}：${message}`);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// isAvailable({platform, exists}) -> boolean. False on every platform but Windows, and on a Windows
// without Windows PowerShell 5.1 at its fixed location.
export function isAvailable({ platform = process.platform, exists = fs.existsSync, env = process.env } = {}) {
  if (platform !== 'win32') return false;
  try { return !!exists(powershellPath(env)); } catch { return false; }
}

// The whole PowerShell program for one operation. It contains no data: the input arrives on stdin,
// the result leaves on stdout, both base64. A restricted language mode (AppLocker / WDAC) cannot
// load System.Security, so it is reported as its own tag instead of a generic failure.
export function dpapiScript(op) {
  if (op !== 'Protect' && op !== 'Unprotect') throw new TypeError('dpapiScript: op must be Protect or Unprotect');
  const ent = Buffer.from(DPAPI_ENTROPY, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop';",
    'try {',
    `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { [Console]::Out.Write('DPAPI_ERR:${TAG_LANGUAGE_MODE}' + [char]10); exit 5 };`,
    'Add-Type -AssemblyName System.Security;',
    '$l = [Console]::In.ReadToEnd(); if ($null -eq $l) { $l = \'\' };',
    '$d = [Convert]::FromBase64String($l.Trim());',
    "if ($d.Length -eq 0) { [Console]::Out.Write('DPAPI_ERR:NO_INPUT' + [char]10); exit 4 };",
    `$e = [Convert]::FromBase64String('${ent}');`,
    '$s = [System.Security.Cryptography.DataProtectionScope]::CurrentUser;',
    `$r = [System.Security.Cryptography.ProtectedData]::${op}($d, $e, $s);`,
    "[Console]::Out.Write('DPAPI_OK:' + [Convert]::ToBase64String($r) + [char]10); exit 0",
    '} catch {',
    '$x = $_.Exception; while ($null -ne $x.InnerException) { $x = $x.InnerException };',
    "[Console]::Out.Write('DPAPI_ERR:' + $x.GetType().FullName + ':' + ('{0:X8}' -f $x.HResult) + [char]10); exit 3",
    '}',
  ].join(' ');
}

export function psArgs(op) { return ['-NoProfile', '-NonInteractive', '-Command', dpapiScript(op)]; }

function strictBase64(s) {
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? buf : null;
}

// Runs one DPAPI operation on `data` (Buffer). Resolves to the output bytes or throws a coded error.
async function runDpapi(op, data, { spawn = spawnClean, platform = process.platform, timeoutMs = DPAPI_TIMEOUT_MS, env = process.env } = {}) {
  const verb = op === 'Protect' ? '加密' : '解密';
  if (platform !== 'win32') throw dpapiError('DPAPI_UNAVAILABLE', `DPAPI 只在 Windows 上可用（当前平台 ${platform}），无法${verb}保存的 key。`);
  const input = `${data.toString('base64')}\n`;
  let r;
  try {
    r = await spawn(powershellPath(env), psArgs(op), { env: {}, input, timeoutMs, maxOutputBytes: 64 * 1024 });
  } catch (e) {
    throw dpapiError('DPAPI_UNAVAILABLE', `无法启动 Windows PowerShell（${e && e.code ? e.code : 'error'}）。`);
  }
  if (!r || r.spawnError) {
    const code = r && r.spawnError ? ((/^([A-Z][A-Z0-9_]+):/.exec(String(r.spawnError)) || [])[1] || 'SPAWN_ERROR') : 'SPAWN_ERROR';
    throw dpapiError('DPAPI_UNAVAILABLE', `无法启动 Windows PowerShell（${code}）：${fwd(powershellPath(env))}`);
  }
  if (r.timedOut) throw dpapiError('DPAPI_FAILED', `DPAPI ${verb}超时（${timeoutMs} ms 内 PowerShell 没有结束）。`, { exitCode: r.code, detail: 'timeout' });
  const stdout = String(r.stdout || '');
  const ok = r.code === 0 ? OK_RE.exec(stdout) : null;
  if (ok) {
    const out = strictBase64(ok[1]);
    if (out && out.length > 0) return out;
    throw dpapiError('DPAPI_FAILED', `DPAPI ${verb}的输出不是有效的 base64。`, { exitCode: r.code, detail: 'bad_output' });
  }
  const tag = (ERR_RE.exec(stdout) || [])[1] || null;
  if (tag === TAG_LANGUAGE_MODE) {
    throw dpapiError('DPAPI_UNAVAILABLE', 'Windows PowerShell 处于受限语言模式（AppLocker / WDAC 策略），无法加载 System.Security 做 DPAPI。', { exitCode: r.code, detail: tag });
  }
  throw dpapiError('DPAPI_FAILED', `DPAPI ${verb}失败（PowerShell 退出码 ${r.code === null ? '?' : r.code}${tag ? `，${tag}` : ''}）。`, { exitCode: r.code, detail: tag || 'no_result' });
}

// protect(plaintextUtf8, opts) -> Promise<Buffer>: the DPAPI blob (CurrentUser, DPAPI_ENTROPY).
// opts: { spawn, platform, timeoutMs } for tests.
export async function protect(plaintextUtf8, opts = {}) {
  if (typeof plaintextUtf8 !== 'string' || plaintextUtf8.length === 0) throw new TypeError('protect: plaintext must be a non-empty string');
  return runDpapi('Protect', Buffer.from(plaintextUtf8, 'utf8'), opts);
}

// unprotect(blob, opts) -> Promise<string>. A blob from another user, another machine, without the
// entropy, or altered in any byte fails with DPAPI_FAILED.
export async function unprotect(blob, opts = {}) {
  if (!Buffer.isBuffer(blob) || blob.length === 0) throw new TypeError('unprotect: blob must be a non-empty Buffer');
  const out = await runDpapi('Unprotect', blob, opts);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(out); } catch {
    throw dpapiError('DPAPI_FAILED', '解密结果不是有效的 UTF-8 文本。', { detail: 'bad_utf8' });
  }
}

// ---------------------------------------------------------------------------------------------
// The saved key file
// ---------------------------------------------------------------------------------------------

export function secretsDir(root = appRoot()) { return path.join(root, SECRETS_DIR); }
export function savedPiKeyPath(root = appRoot()) { return path.join(secretsDir(root), PI_KEY_FILE); }

// What may be printed about a key: its length and the first 8 hex of its sha256. Never the key.
export function keyFingerprint(key) { return { length: key.length, sha256: sha256(Buffer.from(key, 'utf8')).slice(0, 8) }; }

export function validatePiKey(key) {
  if (typeof key !== 'string' || !key.trim()) return 'EMPTY';
  if (/[\r\n]/.test(key)) return 'MULTILINE';
  if (key.includes('\0')) return 'NUL';
  return null;
}

function secretsGuard(dir, who) {
  return createGuard({ allowed: [dir], logPath: path.join(dir, 'write-log.jsonl'), who });
}

function nearestExisting(p) {
  let cur = path.resolve(p);
  while (!fs.existsSync(cur)) { const parent = path.dirname(cur); if (parent === cur) break; cur = parent; }
  return cur;
}

function redirectMessage(r, what) {
  if (r.packaged) {
    return `${what} ${fwd(r.asked)} 的写入被重定向到 ${fwd(r.real)}。这是 MSIX 打包应用（例如 Claude 桌面应用）对 AppData 的写入虚拟化：`
      + '只有同一包上下文里的进程看得到原路径，从开始菜单打开的终端里运行的房间服务会找不到它。'
      + '请改用 %USERPROFILE% 下的根目录（默认 %USERPROFILE%\\room-dev），或用环境变量 ROOM_DEV_HOME 指定。';
  }
  return `${what} ${fwd(r.asked)} 的真实位置是 ${fwd(r.real)}（经过了链接或重定向），其他进程解析到的位置可能不同；请把 ROOM_DEV_HOME 指向真实路径。`;
}

function redirectError(r, what) {
  return dpapiError('PI_KEY_REDIRECTED', redirectMessage(r, what), { asked: r.asked, real: r.real, packaged: !!r.packaged });
}

// savePiKey(key, opts) -> { path, bytes, length, sha256 } (sha256 = 8-hex prefix).
// Order: refuse a redirected location before anything is written; protect; write atomically through
// the guard; check the written file itself; on a redirect, remove what was written and refuse.
export async function savePiKey(key, { file = savedPiKeyPath(), redirect = virtualizationRedirect, who = 'admin:pi-key', ...dpapiOpts } = {}) {
  const bad = validatePiKey(key);
  if (bad) throw dpapiError('PI_KEY_INVALID', bad === 'MULTILINE' ? 'API key 只能是一行。' : 'API key 为空或含非法字符。');
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const early = redirect(nearestExisting(dir));
  if (early) throw redirectError(early, '保存 key 的目录所在的目录');
  const blob = await protect(key, dpapiOpts);
  const guard = secretsGuard(dir, who);
  guard.mkdir(dir);
  guard.atomicWrite(abs, blob);
  const r = redirect(abs);
  if (r) {
    try { guard.rm(abs); } catch { /* reported below either way */ }
    throw redirectError(r, '保存的 key 文件');
  }
  return { path: abs, bytes: blob.length, ...keyFingerprint(key) };
}

// forgetPiKey(opts) -> { path, removed }.
export function forgetPiKey({ file = savedPiKeyPath(), who = 'admin:pi-key' } = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { path: abs, removed: false };
  secretsGuard(path.dirname(abs), who).rm(abs);
  return { path: abs, removed: !fs.existsSync(abs) };
}

// loadSavedPiKey(opts) -> { path, saved, key?, code?, message? }. Never throws for a missing or
// undecryptable file: the caller decides what a missing key means. `unprotect` is injectable.
export async function loadSavedPiKey({ file = savedPiKeyPath(), unprotect: unprotectFn = unprotect, ...dpapiOpts } = {}) {
  const abs = path.resolve(file);
  let blob;
  try { blob = fs.readFileSync(abs); } catch (e) {
    if (e && e.code === 'ENOENT') return { path: abs, saved: false };
    return { path: abs, saved: true, code: 'PI_KEY_UNREADABLE', message: `读取 ${fwd(abs)} 失败（${e && e.code ? e.code : 'error'}）` };
  }
  if (!blob.length) return { path: abs, saved: true, code: 'DPAPI_FAILED', message: '保存的 key 文件是空的' };
  let key;
  try { key = await unprotectFn(blob, dpapiOpts); } catch (e) {
    return { path: abs, saved: true, code: e && typeof e.code === 'string' ? e.code : 'DPAPI_FAILED', message: e && e.message ? e.message : '解密失败' };
  }
  const bad = validatePiKey(key);
  if (bad) return { path: abs, saved: true, code: 'PI_KEY_INVALID', message: '解密出的 key 为空或不是一行' };
  return { path: abs, saved: true, key };
}

// piKeyStatus(opts) -> { path, saved, decrypts: true|false|null, code?, message?, length?, sha256? }.
// decrypts is null when DPAPI is not available here (nothing can be said about the blob).
export async function piKeyStatus(opts = {}) {
  const r = await loadSavedPiKey(opts);
  if (!r.saved) return { path: r.path, saved: false, decrypts: null };
  if (r.key === undefined) return { path: r.path, saved: true, decrypts: r.code === 'DPAPI_UNAVAILABLE' ? null : false, code: r.code, message: r.message };
  return { path: r.path, saved: true, decrypts: true, ...keyFingerprint(r.key) };
}
