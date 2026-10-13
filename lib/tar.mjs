import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { comparePaths } from './hash.mjs';

const BLOCK = 512;

export function assertSafePath(p) {
  const segments = p.split('/');
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0') ||
      segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe path in tar: ${JSON.stringify(p)}`);
  }
}

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', base: name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (base && Buffer.byteLength(base) <= 100 && Buffer.byteLength(prefix) <= 155) return { prefix, base };
  }
  throw new Error(`path too long for ustar: ${name}`);
}

function sumBytes(block) {
  let sum = 0;
  for (const b of block) sum += b;
  return sum;
}

export function buildHeader(name, mode, size, typeflag = '0') {
  const { prefix, base } = splitName(name);
  const h = Buffer.alloc(BLOCK);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(0, 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156);
  h.write(typeflag, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  h.write(sumBytes(h).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

export function pack(files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => comparePaths(a.path, b.path))) {
    assertSafePath(f.path);
    parts.push(buildHeader(f.path, f.mode, f.data.length), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

function field(h, start, len) {
  const s = h.subarray(start, start + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString('utf8');
}

function octalField(h, start, len, what, name) {
  const s = field(h, start, len).trim();
  if (!/^[0-7]+$/.test(s)) throw new Error(`invalid tar ${what} for ${name}`);
  return parseInt(s, 8);
}

const isZero = (b) => b.every((x) => x === 0);

export function unpack(gz, { maxOutputLength } = {}) {
  const buf = gunzipSync(gz, maxOutputLength === undefined ? {} : { maxOutputLength });
  const files = [];
  const seen = new Set();
  let off = 0;
  for (;;) {
    if (off + BLOCK > buf.length) throw new Error('truncated tar: missing end-of-archive');
    const h = buf.subarray(off, off + BLOCK);
    if (isZero(h)) {
      const next = buf.subarray(off + BLOCK, off + BLOCK * 2);
      if (next.length < BLOCK || !isZero(next)) throw new Error('truncated tar: missing end-of-archive');
      break;
    }
    const stored = parseInt(field(h, 148, 8).trim(), 8);
    const copy = Buffer.from(h);
    copy.fill(0x20, 148, 156);
    if (sumBytes(copy) !== stored) throw new Error('tar checksum mismatch');
    const base = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const name = prefix ? `${prefix}/${base}` : base;
    const type = String.fromCharCode(h[156]);
    if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry type ${JSON.stringify(type)} for ${name}`);
    assertSafePath(name);
    if (seen.has(name)) throw new Error(`duplicate path in tar: ${JSON.stringify(name)}`);
    seen.add(name);
    const mode = octalField(h, 100, 8, 'mode', name);
    const size = octalField(h, 124, 12, 'size', name);
    off += BLOCK;
    if (off + size > buf.length) throw new Error(`truncated tar entry: ${name}`);
    files.push({ path: name, mode: mode & 0o111 ? 0o755 : 0o644, data: Buffer.from(buf.subarray(off, off + size)) });
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

export async function writeFiles(root, files) {
  for (const f of files) {
    assertSafePath(f.path);
    const dest = path.join(root, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.data);
    await chmod(dest, f.mode);
  }
}
