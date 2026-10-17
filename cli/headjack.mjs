#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { UserError, EofError } from '../lib/errors.mjs';
import { loadUrl, resolveMode } from './config.mjs';
import { tokenFile } from './credentials.mjs';
import { stateDir } from './local-config.mjs';
import { guardLocal, openApi } from './connect.mjs';
import { exitCodeFor } from './exit.mjs';
import { activeKeys, isActive } from './active.mjs';
import { add, remove, list, verify, gc, cleanup } from './install.mjs';
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
  headjack list [--active] [--json]
  headjack harness detect
  headjack review <github-url|git-url|path> [--path sub/dir] [--slug s]
  headjack audit <slug> [--json]
  headjack updates [--grandfathered]
  headjack import --dry-run | import [--interactive]
  headjack import --trim [--keep a,b] [--only-harness <id,…>] [--dry-run]
  headjack verify
  headjack restore <backup-dir>
  headjack gc
  headjack mcp

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

function need(value, usage) {
  if (!value) throw new UserError(`usage: headjack ${usage}`);
  return value;
}

async function main(argv) {
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
    const { api, close } = await openApi(ctx);
    ctx.api = api;
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
        return 0;
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
