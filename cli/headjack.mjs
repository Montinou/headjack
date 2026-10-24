#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { UserError, EofError } from '../lib/errors.mjs';
import { loadUrl, resolveMode } from './config.mjs';
import { tokenFile } from './credentials.mjs';
import { stateDir } from './local-config.mjs';
import { guardLocal, openApi } from './connect.mjs';
import { exitCodeFor } from './exit.mjs';
import { activeKeys, isActive } from './active.mjs';
import { add, remove, list, verify, gc, cleanup, parseDuration } from './install.mjs';
import { review } from './review.mjs';
import { planImport, runImport, trim, restore } from './import.mjs';
import { exec } from './exec.mjs';
import { detectHarnesses, skillsDir } from './harness.mjs';
import { login, logout, whoami } from './login.mjs';

const USAGE = `headjack — personal skill vault

  headjack login [--force]
  headjack logout
  headjack whoami
  headjack search "<need>" [-k N] [--tag a,b] [--purpose suggest|plan|manual|eval|warmup] [--json]
  headjack add <slug> [--to claude,codex,grok|all|<id,…>] [--project] [--session] [--source suggest|plan|manual]
  headjack remove <slug> [--from <id,…>] [--if-session]
  headjack cleanup [--harness <id,…>] [--older-than 12h|30m|2d] [--dry-run]
  headjack suggest "<text>" [--json] [--explain] [--session-id <id>]
  headjack suggest --enable [--hosted|--local] | --disable
  headjack suggest --report [--since 7d|12h|30m] [--json]
  headjack suggest --calibrate [--mode local|hosted] [--json]
  headjack suggest --save --expect <slug|none> [--lang es|en]   (prompt from stdin, or $VISUAL / $EDITOR on a terminal)
  headjack hook prompt|warmup|skill-used   (internal: run by the Claude Code hooks, not by hand)
  headjack list [--active] [--json]
  headjack harness detect
  headjack review <github-url|git-url|path> [--path sub/dir] [--slug s]
  headjack audit <slug> [--json]
  headjack updates [--grandfathered]
  headjack import --dry-run | import [--interactive]
  headjack import --trim [--keep a,b] [--only-harness <id,…>] [--dry-run]
  headjack enrich [--stale] [<slug>…]
  headjack pull [--replace <slug>]…
  headjack verify
  headjack restore <backup-dir>
  headjack gc
  headjack mcp

suggest searches the vault for skills that fit <text> and prints the ones you do not have (nothing when the vault is
missing). --enable / --disable turn the prompt hook's suggestions on and off in <state dir>/config.json; --hosted / --local
pick the search the hook uses. --session-id <id> remembers what was suggested for that session. --report prints, from the
suggestion log, how many suggestions were taken (hit), left alone (ignored) or beaten by a skill you added or used anyway (missed).
--calibrate measures the suggestions against <state dir>/suggest/eval.json (rows of { q, slug | null, lang }, at least 20 per
language including 8 with slug: null): precision, recall and latency per language with their raw counts, and 5-fold
cross-validated thresholds printed as guidance. --mode picks the search (default: suggest.hosted). It never writes config.json.

enrich (local mode only) writes Spanish example requests for vault skills so Spanish prompts match them. It is opt-in: set
"enrich": { "enabled": true } in <state dir>/config.json and give an AI Gateway key in AI_GATEWAY_API_KEY or in
<state dir>/ai-gateway-key (mode 0600). It sends each skill's name, description and the first 6,000 characters of its body to the
Vercel AI Gateway, after a secret scan of exactly that text; never your prompts. Without slugs it takes the skills that have no
Spanish text yet, --stale those enriched by an older prompt too, and <slug>… exactly those skills. Hosted skills are enriched by
the server. With enrich.enabled, import also enriches the skills it publishes.

pull copies your approved hosted skills into the local vault (needs HEADJACK_URL and a hosted credential, whatever the mode).
A skill changed in the local vault since it was pulled (or there before any pull) is never overwritten: it is skipped while
hosted has a newer version, until --replace <slug> takes hosted. Pulled skills follow hosted: updates does not track their
upstream, so run pull again to refresh them. Exits 1 when any skill failed.

Harness ids: claude, codex, grok and any that "harness detect" finds (gemini, cursor, windsurf, …);
"all" = every detected one. --session marks the install so that "cleanup" removes it.

Mode: local (a SQLite vault at <state dir>/vault.db, no server) when HEADJACK_URL is unset, hosted when it is set;
HEADJACK_MODE=local|remote overrides. Needs Node 22.16+ or 24+ for local mode.
Config: HEADJACK_URL, and the credential: "headjack login" (a browser sign-in, saved in <state dir>/token) or
an API key with skills:read (and skills:write for review) in HEADJACK_TOKEN or in that file (chmod 600).
State dir: $HEADJACK_HOME, default ~/.headjack. HEADJACK_TOKEN wins over the file.
HEADJACK_PURPOSE sets the default --purpose.
mcp serves the Model Context Protocol over stdio (read-only tools: search_skills, get_skill, list_my_skills, install_command) on
the same vault or server; a client starts it, and it ends when its input closes. HEADJACK_MCP_TIMEOUT_MS sets the request timeout.`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  k: { type: 'string', short: 'k' },
  tag: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  active: { type: 'boolean' }, // list shows only active entries anyway (spec §5)
  to: { type: 'string' },
  from: { type: 'string' },
  project: { type: 'boolean' },
  path: { type: 'string' },
  slug: { type: 'string' },
  grandfathered: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  interactive: { type: 'boolean' },
  trim: { type: 'boolean' },
  keep: { type: 'string' },
  session: { type: 'boolean' },
  harness: { type: 'string' },
  'older-than': { type: 'string' },
  'only-harness': { type: 'string' },
  source: { type: 'string' },
  purpose: { type: 'string' },
  'if-session': { type: 'boolean' },
  force: { type: 'boolean' },
  'session-id': { type: 'string' },
  explain: { type: 'boolean' },
  enable: { type: 'boolean' },
  disable: { type: 'boolean' },
  hosted: { type: 'boolean' },
  local: { type: 'boolean' },
  report: { type: 'boolean' },
  calibrate: { type: 'boolean' },
  mode: { type: 'string' },
  since: { type: 'string' },
  save: { type: 'boolean' },
  expect: { type: 'string' },
  lang: { type: 'string' },
  stale: { type: 'boolean' },
  replace: { type: 'string', multiple: true },
};

const SOURCES = ['suggest', 'plan', 'manual'];
const PURPOSES = ['suggest', 'plan', 'manual', 'eval', 'warmup'];

function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new UserError(`${name} expects ${allowed.join('|')} (got: ${value})`);
  return value;
}

const KEEP_REASON = {
  differs: 'differs from the imported copy',
  'not-in-vault': 'not in the vault',
  'not-imported': 'not imported',
  'work-path': 'under an excluded root',
  broken: 'broken symlink',
  managed: 'installed by headjack',
};

// The plugin's own version, for the MCP server info. A missing or unreadable manifest must not stop the server.
async function pluginVersion() {
  try {
    const { version } = JSON.parse(await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch { return '0.0.0'; }
}

// The mode and the server named in the MCP `instructions`, computed without throwing: a bad HEADJACK_MODE or HEADJACK_URL must
// not end the process before `initialize`, and the first tool call reports it.
function mcpEnvironment(env) {
  let mode = 'unconfigured';
  try { mode = resolveMode(env) === 'local' ? 'local' : 'hosted'; } catch { /* reported by the first tool call */ }
  let origin;
  if (mode === 'hosted') {
    try { origin = loadUrl(env); } catch { /* the generic hosted text */ }
  }
  return { mode, origin };
}

const SUGGEST_USAGE = 'suggest "<text>" [--json] [--explain] [--session-id <id>] | suggest --enable [--hosted|--local] | suggest --disable | suggest --report [--since <dur>] [--json] | suggest --calibrate [--mode local|hosted] [--json] | suggest --save --expect <slug|none> [--lang es|en]';
const dash = (v) => (v === null || v === undefined ? '-' : v);

// One --explain line per candidate: the signals, then what the filters decided.
function explainLine(c, slugPattern) {
  const slug = typeof c.slug === 'string' && slugPattern.test(c.slug) ? c.slug : '<invalid slug>';
  const signals = ['fts_rank', 'vector_rank', 'similarity', 'table_rank', 'bm25_gap', 'matched_terms'].map((k) => `${k}=${dash(c[k])}`);
  return `  ${slug}  ${signals.join(' ')}  active=${c.active} review=${c.review} passed=${c.passed} rejected_by=${dash(c.rejected_by)}`;
}

// `headjack hook <name>` (internal, spec §4.1): the same code the plugin hooks run through cli/hook-entry.mjs, which reads
// the hook JSON from stdin, prints what the hook returns and exits 0 whatever happens.
async function hookCommand(name) {
  try {
    const { hookMain } = await import('./hook-entry.mjs');
    return await hookMain(name);
  } catch {
    process.exit(0);
  }
}

function need(value, usage) {
  if (!value) throw new UserError(`usage: headjack ${usage}`);
  return value;
}

async function main(argv) {
  // `hook` goes before parseArgs and the --help branch: a hook prints nothing and exits 0 whatever it is given, so an
  // unknown option or --help must never reach the USAGE text or a non-zero exit.
  if (argv[0] === 'hook') return hookCommand(argv[1]);
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }); } catch (e) { throw new UserError(e.message); }
  const { values: o, positionals: [cmd, ...args] } = parsed;
  if (!cmd || o.help) { console.log(USAGE); return 0; }

  const home = process.env.HOME;
  // One readline and one shared line iterator for every prompt: rl.question() loses the lines a pipe delivers in a
  // single chunk and fails with "readline was closed" once stdin ends, so agents could not drive review/import.
  let rl;
  let lines;
  let closed = false;
  const ctx = {
    home, cwd: process.cwd(), env: process.env, dir: stateDir({ env: process.env, home }), exec,
    log: (m) => console.log(m),
    prompt: async (q) => {
      if (!rl) {
        rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.once('close', () => { closed = true; });
        lines = rl[Symbol.asyncIterator]();
      }
      if (closed) process.stdout.write(q);
      else { rl.setPrompt(q); rl.prompt(); }
      const { value, done } = await lines.next();
      if (done) throw new EofError('input ended (EOF) while waiting for an answer');
      return value;
    },
  };
  const isLocal = () => resolveMode(process.env) === 'local';
  const local = (open) => guardLocal(ctx.dir, open);
  const openVault = () => local(async () => {
    const { runtimeCheck } = await import('../lib/local/runtime.mjs');
    const { openVault: open } = await import('../lib/local/schema.mjs');
    return open({ dir: ctx.dir, DatabaseSync: (await runtimeCheck()).DatabaseSync });
  });
  const connect = async () => {
    const { api, repo, close } = await openApi(ctx);
    ctx.api = api;
    ctx.repo = repo;
    ctx.closeApi = close;
  };
  const localLine = async () => {
    const { vaultFile } = await import('../lib/local/schema.mjs');
    return `local mode: nothing to log in to (vault: ${vaultFile(ctx.dir)})`;
  };

  try {
    switch (cmd) {
      case 'login': {
        if (isLocal()) { console.log(await localLine()); return 0; }
        const { email } = await login({ url: loadUrl(process.env), dir: ctx.dir, force: o.force, env: process.env }, { log: ctx.log });
        console.log(`logged in as ${email}`);
        return 0;
      }
      case 'logout': {
        // A saved login file is still handed to the hosted logout in local mode, so a hosted user who unsets HEADJACK_URL can
        // still log out: an OAuth login is deleted, while an API-key file is left in place (the keys are revoked on the server;
        // exit 2, as in hosted mode).
        if (isLocal() && !(await access(tokenFile(ctx.dir)).then(() => true, () => false))) { console.log(await localLine()); return 0; }
        const { revoked } = await logout({ dir: ctx.dir }, {});
        console.log(revoked ? 'logged out' : 'logged out (the tokens could not be revoked at the server; the local login was removed)');
        return 0;
      }
      case 'whoami': {
        if (isLocal()) {
          const { vaultInfo, vaultFile, isDamaged, damagedMessage } = await import('../lib/local/schema.mjs');
          const db = await openVault();
          try {
            let info;
            try { info = vaultInfo(db); } catch (e) { throw isDamaged(e) ? new UserError(damagedMessage(ctx.dir)) : e; }
            console.log(`local vault ${vaultFile(ctx.dir)} (schema ${info.schemaVersion}, ${info.skills} skills)`);
          } finally {
            db.close();
          }
          return 0;
        }
        const r = await whoami({ url: loadUrl(process.env), dir: ctx.dir, env: process.env }, {});
        console.log(r.kind === 'oauth' ? `oauth (file) ${r.email}, expires ${new Date(r.expiresAt).toISOString()}` : `api key (${r.source})`);
        console.log(`server: ${r.status}`);
        // A rejected credential is the user's to fix, so a non-2xx status exits 2 after printing.
        return r.status >= 200 && r.status < 300 ? 0 : 2;
      }
      case 'search': {
        const q = need(args.join(' ').trim(), 'search "<need>"');
        // An empty HEADJACK_PURPOSE counts as unset; an explicit empty --purpose is rejected.
        const purpose = o.purpose !== undefined
          ? oneOf(o.purpose, PURPOSES, '--purpose')
          : oneOf(process.env.HEADJACK_PURPOSE || 'manual', PURPOSES, 'HEADJACK_PURPOSE');
        await connect();
        const tags = (o.tag ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);
        const results = await ctx.api.search(q, o.k ? Number(o.k) : 8, undefined, tags, purpose);
        const keys = await activeKeys(ctx);
        const rows = results.map((r) => ({ ...r, active: isActive(r, keys) }));
        if (o.json) console.log(JSON.stringify(rows, null, 2));
        else if (!rows.length) console.log('no results');
        else for (const r of rows) console.log(`${r.active ? '●' : '○'} ${r.slug}  [${r.kind}${r.update_available ? ', update' : ''}]\n    ${r.description}${r.tags?.length ? `\n    tags: ${r.tags.join(', ')}` : ''}${r.alternatives?.length ? `\n    also: ${r.alternatives.join(', ')}` : ''}`);
        return 0;
      }
      case 'suggest': {
        const text = args.join(' ').trim();
        if ((o.expect !== undefined || o.lang !== undefined) && !o.save) throw new UserError('--expect and --lang go with --save (headjack suggest --save --expect <slug|none>)');
        if (o.save) {
          if (text) throw new UserError('--save never takes the prompt as an argument (shell history keeps it): pipe it on stdin or let it open $VISUAL / $EDITOR');
          if (o.report || o.calibrate || o.mode !== undefined || o.since !== undefined || o.enable || o.disable || o.hosted || o.local || o.explain || o.json || o['session-id'] !== undefined || o.k !== undefined || o.tag?.length || o.purpose !== undefined || o.project) throw new UserError(`--save takes no other suggest option except --expect and --lang (usage: headjack ${SUGGEST_USAGE})`);
          if (o.expect === undefined) throw new UserError('--save needs --expect <slug|none>: the skill this prompt should surface, or none');
          const [{ SLUG_RE }, { guessLang }, { appendCase }, { readPrompt }] = await Promise.all([
            import('../lib/handlers.mjs'), import('../lib/suggest.mjs'), import('../lib/suggest-log.mjs'), import('./suggest-save.mjs'),
          ]);
          if (o.expect !== 'none' && !SLUG_RE.test(o.expect)) throw new UserError('--expect must be a slug (letters, digits, . _ @ : -) or none');
          const lang = o.lang === undefined ? undefined : oneOf(o.lang, ['es', 'en'], '--lang');
          const q = await readPrompt();
          await appendCase(ctx.dir, { q, slug: o.expect === 'none' ? null : o.expect, lang: lang ?? guessLang(q), at: new Date().toISOString() });
          console.log('saved the case to the suggest cases file');
          return 0;
        }
        if (o.mode !== undefined && !o.calibrate) throw new UserError('--mode goes with --calibrate (headjack suggest --calibrate --mode hosted)');
        if (o.calibrate) {
          if (text || o.report || o.since !== undefined || o.enable || o.disable || o.hosted || o.local || o.explain || o['session-id'] !== undefined || o.k !== undefined || o.tag?.length || o.purpose !== undefined || o.project) throw new UserError(`--calibrate takes no text and no other suggest option except --mode and --json (usage: headjack ${SUGGEST_USAGE})`);
          const asked = o.mode === undefined ? undefined : oneOf(o.mode, ['local', 'hosted'], '--mode');
          const [{ loadSuggestConfig }, { evalFile, loadEvalSet, checkMinimums, calibrate, formatCalibration }, { suggestDeps }] = await Promise.all([
            import('../lib/suggest-config.mjs'), import('../lib/suggest-calibrate.mjs'), import('./suggest-deps.mjs'),
          ]);
          const config = await loadSuggestConfig(ctx.dir);
          const rows = await loadEvalSet(ctx.dir);
          const missing = checkMinimums(rows);
          if (missing.length) throw new UserError(`the eval set ${evalFile(ctx.dir)} is too small to calibrate (it needs 20 rows per language, 8 of them with slug: null):\n  ${missing.join('\n  ')}`);
          // The mode follows --mode, else suggest.hosted only, never HEADJACK_MODE or HEADJACK_URL. Each row is searched once
          // with purpose eval and entry eval: no log, no active state. Like the manual entry, it migrates the vault, so a
          // plugin update that adds migrations does not skip every row. config.json is never written.
          const mode = asked ?? (config.suggest.hosted ? 'hosted' : 'local');
          const report = await calibrate({
            rows, mode, config, cwd: ctx.cwd, home: ctx.home,
            depsFor: (sessionId) => suggestDeps({ ctx, config, sessionId, purpose: 'eval', migrate: true, hybrid: true }),
          });
          // The kept search records stay out of the JSON: they are working data, not the report.
          console.log(o.json ? JSON.stringify({ ...report, rows: report.rows.map(({ record, ...row }) => row) }, null, 2) : formatCalibration(report));
          return 0;
        }
        if (o.since !== undefined && !o.report) throw new UserError('--since goes with --report (headjack suggest --report --since 7d)');
        if (o.report) {
          if (text || o.enable || o.disable || o.hosted || o.local || o.explain || o['session-id'] !== undefined) throw new UserError(`--report takes no text and no other suggest option except --since and --json (usage: headjack ${SUGGEST_USAGE})`);
          const [{ readEvents }, { outcomes, summarize, formatReport }] = await Promise.all([import('../lib/suggest-log.mjs'), import('../lib/suggest-report.mjs')]);
          const since = o.since === undefined ? undefined : Date.now() - parseDuration(o.since, '--since');
          // The whole log (capped at 2 x 5 MiB): a run older than --since still governs the adds after it, so only the
          // outcomes are trimmed to --since, in outcomes() and summarize().
          const events = await readEvents(ctx.dir);
          const result = outcomes(events, { since });
          const rows = summarize(result, events);
          console.log(o.json ? JSON.stringify({ ...result, rows }, null, 2) : formatReport(rows, result, { sinceLabel: o.since }));
          return 0;
        }
        if (o.enable && o.disable) throw new UserError('--enable and --disable cannot go together');
        if (o.hosted && o.local) throw new UserError('--hosted and --local cannot go together');
        if ((o.hosted || o.local) && !o.enable) throw new UserError('--hosted and --local go with --enable (headjack suggest --enable --hosted)');
        const { loadSuggestConfig, editSuggestConfig } = await import('../lib/suggest-config.mjs');
        if (o.enable || o.disable) {
          if (text) throw new UserError(`--enable and --disable take no text (usage: headjack ${SUGGEST_USAGE})`);
          await editSuggestConfig(ctx.dir, { suggest: { enabled: Boolean(o.enable), ...(o.hosted ? { hosted: true } : o.local ? { hosted: false } : {}) } });
          const config = await loadSuggestConfig(ctx.dir);
          console.log(`suggestions ${config.suggest.enabled ? 'enabled' : 'disabled'} (${config.suggest.hosted ? 'hosted' : 'local'} search)`);
          return 0;
        }
        need(text, SUGGEST_USAGE);
        const [{ suggest, formatBlock }, { SLUG_RE }, { appendEvent }, { SESSION_ID_RE }, { suggestDeps }] = await Promise.all([
          import('../lib/suggest.mjs'), import('../lib/handlers.mjs'), import('../lib/suggest-log.mjs'),
          import('../lib/suggest-session.mjs'), import('./suggest-deps.mjs'),
        ]);
        const sessionId = o['session-id'];
        // The id names a file under <state dir>/suggest/sessions, so anything outside the pattern stops here.
        if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) throw new UserError('--session-id must match ^[A-Za-z0-9-]{1,64}$');
        const config = await loadSuggestConfig(ctx.dir);
        const mode = config.suggest.hosted ? 'hosted' : 'local';
        // The mode follows suggest.hosted only, never HEADJACK_MODE or HEADJACK_URL; the manual entry also migrates the vault.
        const deps = suggestDeps({ ctx, config, sessionId, migrate: true, hybrid: true });
        const started = Date.now();
        // The event carries no prompt text (spec §5.1); a failed search is logged as an 'error' run before it is reported.
        const logRun = (r) => appendEvent(ctx.dir, {
          type: 'run', entry: 'manual', session: sessionId ?? null, at: new Date(started).toISOString(), mode: r.mode, variant: r.variant,
          latency_ms: r.latency_ms, outcome: r.outcome, lang_guess: r.lang_guess, active_keys: r.active_keys, candidates: r.candidates,
        });
        let result;
        try {
          result = await suggest({ text, entry: 'manual', sessionId, cwd: ctx.cwd, home: ctx.home, config, deps });
        } catch (e) {
          await logRun({ mode, variant: null, latency_ms: Date.now() - started, outcome: 'error', lang_guess: null, active_keys: [], candidates: [] });
          throw e;
        }
        await logRun(result);
        // No vault: stay silent, so a caller that runs this for every user prints nothing for a hosted-only one.
        if (result.outcome === 'skipped:no-vault') return 0;
        if (o.json) {
          console.log(JSON.stringify({ outcome: result.outcome, mode: result.mode, suggestions: result.suggestions, candidates: result.candidates }, null, 2));
          return result.outcome === 'error' ? 1 : 0;
        }
        if (result.outcome === 'error') throw new Error('could not read what is already installed (state.json); run headjack verify');
        const url = result.mode === 'hosted' && !process.env.HEADJACK_URL ? config.suggest.url : undefined;
        const block = formatBlock(result.suggestions, { mode: result.mode, launcher: fileURLToPath(new URL('./headjack', import.meta.url)), url });
        console.log(block || `no suggestions (${result.outcome})`);
        if (o.explain) {
          console.log(result.candidates.length ? `candidates:\n${result.candidates.map((c) => explainLine(c, SLUG_RE)).join('\n')}` : 'candidates: none');
        }
        return 0;
      }
      case 'add': {
        need(args[0], 'add <slug>');
        const source = o.source !== undefined ? oneOf(o.source, SOURCES, '--source') : 'manual';
        await connect();
        await add(args[0], { to: o.to, project: o.project, session: o.session, source }, ctx);
        return 0;
      }
      case 'remove':
        await remove(need(args[0], 'remove <slug>'), { from: o.from, ifSession: o['if-session'] }, ctx);
        return 0;
      case 'cleanup': {
        const done = await cleanup({ harness: o.harness, olderThan: o['older-than'], dryRun: o['dry-run'] }, ctx);
        if (!done.length) console.log('nothing to clean up');
        for (const r of done) console.log(`${r.error ? 'failed' : o['dry-run'] ? 'would remove' : 'removed'}: ${r.slug} (${r.kind}; ${r.harnesses.join(', ')})${r.error ? `: ${r.error}` : ''}`);
        return done.some((r) => r.error) ? 1 : 0;
      }
      case 'list': {
        const entries = await list(ctx);
        if (o.json) console.log(JSON.stringify(entries, null, 2));
        else if (!entries.length) console.log('nothing active');
        else for (const e of entries) console.log(`${e.slug}  [${e.kind}]  ${e.targets.map((t) => t.harness).join(', ')}${e.sha256 ? `  ${e.sha256.slice(0, 12)}` : ''}`);
        return 0;
      }
      case 'review': {
        need(args[0], 'review <github-url|git-url|path>');
        await connect();
        const results = await review(args[0], { path: o.path, slug: o.slug }, ctx);
        for (const r of results) console.log(`${r.slug ?? '?'}: ${r.outcome}`);
        return 0;
      }
      case 'updates': {
        await connect();
        const rows = await ctx.api.updates(o.grandfathered);
        if (!rows.length) console.log(o.grandfathered ? 'no grandfathered skills left' : 'everything is up to date');
        for (const r of rows) {
          if (o.grandfathered) { console.log(r.slug); continue; }
          const current = r.reviewed_commit !== r.current_commit ? `  (current ${r.current_commit?.slice(0, 7)})` : '';
          console.log(`${r.slug}  reviewed ${r.reviewed_commit?.slice(0, 7)} → latest ${r.latest_commit?.slice(0, 7)}${current}  (headjack review ${r.source_url}${r.source_path ? ` --path ${r.source_path}` : ''} --slug ${r.slug})`);
        }
        return 0;
      }
      case 'audit': {
        const slug = need(args[0], 'audit <slug>');
        await connect();
        const rows = await ctx.api.reviews(slug);
        if (o.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { console.log('no reviews'); return 0; }
        const headers = ['date', 'status', 'commit', 'sha256', 'cur', 'notes'];
        const table = rows.map((r) => [
          (r.reviewed_at ?? '').slice(0, 10),
          r.status,
          r.commit_sha ? r.commit_sha.slice(0, 7) : '-',
          r.sha256.slice(0, 7),
          r.current ? '*' : '',
          r.review_notes ?? '',
        ]);
        const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
        const line = (row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ');
        console.log(line(headers));
        for (const row of table) console.log(line(row));
        return 0;
      }
      case 'import': {
        // Without --trim these flags would be ignored and `import --dry-run` would re-plan instead of simulating a trim.
        if (!o.trim && (o['only-harness'] !== undefined || o.keep !== undefined)) throw new UserError('--only-harness and --keep only go with --trim (headjack import --trim …)');
        if (o.trim) {
          const r = await trim({ keep: o.keep, onlyHarness: o['only-harness'], dryRun: o['dry-run'] }, ctx);
          const untouched = `plugins: left as they are (no corePlugins in ${path.join(ctx.dir, 'config.json')})`;
          if (o['dry-run']) {
            console.log('dry run: nothing is changed');
            for (const h of r.harnesses) {
              if (h.symlinked) { console.log(`${h.id} (${h.dir}): is a symlink; not touched`); continue; }
              console.log(`${h.id} (${h.dir}): would remove ${h.remove.length}, would keep ${h.keep.length}`);
              for (const p of h.remove) console.log(`  - ${path.basename(p)}`);
              for (const k of h.keep) console.log(`  = ${path.basename(k.path)} (${KEEP_REASON[k.reason] ?? k.reason})`);
            }
            const total = (f) => r.harnesses.reduce((n, h) => n + h[f].length, 0);
            console.log(`total: would remove ${total('remove')}, would keep ${total('keep')}\n${r.plugins === 'untouched' ? untouched : `plugins that would be disabled: ${r.disabled.join(', ') || 'none'}`}\nskill-finder would be installed in: ${r.finder.length} harness(es)`);
            return 0;
          }
          console.log(`backup: ${r.backup}\nremoved: ${r.removed.length}\n${r.harnesses.map((h) => `  ${h.id}: ${h.symlinked ? 'symlink, not touched' : `${h.remove.length} removed, ${h.keep.length} kept`}`).join('\n')}\n${r.plugins === 'untouched' ? untouched : `plugins disabled: ${r.disabled.join(', ') || 'none'}`}\n${r.disabledWork?.length ? `work plugins disabled: ${r.disabledWork.join(', ')}\n` : ''}skill-finder installed in: ${r.finder.length} harness(es)\nTo undo: headjack restore ${r.backup}`);
          return 0;
        }
        if (o['dry-run']) {
          const plan = await planImport(ctx);
          const count = (g) => plan.entries.filter((e) => e.group === g).length;
          console.log(`plan in ${path.join(ctx.dir, 'import-plan.json')}\n  with provenance: ${count('lock')}\n  local: ${count('local')}\n  under an excluded root (not uploaded): ${count('work')}\n  plugins: ${count('plugin')} (${count('plugin-skill')} skills)\nSet "upload": true/false on each pending entry or run: headjack import --interactive`);
          return 0;
        }
        await connect();
        const r = await runImport({ interactive: o.interactive }, ctx);
        console.log(`published: ${r.published.length}\nalready existed: ${r.existing.length}\nblocked: ${r.blocked.map((b) => `${b.slug} (${b.reason})`).join('; ') || 'none'}\nfailed: ${r.failed.map((f) => `${f.slug} (${f.reason})`).join('; ') || 'none'}\nnot uploaded: ${r.skipped.length}`);
        // Local mode only, and only when enrich.enabled: enrichment is a best effort after the import and never changes the
        // exit code (enrichAfterImport does not throw). Hosted skills are enriched by the server.
        if (isLocal() && r.published.length) {
          const { enrichAfterImport } = await import('./enrich-local.mjs');
          await enrichAfterImport({ repo: ctx.repo, published: r.published, env: process.env, dir: ctx.dir, log: ctx.log });
        }
        return 0;
      }
      case 'enrich': {
        if (!isLocal()) throw new UserError('the server enriches hosted skills; headjack enrich only works on the local vault');
        const [{ loadSuggestConfig }, { enrichCommand }] = await Promise.all([import('../lib/suggest-config.mjs'), import('./enrich-local.mjs')]);
        const config = await loadSuggestConfig(ctx.dir);
        await connect();
        return enrichCommand({ repo: ctx.repo, slugs: args, stale: Boolean(o.stale), config, env: process.env, dir: ctx.dir, log: ctx.log });
      }
      case 'pull': {
        if (args.length) throw new UserError('usage: headjack pull [--replace <slug>]…');
        const [{ SLUG_RE }, { pull }, { createApi }, { loadRemote }] = await Promise.all([
          import('../lib/handlers.mjs'), import('./pull.mjs'), import('./api.mjs'), import('./config.mjs'),
        ]);
        const replace = new Set(o.replace ?? []);
        for (const slug of replace) if (!SLUG_RE.test(slug)) throw new UserError('--replace expects a slug (letters, digits, . _ @ : -)');
        // Hosted from HEADJACK_URL and the credential whatever the mode; the local vault is opened directly.
        const hosted = createApi({ ...(await loadRemote({ env: process.env, dir: ctx.dir })), dir: ctx.dir, env: process.env });
        const { createLocalApi } = await import('../lib/local/api.mjs');
        const vault = await local(() => createLocalApi({ dir: ctx.dir, env: process.env }));
        ctx.closeApi = vault.close;
        const r = await pull({ hosted, local: vault, replace, log: ctx.log });
        console.log(`pulled: ${r.pulled.length}, unchanged: ${r.unchanged.length}, skipped: ${r.skipped.length}, failed: ${r.failed.length}`);
        return r.failed.length ? 1 : 0;
      }
      case 'verify': {
        const problems = await verify(ctx);
        if (isLocal()) {
          const db = await openVault();
          try {
            // Badly damaged pages make the check itself throw; that is a failed check too.
            let rows;
            try { rows = db.prepare('PRAGMA integrity_check').all().map((r) => String(r.integrity_check)); } catch (e) { rows = [e.message]; }
            if (rows.length !== 1 || rows[0] !== 'ok') problems.push(`vault integrity check failed: ${rows.slice(0, 5).join('; ')}`);
          } finally {
            db.close();
          }
        }
        for (const p of problems) console.log(`✗ ${p}`);
        if (!problems.length) console.log('everything in order');
        return problems.length ? 1 : 0;
      }
      case 'restore': {
        const r = await restore(need(args[0], 'restore <backup-dir>'), ctx);
        console.log(`restored: ${r.restored.length}${r.settings ? '; settings.json restored (the current one was kept as settings.json.pre-restore)' : ''}`);
        for (const d of r.skipped) console.log(`not touched (it was a symlink): ${d}`);
        for (const f of r.failed) console.log(`could not restore ${f.dir}: ${f.reason}`);
        return r.failed.length ? 1 : 0;
      }
      case 'harness': {
        if (args[0] !== 'detect') throw new UserError('usage: headjack harness detect');
        const found = await detectHarnesses(ctx);
        if (!found.length) console.log('no harness detected');
        for (const h of found) console.log(`${h}  ${skillsDir(h, { home })}`);
        console.log(`saved to ${path.join(ctx.dir, 'harnesses.json')}`);
        return 0;
      }
      case 'mcp': {
        const [{ createMcpServer, serveStdio, timeoutMs, withTimeout, MAX_JSON_BYTES }, { createTools }] = await Promise.all([import('./mcp.mjs'), import('./mcp-tools.mjs')]);
        const env = process.env;
        const fetchImpl = withTimeout(fetch, timeoutMs(env));
        // stdout is the protocol channel: this process's own notices go to stderr, never through ctx.log.
        const log = (message) => process.stderr.write(`${message}\n`);
        const server = createMcpServer({
          tools: createTools(),
          openApi: () => openApi(ctx, { env, log, fetchImpl, maxBodyBytes: MAX_JSON_BYTES }),
          version: await pluginVersion(),
          ...mcpEnvironment(env),
        });
        await serveStdio(server, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
        return 0;
      }
      case 'gc': {
        const removed = await gc(ctx);
        console.log(removed.length ? `deleted from the store: ${removed.join(', ')}` : 'nothing to delete');
        return 0;
      }
      default:
        throw new UserError(`unknown command: ${cmd} (headjack --help)`);
    }
  } finally {
    rl?.close();
    ctx.closeApi?.();
  }
}

// exitCode, not process.exit(): exit() drops stdout still queued for a pipe (async on macOS) and truncates --json.
main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    const code = exitCodeFor(e);
    // One line for any error; the stack of an unexpected one (1) only with HEADJACK_DEBUG.
    console.error(`headjack: ${e?.message ?? e}`);
    if (process.env.HEADJACK_DEBUG && e?.stack) console.error(e.stack);
    // Node's stack leaves out `cause`, which is where a failed runtime check keeps the real reason.
    if (process.env.HEADJACK_DEBUG) for (let c = e?.cause, i = 0; c && i < 3; c = c.cause, i += 1) console.error(`Caused by: ${c.stack ?? c}`);
    process.exitCode = code;
  },
);
