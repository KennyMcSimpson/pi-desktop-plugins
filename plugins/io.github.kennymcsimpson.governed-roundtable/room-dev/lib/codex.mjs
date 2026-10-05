// Locating codex.exe on Windows: it is not on PATH when installed through the Desktop app (plan §11).
// Order: CODEX_CLI_PATH env var, then CODEX_CLI_PATH in $CODEX_HOME/config.toml (the Desktop app
// writes it into an MCP server's env table), then the Desktop app's bin directory (newest hash dir),
// then PATH. Every step accepts only a real executable: on Windows .exe/.com. The npm shim codex.cmd
// is never returned, because spawnClean runs without a shell and a batch file fails there with
// EINVAL; with only the shim installed this returns null and the caller reports 'codex.exe not found'.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findOnPath } from './spawn.mjs';

const WIN = process.platform === 'win32';

function envGet(env, key) {
  if (env[key] !== undefined) return env[key];
  if (!WIN) return undefined;
  const upper = key.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === upper && env[k] !== undefined) return env[k];
  return undefined;
}

// An existing regular file; on Windows also an .exe/.com extension.
export function acceptableExe(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (WIN && !['.exe', '.com'].includes(path.extname(p).toLowerCase())) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Minimal, read-only TOML probe: the first `CODEX_CLI_PATH = "..."` (basic string, backslash
// escapes) or `CODEX_CLI_PATH = '...'` (literal string) line, in any table. No TOML dependency.
export function codexPathFromConfig(configPath) {
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return null; }
  for (const line of text.split(/\r?\n/)) {
    const basic = /^\s*CODEX_CLI_PATH\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line);
    if (basic) {
      return basic[1].replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, c) => {
        if (c[0] === 'u' || c[0] === 'U') return String.fromCodePoint(parseInt(c.slice(1), 16));
        return { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[c] ?? c;
      });
    }
    const literal = /^\s*CODEX_CLI_PATH\s*=\s*'([^']*)'\s*(?:#.*)?$/.exec(line);
    if (literal) return literal[1];
  }
  return null;
}

// findCodex({ env }) -> absolute path or null. env defaults to process.env (tests inject a fake).
export function findCodex({ env = process.env } = {}) {
  const fromEnv = envGet(env, 'CODEX_CLI_PATH');
  if (acceptableExe(fromEnv)) return fromEnv;
  const fromConfig = codexPathFromConfig(path.join(codexHome(env), 'config.toml'));
  if (acceptableExe(fromConfig)) return fromConfig;
  const local = envGet(env, 'LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.join(local, 'OpenAI', 'Codex', 'bin');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { /* not installed through the Desktop app */ }
  const candidates = [];
  for (const d of dirs) {
    const exe = path.join(base, d, WIN ? 'codex.exe' : 'codex');
    if (acceptableExe(exe)) candidates.push({ exe, mtime: fs.statSync(exe).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (candidates.length) return candidates[0].exe;
  // findOnPath only tries .exe/.com on Windows: batch shims are deliberately not candidates.
  return findOnPath('codex', { env: { PATH: envGet(env, 'PATH') || '' } });
}

export function codexHome(env = process.env) {
  return envGet(env, 'CODEX_HOME') || path.join(os.homedir(), '.codex');
}
