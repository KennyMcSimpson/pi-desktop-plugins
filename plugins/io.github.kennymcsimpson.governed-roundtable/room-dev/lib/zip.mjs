// Minimal ZIP writer and reader on Node built-ins (stored and deflate entries). Shared by the
// room export (lib/export.mjs) and the release build (dist/build.mjs). No npm dependency.
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// CRC32 (zlib.crc32 exists from Node 22.2; keep a table fallback so 22.0/22.1 still build)
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf, seed = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, seed) >>> 0;
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Minimal ZIP writer: stored or deflate entries, UTF-8 names (general purpose bit 11), no ZIP64.
// ---------------------------------------------------------------------------------------------
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  const dosDate = ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  return { dosDate, dosTime };
}

export function normalizeEntryName(name) {
  const n = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!n || n.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`bad zip entry name: ${name}`);
  return n;
}

export class ZipWriter {
  constructor({ level = 6, mtime } = {}) {
    this.level = level;
    const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) * 1000 : NaN;
    this.mtime = mtime || (Number.isFinite(epoch) ? new Date(epoch) : new Date());
    this.chunks = [];
    this.offset = 0;
    this.central = [];
    this.names = new Set();
  }

  add(name, data, { mtime, store = false } = {}) {
    const entryName = normalizeEntryName(name);
    if (this.names.has(entryName)) throw new Error(`duplicate zip entry: ${entryName}`);
    this.names.add(entryName);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let method = 0;
    let body = raw;
    if (!store && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: this.level });
      if (deflated.length < raw.length) { method = 8; body = deflated; }
    }
    const crc = crc32(raw);
    const nameBuf = Buffer.from(entryName, 'utf8');
    const { dosDate, dosTime } = dosDateTime(mtime || this.mtime);
    const flags = 0x0800; // UTF-8 names
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const headerOffset = this.offset;
    this.chunks.push(local, nameBuf, body);
    this.offset += local.length + nameBuf.length + body.length;
    this.central.push({ nameBuf, flags, method, dosTime, dosDate, crc, csize: body.length, usize: raw.length, headerOffset });
    if (this.offset > 0xffffffff) throw new Error('archive exceeds 4 GiB; ZIP64 is not implemented');
    return { name: entryName, method, bytes: raw.length, compressed: body.length, crc32: crc };
  }

  finish() {
    const cdStart = this.offset;
    const cdChunks = [];
    let cdSize = 0;
    for (const e of this.central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);  // version made by: MS-DOS, 2.0
      h.writeUInt16LE(20, 6);  // version needed
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.dosTime, 12);
      h.writeUInt16LE(e.dosDate, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.headerOffset, 42);
      cdChunks.push(h, e.nameBuf);
      cdSize += h.length + e.nameBuf.length;
    }
    if (this.central.length > 0xffff) throw new Error('more than 65535 entries; ZIP64 is not implemented');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.central.length, 8);
    eocd.writeUInt16LE(this.central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...this.chunks, ...cdChunks, eocd]);
  }
}

// ---------------------------------------------------------------------------------------------
// Minimal ZIP reader: central directory walk, stored/deflate entries, CRC check. No ZIP64.
// ---------------------------------------------------------------------------------------------
export function readZip(buf) {
  const minEocd = buf.length - 22;
  let eocd = -1;
  for (let i = minEocd; i >= Math.max(0, minEocd - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory header at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}: ${data.length} != ${usize}`);
    const isDir = name.endsWith('/');
    entries.push({ name, method, data, isDir, crc32Ok: isDir || crc32(data) === crc });
  }
  return entries;
}
