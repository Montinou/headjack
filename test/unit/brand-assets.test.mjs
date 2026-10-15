// Shipped images carry no metadata containers: no EXIF, XMP, ICC names, PNG text/time/provenance chunks or JPEG comments.
// The export's content check cannot read inside binaries, so this test is what keeps private metadata out of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PNG_ALLOWED = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Every walker fails closed: a byte it cannot place throws, a length past the end throws, and bytes after the image's
// end are reported as "trailing bytes" (data hidden there would not be seen otherwise).
const TRAILING = 'trailing bytes';

function pngChunks(buf) {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'not a PNG');
  const types = [];
  for (let at = 8; ;) {
    if (at + 12 > buf.length) throw new Error(`PNG truncated at byte ${at}: no IEND`);
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > buf.length) throw new Error(`PNG chunk ${type} at byte ${at} runs past the end`);
    types.push(type);
    at += 12 + length;
    if (type === 'IEND') {
      if (at < buf.length) types.push(TRAILING);
      return types;
    }
  }
}

// Walks every marker segment up to EOI, through the entropy-coded data after each SOS: a progressive JPEG has several
// scans with tables, and possibly APPn/COM, between them.
function jpegMarkers(buf) {
  assert.ok(buf[0] === 0xff && buf[1] === 0xd8, 'not a JPEG');
  const found = [];
  for (let at = 2; ;) {
    if (at + 2 > buf.length) throw new Error(`JPEG truncated at byte ${at}: no EOI`);
    if (buf[at] !== 0xff) throw new Error(`JPEG: unexpected byte 0x${buf[at].toString(16)} at ${at}, expected a marker`);
    while (buf[at + 1] === 0xff) at++; // fill bytes before a marker
    if (at + 2 > buf.length) throw new Error(`JPEG truncated at byte ${at}: no EOI`);
    const marker = buf[at + 1];
    if (marker === 0xd9) {
      if (at + 2 < buf.length) found.push(TRAILING);
      return found;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // standalone markers
    if (marker === 0x00 || marker === 0xd8) throw new Error(`JPEG: unexpected marker 0xff${marker.toString(16)} at ${at}`);
    if (at + 4 > buf.length) throw new Error(`JPEG segment at byte ${at} runs past the end`);
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) throw new Error(`JPEG segment 0xff${marker.toString(16)} at byte ${at} has a bad length`);
    if (marker >= 0xe1 && marker <= 0xef) found.push(`APP${marker - 0xe0}`);
    if (marker === 0xfe) found.push('COM');
    at += 2 + length;
    if (marker === 0xda) {
      // Entropy-coded data: 0xff00 is a stuffed byte, 0xffd0-0xffd7 a restart, 0xffff fill; any other 0xffXX ends it.
      for (;;) {
        if (at >= buf.length) throw new Error('JPEG truncated inside scan data: no EOI');
        if (buf[at] !== 0xff) { at++; continue; }
        const next = buf[at + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { at += 2; continue; }
        if (next === 0xff) { at++; continue; }
        break;
      }
    }
  }
}

// ICO: a 6-byte header, then one 16-byte directory entry per image. Every entry must point inside the file, past the
// directory; bytes after the last image are reported.
function icoImages(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = buf.readUInt16LE(4);
  const dirEnd = 6 + count * 16;
  if (dirEnd > buf.length) throw new Error(`ICO directory of ${count} entries runs past the end`);
  const images = [];
  let end = dirEnd;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    if (size === 0 || offset < dirEnd || offset + size > buf.length) throw new Error(`ICO entry ${i} (offset ${offset}, size ${size}) is out of range`);
    images.push(buf.subarray(offset, offset + size));
    end = Math.max(end, offset + size);
  }
  return { images, trailing: end < buf.length };
}

// WebP: a RIFF container, "RIFF" + size + "WEBP", then chunks of fourcc + little-endian size + data padded to even. Any
// EXIF or XMP chunk is reported, as are bytes after the RIFF's end; an unplaceable byte throws.
function webpChunks(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP');
  const end = 8 + buf.readUInt32LE(4);
  if (end > buf.length) throw new Error(`WebP RIFF size ${end} runs past the end`);
  const found = [];
  for (let at = 12; at < end;) {
    if (at + 8 > end) throw new Error(`WebP truncated at byte ${at}`);
    const type = buf.toString('latin1', at, at + 4);
    const length = buf.readUInt32LE(at + 4);
    if (at + 8 + length > end) throw new Error(`WebP chunk ${type} at byte ${at} runs past the end`);
    if (type === 'EXIF' || type === 'XMP ') found.push(type.trim());
    at += 8 + length + (length % 2);
  }
  if (end < buf.length) found.push(TRAILING);
  return found;
}

// The names of the metadata containers in an image: PNG chunks outside the rendering set, JPEG APPn (other than APP0)
// and COM segments, WebP EXIF and XMP chunks, bytes after the image's end, and for ICO the same PNG rule on each embedded PNG (BMP entries hold
// no metadata).
export function inspectImageMetadata(buf, ext) {
  if (ext === '.png') return pngChunks(buf).filter((type) => !PNG_ALLOWED.has(type));
  if (ext === '.jpg' || ext === '.jpeg') return jpegMarkers(buf);
  if (ext === '.webp') return webpChunks(buf);
  if (ext === '.ico') {
    const { images, trailing } = icoImages(buf);
    const found = [];
    for (const image of images) {
      if (image.subarray(0, 8).equals(PNG_SIGNATURE)) found.push(...inspectImageMetadata(image, '.png'));
    }
    if (trailing) found.push(TRAILING);
    return found;
  }
  throw new Error(`unsupported image type ${ext}`);
}

async function shippedImages() {
  const fixed = ['app/favicon.ico', 'app/icon.png'];
  const extra = [];
  // docs/images does not exist until the docs ship their illustrations: an empty glob is fine.
  for (const dir of ['public/images/headjack', 'docs/images']) {
    const names = await readdir(path.join(ROOT, dir)).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    extra.push(...names.filter((n) => n.endsWith('.webp')).map((n) => `${dir}/${n}`));
  }
  return [...fixed, ...extra];
}

const chunk = (type, data = Buffer.alloc(0)) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
};
const bytes = (...b) => Buffer.from(b);
const pngOf = (...chunks) => Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.alloc(13)), ...chunks, chunk('IDAT'), chunk('IEND')]);
const TEXT = chunk('tEXt', Buffer.from('k\0v'));
const SOI = bytes(0xff, 0xd8);
const APP0 = bytes(0xff, 0xe0, 0x00, 0x02);
// SOS, then entropy data holding a stuffed 0xff00 and a restart marker.
const SCAN = bytes(0xff, 0xda, 0x00, 0x02, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56);
const EOI = bytes(0xff, 0xd9);
const jpegOf = (...parts) => Buffer.concat([SOI, APP0, ...parts, EOI]);
const icoOf = (images) => {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((img, i) => {
    head.writeUInt32LE(img.length, 6 + i * 16 + 8);
    head.writeUInt32LE(offset, 6 + i * 16 + 12);
    offset += img.length;
  });
  return Buffer.concat([head, ...images]);
};

test('inspectImageMetadata finds PNG text chunks and JPEG EXIF', () => {
  assert.deepEqual(inspectImageMetadata(pngOf(), '.png'), []);
  assert.deepEqual(inspectImageMetadata(pngOf(TEXT), '.png'), ['tEXt']);
  assert.deepEqual(inspectImageMetadata(jpegOf(SCAN), '.jpg'), []);
  assert.deepEqual(inspectImageMetadata(jpegOf(bytes(0xff, 0xe1, 0x00, 0x04, 0x00, 0x00), SCAN), '.jpg'), ['APP1']);
});

test('inspectImageMetadata finds JPEG comments, markers after fill bytes and segments after a scan', () => {
  assert.deepEqual(inspectImageMetadata(jpegOf(bytes(0xff, 0xfe, 0x00, 0x03, 0x41), SCAN), '.jpg'), ['COM']);
  assert.deepEqual(inspectImageMetadata(jpegOf(bytes(0xff, 0xff, 0xff, 0xe1, 0x00, 0x02), SCAN), '.jpg'), ['APP1'], 'fill bytes before APP1');
  assert.deepEqual(inspectImageMetadata(jpegOf(SCAN, bytes(0xff, 0xe2, 0x00, 0x02), SCAN), '.jpg'), ['APP2'], 'APPn between scans');
  assert.deepEqual(inspectImageMetadata(jpegOf(SCAN, bytes(0xff, 0xfe, 0x00, 0x02)), '.jpg'), ['COM'], 'COM after the last scan');
});

test('inspectImageMetadata reports bytes after IEND, EOI or the last ICO image', () => {
  const hidden = Buffer.from('hidden');
  assert.deepEqual(inspectImageMetadata(Buffer.concat([pngOf(), hidden]), '.png'), ['trailing bytes']);
  assert.deepEqual(inspectImageMetadata(Buffer.concat([jpegOf(SCAN), hidden]), '.jpg'), ['trailing bytes']);
  assert.deepEqual(inspectImageMetadata(Buffer.concat([icoOf([pngOf()]), hidden]), '.ico'), ['trailing bytes']);
});

test('inspectImageMetadata looks inside ICO-embedded PNGs', () => {
  assert.deepEqual(inspectImageMetadata(icoOf([Buffer.alloc(40), pngOf()]), '.ico'), []);
  assert.deepEqual(inspectImageMetadata(icoOf([Buffer.alloc(40), pngOf(TEXT)]), '.ico'), ['tEXt']);
});

test('inspectImageMetadata fails closed on input it cannot walk', () => {
  assert.throws(() => inspectImageMetadata(Buffer.concat([SOI, APP0, bytes(0x00, 0xff, 0xd9)]), '.jpg'), /unexpected byte/);
  assert.throws(() => inspectImageMetadata(Buffer.concat([SOI, APP0, SCAN]), '.jpg'), /no EOI/);
  assert.throws(() => inspectImageMetadata(Buffer.concat([SOI, bytes(0xff, 0xe1, 0x00, 0x40, 0x00)]), '.jpg'), /bad length/);
  assert.throws(() => inspectImageMetadata(Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.alloc(13))]), '.png'), /no IEND/);
  const ico = icoOf([pngOf()]);
  ico.writeUInt32LE(ico.length, 6 + 12); // the entry's offset points past the end
  assert.throws(() => inspectImageMetadata(ico, '.ico'), /out of range/);
});

test('every shipped image has no metadata containers', async () => {
  const images = await shippedImages();
  assert.ok(images.length >= 3, `expected at least three shipped images, found ${images.join(', ')}`);
  for (const rel of images) {
    const found = inspectImageMetadata(await readFile(path.join(ROOT, rel)), path.extname(rel).toLowerCase());
    assert.deepEqual(found, [], `${rel} carries ${found.join(', ')}`);
  }
});

// The brand mark ships as a single minified line with no editor leftovers and no live type. The wordmark is live text
// in components/app/brand.tsx, so no wordmark file ships.
const SVG_FORBIDDEN = ['<metadata', '<!--', 'sodipodi', 'inkscape', '<text', '<font', '@font-face'];

test('the brand mark is a minified outline with no metadata, comments, editor namespaces or text', async () => {
  for (const rel of ['public/brand/mark.svg']) {
    const svg = await readFile(path.join(ROOT, rel), 'utf8');
    assert.ok(svg.startsWith('<svg'), `${rel} does not start with <svg`);
    assert.equal(svg.trimEnd().split('\n').length, 1, `${rel} is not a single line`);
    for (const term of SVG_FORBIDDEN) assert.ok(!svg.toLowerCase().includes(term), `${rel} contains ${term}`);
  }
});

test('the social image is generated: app/opengraph-image.tsx exists and the jpg does not', () => {
  assert.ok(existsSync(path.join(ROOT, 'app/opengraph-image.tsx')), 'app/opengraph-image.tsx is missing');
  assert.ok(!existsSync(path.join(ROOT, 'app/opengraph-image.jpg')), 'app/opengraph-image.jpg still ships');
});

test('no wordmark file ships', async () => {
  assert.ok(!existsSync(path.join(ROOT, 'public/brand/wordmark.svg')), 'public/brand/wordmark.svg still ships');
  const brand = await readFile(path.join(ROOT, 'components/app/brand.tsx'), 'utf8');
  assert.ok(!brand.includes('wordmark.svg'), 'brand.tsx still points at the wordmark file');
});

test('the archive illustration is WebP under 400 KB with no EXIF or XMP chunk', async () => {
  const rel = 'public/images/headjack/knowledge-archive-v1.webp';
  const buf = await readFile(path.join(ROOT, rel));
  assert.ok(buf.length < 400 * 1024, `${rel} is ${buf.length} bytes`);
  assert.deepEqual(inspectImageMetadata(buf, '.webp'), []);
  assert.ok(!existsSync(path.join(ROOT, 'public/images/headjack/knowledge-archive-v1.png')), 'the PNG original still ships');
  const intro = await readFile(path.join(ROOT, 'components/app/introduction.tsx'), 'utf8');
  assert.ok(intro.includes('/images/headjack/knowledge-archive-v1.webp'), 'introduction.tsx does not use the WebP');
});

const riff = (...chunks) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
const webpChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.write(type, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
};

test('inspectImageMetadata rejects a WebP with an EXIF chunk', () => {
  const vp8x = webpChunk('VP8X', Buffer.alloc(10));
  const clean = riff(vp8x);
  assert.equal(clean.length, 30, 'the fixture is 30 bytes');
  assert.deepEqual(inspectImageMetadata(clean, '.webp'), []);
  const withExif = riff(vp8x, webpChunk('EXIF', Buffer.from('II*\0', 'latin1')));
  assert.deepEqual(inspectImageMetadata(withExif, '.webp'), ['EXIF']);
  assert.deepEqual(inspectImageMetadata(riff(vp8x, webpChunk('XMP ', Buffer.from('x'))), '.webp'), ['XMP']);
  assert.deepEqual(inspectImageMetadata(Buffer.concat([clean, Buffer.from('hidden')]), '.webp'), ['trailing bytes']);
  assert.throws(() => inspectImageMetadata(Buffer.from('RIFF0000WAVE'), '.webp'), /not a WebP/);
});
