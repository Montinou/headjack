// .env.example lists exactly the variables the repository's shipped code reads. The file set is the source roots below
// walked on disk, minus the inline EXEMPT paths and minus test/, whose variables are test-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Every directory and file of the repository that can read the environment.
const SOURCE_ROOTS = [
  '.claude-plugin/', 'bin/', 'app/', 'components/', 'hooks/', 'lib/', 'cli/', 'db/', 'drizzle/', 'public/', 'skill-finder/', 'scripts/',
  'flags.ts', 'proxy.ts', 'next.config.ts', 'drizzle.config.ts', 'playwright.config.ts', 'vercel.ts',
];

// Read by libraries, never named in this code (Flags SDK, AI Gateway, Vercel OIDC, Clerk).
const IMPLICIT = ['FLAGS', 'AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'CLERK_SECRET_KEY', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'];
// Read through a computed name: the search-eval arm overrides, the names scripts/vercel-build.mjs redacts and the runtime
// keys scripts/ui-fixture-server.mjs copies into its child.
const COMPUTED = [
  'HEADJACK_OVERRIDE_CONTROL', 'HEADJACK_OVERRIDE_BILINGUAL',
  'DATABASE_URL_UNPOOLED', 'DATABASE_URL', 'HEADJACK_APP_DB_PASSWORD',
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS',
];
// Provided by the operating system, Node, CI, Vercel or the agent harness; subtracted by exact name.
const RUNTIME = [
  'HOME', 'PATH', 'NODE_ENV', 'CI', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'PORT', 'CLAUDE_CODE_SESSION_ID', 'VISUAL', 'EDITOR',
  'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS',
];

const NAME = /^[A-Z][A-Z0-9_]*$/;
// process.env.NAME and env.NAME (an injected or aliased environment object), optional chaining included.
const MEMBER = /\benv\??\.([A-Z][A-Z0-9_]*)\b/g;
// const { A, B: alias, C = default } = process.env | env | ctx.env
const DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:[\w$]+\??\.)*env\b/g;

// Paths whose variables are not part of .env.example. Empty: the export script and the other former exemptions are gone.
const EXEMPT = [];
const matches = (entry, rel) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry);

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) walk(path.posix.join(rel, name), out);
  } else {
    out.push(rel);
  }
  return out;
}

function shippedSources() {
  const files = new Set();
  for (const entry of SOURCE_ROOTS) {
    for (const rel of walk(entry.replace(/\/$/, ''), [])) {
      if (rel.startsWith('test/') || EXEMPT.some((e) => matches(e, rel))) continue;
      if (SOURCE.test(rel)) files.add(rel);
    }
  }
  return [...files].sort();
}

function collectEnvNames(files) {
  const names = new Set();
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of text.matchAll(MEMBER)) names.add(m[1]);
    for (const m of text.matchAll(DESTRUCTURE)) {
      for (const part of m[1].split(',')) {
        const key = part.trim().split(/[\s:=]/)[0];
        if (NAME.test(key)) names.add(key);
      }
    }
  }
  return names;
}

function listedNames() {
  const file = path.join(ROOT, '.env.example');
  if (!existsSync(file)) return new Set();
  const names = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

function readNames() {
  const runtime = new Set(RUNTIME);
  const all = new Set([...collectEnvNames(shippedSources()), ...IMPLICIT, ...COMPUTED]);
  return new Set([...all].filter((name) => !runtime.has(name)));
}

test('every variable read is listed in .env.example', () => {
  const listed = listedNames();
  const missing = [...readNames()].filter((name) => !listed.has(name)).sort();
  assert.deepEqual(missing, [], `read but not listed in .env.example: ${missing.join(', ')}`);
});

test('every listed variable is read', () => {
  const read = readNames();
  const unused = [...listedNames()].filter((name) => !read.has(name)).sort();
  assert.deepEqual(unused, [], `listed in .env.example but never read: ${unused.join(', ')}`);
});


test('the source roots are walked: the check reads many files, not an empty set', () => {
  assert.ok(shippedSources().length >= 100, `${shippedSources().length} source files`);
});
