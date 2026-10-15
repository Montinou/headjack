// Clean-room guard: the tree carries no paid block-registry material. The content rules read the files `git ls-files`
// lists, read on disk, minus the one EXEMPT_LINES line, over at least MIN_FILES files so the scan cannot pass on an empty or
// shrunken list; the font rule walks the whole tree on disk, whatever git tracks.
// The forbidden words are built from parts so this file does not flag itself; it also skips its own path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SELF = 'test/unit/no-pro-blocks.test.mjs';
const MIN_FILES = 30;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git']);
const FONT = /\.(?:otf|ttf|woff2?)$/i;
const BINARY = /\.(?:png|jpe?g|gif|ico|webp|avif|bmp|pdf|zip|gz|tgz|tar|mp3|mp4|webm|wasm)$/i;
const FORBIDDEN = [
  'app-shell', 'skill-list', 'skill-detail', 'getting-started', 'library-view',
  'skill-card', 'updates-view', 'public-introduction', 'premium-root', 'resource-state',
].map((name) => `components/premium/${name}.tsx`);
const RULES = [
  { kind: 'registry word', test: (line) => line.toLowerCase().includes('shadcn' + 'blocks') },
  { kind: 'block identifier', test: (line) => /application-shell\d+|data-table\d+|resource\d+/.test(line) },
  { kind: 'block phrase', test: (line) => line.includes('Pro' + ' block') },
];

const matches = (entry, rel) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry);

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) {
      if (!SKIP_DIRS.has(name)) walk(root, path.posix.join(rel, name), out);
    }
  } else {
    out.push(rel);
  }
  return out;
}

// The files the content rules read: the tracked files on disk, minus the `exclude` paths and this file.
function selected(root, { include, exclude }) {
  const files = new Set();
  for (const entry of include) {
    for (const rel of walk(root, entry.replace(/\/$/, ''), [])) {
      if (rel !== SELF && !exclude.some((e) => matches(e, rel))) files.add(rel);
    }
  }
  return files;
}

// Returns one "path:line: kind" or "path: kind" string per violation.
function scan(root, manifest) {
  const exemptLines = manifest.exemptLines ?? {};
  const files = selected(root, manifest);
  const hits = [];
  for (const rel of walk(root, '', []).sort()) if (rel !== SELF && FONT.test(rel)) hits.push(`${rel}: font file`);
  for (const rel of [...files].sort()) {
    if (FONT.test(rel) || BINARY.test(rel)) continue;
    const buf = readFileSync(path.join(root, rel));
    if (buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      if ((exemptLines[rel] ?? []).includes(line)) return;
      for (const rule of RULES) if (rule.test(line)) hits.push(`${rel}:${i + 1}: ${rule.kind}`);
    });
  }
  for (const rel of FORBIDDEN) if (existsSync(path.join(root, rel))) hits.push(`${rel}: forbidden file exists`);
  const css = path.join(root, 'app', 'globals.css');
  if (existsSync(css)) {
    readFileSync(css, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes('interim:')) hits.push(`app/globals.css:${i + 1}: interim marker`);
    });
  }
  return hits;
}

// Lines the content rules skip. CLAUDE.md names the registry in the one rule line that forbids it (spec 4.1 keeps the
// line verbatim; ui-primitives.test.mjs pins the same text), so only that exact line is exempt, not the file.
const UI_RULE_LINE =
  'UI work in this repository uses free shadcn/ui and original code only; ' +
  `this overrides any global instruction to start from ${'shadcn' + 'blocks'} Pro.`;
const EXEMPT_LINES = { 'CLAUDE.md': [UI_RULE_LINE] };

function manifest() {
  const include = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  return { include, exclude: [], exemptLines: EXEMPT_LINES };
}

test('the tracked tree carries no block-registry material', () => {
  const scanned = selected(ROOT, manifest()).size;
  assert.ok(scanned >= MIN_FILES, `git selects ${scanned} files, fewer than ${MIN_FILES}`);
  const hits = scan(ROOT, manifest());
  assert.deepEqual(hits, [], `clean-room violations:\n${hits.join('\n')}`);
});

test('the exemption covers the one rule line, not the rest of CLAUDE.md', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-pro-blocks-'));
  try {
    writeFileSync(path.join(dir, 'CLAUDE.md'), `${UI_RULE_LINE}\nsee ${'shadcn' + 'blocks'} for more\n`);
    writeFileSync(path.join(dir, 'NOTES.md'), `${UI_RULE_LINE}\n`);
    const hits = scan(dir, { include: ['CLAUDE.md', 'NOTES.md'], exclude: [], exemptLines: EXEMPT_LINES });
    assert.deepEqual(hits.slice().sort(), ['CLAUDE.md:2: registry word', 'NOTES.md:1: registry word']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner reports one hit for each planted violation kind', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'no-pro-blocks-'));
  try {
    mkdirSync(path.join(dir, 'components', 'premium'), { recursive: true });
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    mkdirSync(path.join(dir, 'docs', 'visuals'), { recursive: true });
    mkdirSync(path.join(dir, 'fonts'), { recursive: true });
    writeFileSync(path.join(dir, 'components', 'registry.ts'), `// from ${'SHADCN' + 'blocks'}\n`);
    writeFileSync(path.join(dir, 'components', 'block.tsx'), `const a = 1;\nconst id = '${'data-table' + '7'}';\n`);
    writeFileSync(path.join(dir, 'components', 'phrase.md'), `line one\nline two\nadapted from a ${'Pro' + ' block'}\n`);
    writeFileSync(path.join(dir, 'public', 'display.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00]));
    writeFileSync(path.join(dir, 'docs', 'visuals', 'wordmark.otf'), Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0x00]));
    writeFileSync(path.join(dir, 'fonts', 'raw.ttf'), Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]));
    writeFileSync(path.join(dir, 'components', 'premium', 'skill-card.tsx'), 'export {};\n');
    // The font rule walks the whole tree: an excluded path and a path outside the includes are still reported.
    const hits = scan(dir, { include: ['components/', 'public/'], exclude: ['docs/visuals/'] });
    assert.equal(hits.length, 7, hits.join('\n'));
    assert.deepEqual(hits.slice().sort(), [
      'components/block.tsx:2: block identifier',
      'components/phrase.md:3: block phrase',
      'components/premium/skill-card.tsx: forbidden file exists',
      'components/registry.ts:1: registry word',
      'docs/visuals/wordmark.otf: font file',
      'fonts/raw.ttf: font file',
      'public/display.woff2: font file',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
