// The README is the first page of the public repository, so every image it shows must ship in the tree, in a light format:
// a WebP of at most 400 KB, or the brand mark. Remote images are not allowed: the page must render offline and from a clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BYTES = 400 * 1024;
const MIN_IMAGES = 4;
const MARK = 'public/brand/mark.svg';

// Every image a Markdown document shows: `![alt](path)` and `<img ... src="path" ... alt="...">`, as { src, alt }.
export function imagesOf(text) {
  const found = [];
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) found.push({ src: m[2], alt: m[1] });
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) found.push({ src, alt: tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '' });
  }
  return found;
}

const isRelative = (src) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src);
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const images = imagesOf(readme).filter((image) => isRelative(image.src));

test('imagesOf finds Markdown images first, then HTML ones', () => {
  const sample = '![One](a/b.webp)\n<img src="c.svg" alt="Two" width="40">\n![](https://x.invalid/y.png)';
  assert.deepEqual(imagesOf(sample), [
    { src: 'a/b.webp', alt: 'One' },
    { src: 'https://x.invalid/y.png', alt: '' },
    { src: 'c.svg', alt: 'Two' },
  ]);
});

test(`the README shows at least ${MIN_IMAGES} images from the tree`, () => {
  assert.ok(images.length >= MIN_IMAGES, `the README shows ${images.length} relative images, fewer than ${MIN_IMAGES}`);
});

test('the README shows no remote image', () => {
  const remote = imagesOf(readme).filter((image) => !isRelative(image.src)).map((image) => image.src);
  assert.deepEqual(remote, []);
});

test('every README image exists, is a WebP (or the brand mark) and is at most 400 KB', () => {
  for (const { src } of images) {
    const file = path.join(ROOT, decodeURI(src));
    assert.ok(existsSync(file), `${src} does not exist`);
    assert.ok(src.endsWith('.webp') || src === MARK, `${src} must be a .webp file or ${MARK}`);
    const size = statSync(file).size;
    assert.ok(size <= MAX_BYTES, `${src} is ${size} bytes, over ${MAX_BYTES}`);
  }
});

test('every README image has alt text', () => {
  for (const { src, alt } of images) assert.ok(alt.trim().length > 0, `${src} has no alt text`);
});
