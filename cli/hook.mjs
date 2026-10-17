// `headjack hook <name>`: the Claude Code hooks (spec §4.1). `prompt` runs the suggestion pipeline on every prompt,
// `warmup` prepares the search off the prompt path and `skill-used` logs a Skill tool call (spec §5.1). The pipeline is
// imported by `prompt` alone, so the other two stay cheap. A hook never blocks or breaks a session: every failure ends in no
// output, and the only trace is one line in <dir>/suggest/hook.log. No npm dependencies.
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from '../lib/errors.mjs';
import { SESSION_ID_RE, pruneSessions, sessionStore } from '../lib/suggest-session.mjs';
import { loadSuggestConfig } from '../lib/suggest-config.mjs';
import { appendEvent } from '../lib/suggest-log.mjs';
import { toVaultSlug } from '../lib/skill-name.mjs';
import { enabledPlugins } from './active.mjs';

// Two consecutive failures in one session open the breaker for ten minutes (spec §3.8).
const BREAKER_FAILURES = 2;
const BREAKER_OPEN_MS = 10 * 60 * 1000;
const HOOK_LOG_MAX_BYTES = 1024 * 1024;
const WARMUP_QUERY = 'warm up the headjack skill search';
const MAX_NOTE_CHARS = 200;
const MAX_SKILL_NAME_CHARS = 200;
const TIMEOUT = Symbol('deadline');

const LAUNCHER = fileURLToPath(new URL('./headjack', import.meta.url));
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// A problem the hook knows how to describe without any input: its message goes to hook.log as written.
class HookNote extends Error {}

// ---- hook.log ----

const logDir = (dir) => path.join(dir, 'suggest');

// One line per exception. It never carries input: a message is kept only when this code or a UserError wrote it (a
// UserError names a file or a key, never the prompt); any other error is reduced to its class and code, because the
// message of a parser or SQLite error can quote the text it choked on. Best effort, rotated at 1 MiB.
async function logHook(dir, hook, error, session, now) {
  try {
    const kept = error instanceof HookNote || error instanceof UserError;
    const line = {
      at: new Date(now()).toISOString(), hook, session: session ?? null,
      error: error?.name ?? 'Error', ...(error?.code ? { code: String(error.code).slice(0, 40) } : {}),
      ...(kept ? { message: String(error.message).slice(0, MAX_NOTE_CHARS) } : {}),
    };
    const file = path.join(logDir(dir), 'hook.log');
    await mkdir(logDir(dir), { recursive: true, mode: 0o700 });
    await chmod(logDir(dir), 0o700);
    let size = 0;
    try { size = (await stat(file)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (size > HOOK_LOG_MAX_BYTES) await rename(file, path.join(logDir(dir), 'hook.1.log'));
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}

// ---- hook input ----

function parseInput(stdin) {
  try {
    const data = JSON.parse(stdin);
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

const validSession = (input) => (typeof input?.session_id === 'string' && SESSION_ID_RE.test(input.session_id) ? input.session_id : undefined);

// ---- prompt ----

// `t0` is the instant the deadline and latency_ms count from, on the performance.now() clock (milliseconds since the
// process started): the hook process passes 0, so Node startup, the stdin read and the imports count against the deadline.
async function promptHook({ stdin, env, home, dir, now, adapters, t0 }) {
  const input = parseInput(stdin);
  const sessionId = validSession(input);
  const store = sessionStore(dir, { now });

  let config;
  try {
    config = await loadSuggestConfig(dir);
  } catch (e) {
    // A malformed config makes the hook a no-op, logged once per session (a session without a usable id logs every time).
    let logged = false;
    if (sessionId) {
      try { logged = (await store.breaker(sessionId)).configLogged; } catch { /* log it */ }
    }
    if (!logged) {
      await logHook(dir, 'prompt', e, sessionId, now);
      if (sessionId) await store.setBreaker(sessionId, { configLogged: true }).catch(() => {});
    }
    return '';
  }
  if (config.suggest.enabled !== true) return '';
  if (typeof input?.prompt !== 'string') throw new HookNote('malformed hook input');

  const { suggest, formatBlock } = await import('../lib/suggest.mjs');
  const { suggestDeps } = await import('./suggest-deps.mjs');
  const mode = config.suggest.hosted ? 'hosted' : 'local';
  const deadlineMs = config.suggest.deadlineMs[mode];
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
  const runEvent = (r) => appendEvent(dir, {
    type: 'run', entry: 'hook', session: sessionId ?? null, at: new Date(now()).toISOString(), mode: r.mode ?? mode, variant: r.variant ?? null,
    latency_ms: r.latency_ms ?? Math.round(performance.now() - t0), outcome: r.outcome, lang_guess: r.lang_guess ?? null,
    active_keys: r.active_keys ?? [], candidates: r.candidates ?? [],
  });

  // The circuit breaker, per session: with no usable session id there is no state and no breaker.
  let breaker = { failures: 0, openUntil: null };
  if (sessionId) {
    try { breaker = await store.breaker(sessionId); } catch { /* best effort */ }
    if (breaker.openUntil !== null) {
      if (now() < breaker.openUntil) {
        await runEvent({ outcome: 'skipped:breaker' });
        return '';
      }
      breaker = { failures: 0, openUntil: null };
      await store.setBreaker(sessionId, breaker).catch(() => {});
    }
  }

  // The search is raced against the deadline, which is measured from t0 (the start of the process for a hook process). A hosted call is aborted; a
  // local one is synchronous SQLite bounded by its busy timeout, so a late answer is discarded instead. The timer is
  // cleared as soon as the race ends, so nothing else keeps the process alive.
  const abort = new AbortController();
  let over = false;
  const base = suggestDeps({ ctx: { env, dir, home, cwd }, config, sessionId, migrate: false, signal: abort.signal, adapters });
  // After the deadline nothing may be remembered as suggested: the user never saw it.
  const deps = { ...base, now, sessionStore: { seen: (id) => base.sessionStore.seen(id), add: (id, slugs) => (over ? Promise.resolve() : base.sessionStore.add(id, slugs)) } };
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { over = true; abort.abort(); resolve(TIMEOUT); }, Math.max(0, deadlineMs - (performance.now() - t0)));
  });
  const run = suggest({ text: input.prompt, entry: 'hook', sessionId, cwd, home, config, deps }).then((result) => ({ result }), (error) => ({ error }));
  let settled;
  try {
    settled = await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
  const timedOut = settled === TIMEOUT || performance.now() - t0 > deadlineMs;
  over = true;

  let failed = false;
  let output = '';
  if (timedOut) {
    failed = true;
    await runEvent({ outcome: 'timeout' });
  } else if (settled.error) {
    // Only an error the transport marked as a failure counts; a usage error or an unexpected one does not.
    failed = settled.error.failure === true;
    await runEvent({ outcome: 'error' });
    await logHook(dir, 'prompt', settled.error, sessionId, now);
  } else {
    const { result } = settled;
    await runEvent(result);
    if (result.outcome === 'suggested') {
      const url = result.mode === 'hosted' && !env.HEADJACK_URL ? config.suggest.url : undefined;
      const block = formatBlock(result.suggestions, { mode: result.mode, launcher: LAUNCHER, url });
      if (block) output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: block } });
    }
  }

  if (sessionId) {
    // Skipped outcomes and empty answers are neither failures nor proof the transport works; only a real answer resets.
    const answered = !timedOut && !settled.error && (settled.result.outcome === 'suggested' || settled.result.outcome === 'none');
    let next = null;
    if (failed) {
      next = breaker.failures + 1 >= BREAKER_FAILURES
        ? { failures: 0, openUntil: now() + BREAKER_OPEN_MS }
        : { failures: breaker.failures + 1, openUntil: null };
    } else if (answered && breaker.failures > 0) {
      next = { failures: 0, openUntil: null };
    }
    if (next) await store.setBreaker(sessionId, next).catch(() => {});
  }
  return output;
}

// ---- warmup ----

async function warmupHook({ stdin, env, home, dir, now, adapters }) {
  const config = await loadSuggestConfig(dir);
  if (config.suggest.enabled !== true) return;
  const sessionId = validSession(parseInput(stdin));
  await pruneSessions(dir, now());
  if (config.suggest.hosted) {
    const hosted = adapters?.hostedSearch ?? (await import('../lib/suggest-hosted.mjs')).hostedSearch;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.suggest.deadlineMs.hosted);
    try {
      await hosted({ env, dir, config, query: WARMUP_QUERY, purpose: 'warmup', sessionId, signal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  // Migrations are applied here, off the prompt path; a missing vault is never created.
  const { vaultFile, openVault } = await import('../lib/local/schema.mjs');
  if (!existsSync(vaultFile(dir))) return;
  const { runtimeCheck } = await import('../lib/local/runtime.mjs');
  openVault({ dir, DatabaseSync: (await runtimeCheck()).DatabaseSync }).close();
}

// ---- skill-used ----

// Every vault slug, read-only: no vault, a busy one or an unusable one gives an empty set (the invoke is logged unmapped).
async function vaultSlugs(dir) {
  try {
    const { openVaultReadOnly } = await import('../lib/local/schema.mjs');
    const { runtimeCheck } = await import('../lib/local/runtime.mjs');
    const opened = openVaultReadOnly({ dir, DatabaseSync: (await runtimeCheck()).DatabaseSync });
    if (!opened.ok) return new Set();
    try {
      return new Set(opened.db.prepare('select slug from skills').all().map((r) => r.slug));
    } finally {
      opened.db.close();
    }
  } catch {
    return new Set();
  }
}

// PostToolUse(Skill): one `invoke` event, log only (no session file, no network). The name goes through toVaultSlug; the
// tool's arguments are never read, since they can quote the prompt.
async function skillUsedHook({ stdin, home, dir, now }) {
  const input = parseInput(stdin);
  if (input?.tool_name !== 'Skill') return;
  const skill = input.tool_input?.skill;
  if (typeof skill !== 'string' || skill === '' || skill.length > MAX_SKILL_NAME_CHARS) return;
  const slug = toVaultSlug(skill, { slugs: await vaultSlugs(dir), enabledPlugins: await enabledPlugins(home) });
  await appendEvent(dir, { type: 'invoke', session: validSession(input) ?? null, at: new Date(now()).toISOString(), skill, slug });
}

// runHook(name, { stdin, env, home, dir, now, adapters, t0 }) resolves to { stdout } and never rejects: any exception gives
// an empty stdout and one hook.log line. `now` is the clock (the breaker's); `adapters` replaces the search adapters
// (tests); `t0` is where the prompt deadline starts on the performance.now() clock (default: this call; hookMain passes 0,
// the start of the process). Any other name is a no-op.
export async function runHook(name, { stdin = '', env = process.env, home = env.HOME, dir, now = Date.now, adapters, t0 = performance.now() } = {}) {
  try {
    if (name === 'prompt') return { stdout: await promptHook({ stdin, env, home, dir, now, adapters, t0 }) };
    if (name === 'warmup') await warmupHook({ stdin, env, home, dir, now, adapters });
    if (name === 'skill-used') await skillUsedHook({ stdin, home, dir, now });
    return { stdout: '' };
  } catch (e) {
    await logHook(dir, String(name), e, undefined, now);
    return { stdout: '' };
  }
}
