// Offline search eval over an eval set of { q, slug, lang } rows, per language.
//   npm run search-eval -- --file <eval.json> [--expect rrf-english|rrf-bilingual] [--arm control|bilingual]
// Arms are pinned by session: set CLAUDE_CODE_SESSION_ID to a session id that buckets to the arm (createApi sends it
// as x-headjack-session). Each row prints the variant that answered; --expect exits 1 naming the first row answered
// by another variant, and a run that sees more than one variant always exits 1 (without a session every request gets
// a random one, so a split flag mixes arms).
// --arm pins the flag values of that arm with a cookie header handed to createApi, taken from HEADJACK_OVERRIDE_CONTROL or
// HEADJACK_OVERRIDE_BILINGUAL (values from `vercel flags override`). Those override tokens need FLAGS_SECRET, which
// Vercel does not expose, so they cannot be produced today; --arm is kept for when they can.
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRemote } from '../cli/config.mjs';
import { stateDir } from '../cli/local-config.mjs';
import { createApi } from '../cli/api.mjs';

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) : '0');

const ARM_VARS = { control: 'HEADJACK_OVERRIDE_CONTROL', bilingual: 'HEADJACK_OVERRIDE_BILINGUAL' };

function usage(message) {
  const e = new Error(message);
  e.code = 'usage';
  return e;
}

const FILE_USAGE = 'usage: npm run search-eval -- --file <eval.json>';

// The cookie that carries the pinned flag values.
export const OVERRIDE_COOKIE = 'vercel-flag-overrides';

// Returns the headers to build the API with; never copies override values into messages.
export function armHeaders(argv, env) {
  const i = argv.indexOf('--arm');
  if (i === -1) return { arm: 'default', headers: {} };
  const arm = argv[i + 1];
  if (!Object.hasOwn(ARM_VARS, arm)) throw usage(`${FILE_USAGE} [--arm control|bilingual]`);
  const value = env[ARM_VARS[arm]];
  if (!value) throw usage(`${ARM_VARS[arm]} is missing for --arm ${arm} (value from "vercel flags override")`);
  return { arm, headers: { cookie: `${OVERRIDE_COOKIE}=${value}` } };
}

const VARIANTS = ['rrf-english', 'rrf-bilingual'];

// The variant every result must carry (--expect), or undefined when the run does not pin one.
export function expectArg(argv) {
  const i = argv.indexOf('--expect');
  if (i === -1) return undefined;
  const expected = argv[i + 1];
  if (!VARIANTS.includes(expected)) throw usage(`${FILE_USAGE} [--expect rrf-english|rrf-bilingual]`);
  return expected;
}

// The eval set to read (--file, required): there is no default, because the eval set is the owner's catalog.
export function fileArg(argv) {
  const i = argv.indexOf('--file');
  const file = i === -1 ? undefined : argv[i + 1];
  if (!file || file.startsWith('--')) throw usage(FILE_USAGE);
  return file;
}

// Top-3 hit rate (the pass criterion) plus top-1 accuracy per language. Every slug must be in the vault.
// Every result must carry `expect` when given, and the whole run one variant: otherwise it throws naming the row.
export async function evaluate(pairs, api, log = console.log, { expect } = {}) {
  const seen = new Set();
  const byLang = { en: { evaluated: 0, top3: 0, top1: 0 }, es: { evaluated: 0, top3: 0, top1: 0 } };
  for (const { q, slug, lang } of pairs) {
    if (!(await api.getSkill(slug))) throw new Error(`slug missing from the vault: ${slug}`);
    const stats = (byLang[lang] ??= { evaluated: 0, top3: 0, top1: 0 });
    stats.evaluated++;
    const results = await api.search(q, 3, undefined, [], 'eval');
    const top = results.map((r) => r.slug);
    const variants = [...new Set(results.map((r) => r.variant))];
    const ok = top.includes(slug);
    if (ok) stats.top3++;
    if (top[0] === slug) stats.top1++;
    log(`${ok ? (top[0] === slug ? 'ok1 ' : 'ok  ') : 'MISS'}  ${slug}  ← "${q}"  top3=${top.join(', ')}  variant=${variants.join('|') || '-'}`);
    const wrong = expect ? variants.filter((v) => v !== expect) : [];
    if (wrong.length) throw new Error(`variant ${wrong[0] ?? '(none)'} instead of ${expect} in row "${q}" (${slug})`);
    for (const v of variants) seen.add(v);
    if (seen.size > 1) throw new Error(`mixed variants in one run (${[...seen].join(', ')}) in row "${q}" (${slug})`);
  }
  log('');
  for (const [lang, s] of Object.entries(byLang)) {
    log(`${lang}: ${s.top3}/${s.evaluated} in top 3 (${pct(s.top3, s.evaluated)}%) · top 1 ${s.top1}/${s.evaluated}`);
  }
  return { byLang };
}

export function passes(byLang) {
  const { en, es } = byLang;
  return en.evaluated >= 10 && es.evaluated >= 10 && en.top3 / en.evaluated >= 0.9;
}

// Runs only when invoked as a script, so tests can import evaluate() without calling the API.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  let arm, headers, expect, file;
  const env = process.env;
  try {
    ({ arm, headers } = armHeaders(process.argv.slice(2), env));
    expect = expectArg(process.argv.slice(2));
    file = fileArg(process.argv.slice(2));
  } catch (e) { console.error(e.message); process.exit(2); }
  const pairs = JSON.parse(await readFile(resolve(file), 'utf8'));
  const dir = stateDir({ env, home: env.HOME });
  const api = createApi({ ...(await loadRemote({ env, dir })), dir, env, headers });
  console.log(`arm: ${arm}${expect ? `  expect: ${expect}` : ''}`);
  let byLang;
  try { ({ byLang } = await evaluate(pairs, api, console.log, { expect })); } catch (e) { console.error(e.message); process.exit(1); }
  process.exit(passes(byLang) ? 0 : 1);
}
