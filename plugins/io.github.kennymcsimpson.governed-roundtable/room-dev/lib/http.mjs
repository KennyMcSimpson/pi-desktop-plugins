// Optional loopback HTTP surface of the room service (INTERFACES §8, plan §8.1).
//   GET  /api/state            {state, room}  (the service view: reducer state plus derived fields)
//   GET  /api/events?since=N   {events: [seq > N], lastSeq}
//   POST /api/admin            JSON {token, cmd, ...params} -> service.admin({cmd, ...params})
//   POST /seat/<cmd>           JSON {seatId, token, attemptId?, text?, payload?} (seat token) -> seat transport
//   GET  /, /app.js, ...       static files from ui/ (top level only, fixed types)
// Binds 127.0.0.1 only. Every request passes the Host/Origin gate (DNS rebinding, cross-site; a
// same-site top-level navigation may open / or /index.html, so the lobby's link loads the room UI);
// POST bodies must be application/json, at most 64 KiB, and tokens are never accepted in a URL.
// A seat token presented to /api/admin is refused and logged (plan #21). Nothing here writes to
// disk; every state change goes through the service, which writes through its guard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { COMMAND_KINDS } from './structured.mjs';

export const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
export const MAX_BODY_BYTES = 64 * 1024;
export const SEAT_COMMANDS = Object.freeze(['status', 'wait', 'submit', ...COMMAND_KINDS.filter((k) => k !== 'speech')]);

const STATIC_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
});

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

// The pages a top-level navigation may open from another loopback port (the lobby on 7380 opens
// the room UI on its own random port, which the browser reports as Sec-Fetch-Site: same-site).
export const NAVIGABLE_PATHS = Object.freeze(['/', '/index.html']);

// True for a plain top-level document navigation (GET/HEAD, Sec-Fetch-Mode navigate, Sec-Fetch-Dest
// document or absent) from a same-site page to one of NAVIGABLE_PATHS. That page carries no secret
// (the admin token stays in the URL fragment, which is never sent to the server) and cannot be
// framed (frame-ancestors 'none', X-Frame-Options DENY). /api/*, /seat/* and every fetch, script or
// style request still need same-origin or none.
export function pageNavigation(headers, { method, path: p } = {}) {
  const h = headers || {};
  if (String(h['sec-fetch-site'] || '').toLowerCase() !== 'same-site') return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (String(h['sec-fetch-mode'] || '').toLowerCase() !== 'navigate') return false;
  const dest = h['sec-fetch-dest'] === undefined ? 'document' : String(h['sec-fetch-dest']).toLowerCase();
  if (dest !== 'document') return false;
  return typeof p === 'string' && NAVIGABLE_PATHS.includes(p);
}

// Pure. Same rule as ui/mock-server.mjs: Host must be exactly 127.0.0.1:<port> or localhost:<port>;
// Origin, when present, the same loopback origin; Sec-Fetch-Site, when present, same-origin or none,
// except a same-site top-level page navigation (pageNavigation; needs req = {method, path}).
export function checkHostOrigin(headers, port, req = {}) {
  const h = headers || {};
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = typeof h.host === 'string' ? h.host.trim().toLowerCase() : '';
  if (!hosts.includes(host)) return { ok: false, status: 403, error: 'BAD_HOST' };
  if (h.origin !== undefined) {
    const origin = String(h.origin).trim().toLowerCase();
    if (!hosts.some((x) => origin === `http://${x}`)) return { ok: false, status: 403, error: 'BAD_ORIGIN' };
  }
  if (h['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(h['sec-fetch-site']).toLowerCase())
    && !pageNavigation(h, req)) {
    return { ok: false, status: 403, error: 'BAD_FETCH_SITE' };
  }
  return { ok: true };
}

export function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// send / jsonBody are shared with lib/lobby.mjs, which applies the same headers and body rules.
export function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': buf.length });
  res.end(buf);
}

function staticFile(uiDir, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p === '/' || p === '') p = '/index.html';
  if (!/^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) || p.includes('..')) return null;
  const ext = path.extname(p).toLowerCase();
  if (!STATIC_TYPES[ext]) return null;
  const abs = path.join(uiDir, p.slice(1));
  if (path.resolve(path.dirname(abs)) !== path.resolve(uiDir)) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return { abs, type: STATIC_TYPES[ext] };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function jsonBody(req, res, url) {
  if (url.search) { send(res, 400, { ok: false, error: 'TOKEN_IN_URL', message: '令牌只能放在 POST 正文里，URL 不得带查询串' }); return null; }
  const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ctype !== 'application/json') { send(res, 415, { ok: false, error: 'CONTENT_TYPE' }); return null; }
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) {
    const big = e && e.code === 'TOO_LARGE';
    send(res, big ? 413 : 400, { ok: false, error: big ? 'TOO_LARGE' : 'BAD_JSON' });
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { ok: false, error: 'BAD_JSON' }); return null; }
  return body;
}

// The room.json view handed to the UI: seat records without anything token-like.
function publicRoom(room) {
  if (!room) return null;
  return { ...room, seats: (room.seats || []).map((s) => { const { token, ...rest } = s; return rest; }) };
}

// startHttp({service, port, host='127.0.0.1', uiDir, log}) -> Promise<{server, port, url, close, rejected}>
export function startHttp({ service, port = 0, uiDir = UI_DIR, log = () => {} } = {}) {
  if (!service) throw new Error('startHttp: service is required');
  let boundPort = port;
  const rejected = [];
  const seatIds = () => (service.room && Array.isArray(service.room.seats) ? service.room.seats.map((s) => s.seatId) : []);

  const server = http.createServer(async (req, res) => {
    try {
      const gate = checkHostOrigin(req.headers, boundPort, { method: req.method, path: String(req.url || '').split('?')[0] });
      if (!gate.ok) { send(res, gate.status, { ok: false, error: gate.error }); return; }
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${boundPort}`); } catch { send(res, 400, { ok: false, error: 'BAD_URL' }); return; }

      if (url.pathname === '/api/state') {
        if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        send(res, 200, { state: service.view(), room: publicRoom(service.room) });
        return;
      }
      if (url.pathname === '/api/events') {
        if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        const raw = url.searchParams.get('since');
        const since = raw === null || raw === '' ? 0 : Number(raw);
        if (!Number.isInteger(since) || since < 0) { send(res, 400, { ok: false, error: 'BAD_SINCE' }); return; }
        const evs = service.events;
        send(res, 200, { events: evs.filter((e) => typeof e.seq === 'number' && e.seq > since), lastSeq: evs.length ? evs[evs.length - 1].seq : 0 });
        return;
      }
      if (url.pathname === '/api/admin') {
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        const body = await jsonBody(req, res, url);
        if (!body) return;
        if (!tokenEquals(body.token, service.adminToken)) {
          const seatHit = seatIds().find((id) => tokenEquals(body.token, service.seatToken(id)));
          const rec = { ts: new Date().toISOString(), path: url.pathname, cmd: typeof body.cmd === 'string' ? body.cmd : null, reason: seatHit ? 'SEAT_TOKEN' : 'BAD_TOKEN', seatId: seatHit || null };
          rejected.push(rec);
          log(`[http] admin call refused: ${rec.reason}${seatHit ? ` (seat ${seatHit} token)` : ''} cmd=${rec.cmd || '-'}`);
          send(res, 401, { ok: false, error: rec.reason });
          return;
        }
        const { token: _drop, ...cmd } = body;
        if (typeof cmd.cmd !== 'string') { send(res, 400, { ok: false, error: 'UNKNOWN_CMD' }); return; }
        const r = await service.admin(cmd);
        send(res, r && r.ok === false && r.error === 'UNKNOWN_CMD' ? 400 : 200, r || { ok: false });
        return;
      }
      const sm = /^\/seat\/([a-z-]+)$/.exec(url.pathname);
      if (sm) {
        if (req.method !== 'POST') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
        const body = await jsonBody(req, res, url);
        if (!body) return;
        const cmd = sm[1];
        if (!SEAT_COMMANDS.includes(cmd)) { send(res, 404, { ok: false, error: 'UNKNOWN_SEAT_CMD' }); return; }
        const seatId = typeof body.seatId === 'string' ? body.seatId : '';
        if (!seatIds().includes(seatId) || !tokenEquals(body.token, service.seatToken(seatId))) {
          rejected.push({ ts: new Date().toISOString(), path: url.pathname, reason: 'BAD_SEAT_TOKEN', seatId: seatId || null });
          send(res, 401, { ok: false, error: 'BAD_SEAT_TOKEN' });
          return;
        }
        const { token: _t, seatId: _s, ...rest } = body;
        const r = await service.seatRequest(seatId, cmd, rest);
        send(res, 200, r);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, { ok: false, error: 'METHOD' }); return; }
      const f = staticFile(uiDir, url.pathname);
      if (!f) { send(res, 404, { ok: false, error: 'NOT_FOUND' }); return; }
      send(res, 200, fs.readFileSync(f.abs), f.type);
    } catch (e) {
      log(`[http] ${req.method} ${req.url}: ${e && e.message}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'INTERNAL' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve({
        server,
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/`,
        rejected,
        close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}
