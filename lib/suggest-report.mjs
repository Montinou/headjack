// Outcomes of the suggestions (spec §5.3), computed at read time from the session log: hit, ignored, missed. Pure over
// the events of lib/suggest-log.mjs (shapes: spec §5.1); the log never holds prompt text and neither does this.
// No npm dependencies.
import { SLUG_RE } from './handlers.mjs';
import { toVaultSlug } from './skill-name.mjs';

export const WINDOW_MS = 1_800_000;

const KNOWN_ENTRIES = new Set(['hook', 'manual', 'eval']);
const KNOWN_MODES = new Set(['local', 'hosted']);
// Only a run that searched read the active state: skipped and error runs log no active_keys at all.
const READ_ACTIVE = new Set(['suggested', 'none']);
const ENTRY_ORDER = ['hook', 'manual', 'eval', 'other'];

const isSession = (s) => typeof s === 'string' && s !== '';
const str = (v) => (typeof v === 'string' ? v : '');

// The plugin key of a vault slug "<plugin>@<marketplace>:<skill>", or null.
const pluginOf = (slug) => (slug.lastIndexOf(':') > 0 ? slug.slice(0, slug.lastIndexOf(':')) : null);

function prepare(events) {
  const runs = [];
  const adds = [];
  const invokes = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object' || !isSession(e.session)) continue;
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    if (e.type === 'run') runs.push({ ...e, t });
    else if (e.type === 'add' && typeof e.slug === 'string' && e.slug !== '') adds.push({ ...e, t });
    else if (e.type === 'invoke' && typeof e.skill === 'string') invokes.push({ ...e, t });
  }
  const byTime = (a, b) => a.t - b.t;
  return { runs: runs.sort(byTime), adds: adds.sort(byTime), invokes: invokes.sort(byTime) };
}

const group = (items) => {
  const m = new Map();
  for (const x of items) {
    if (!m.has(x.session)) m.set(x.session, []);
    m.get(x.session).push(x);
  }
  return m;
};

// The suggestions of one run: its candidates no filter rejected, in the order the search ranked them.
const suggestedSlugs = (run) => (Array.isArray(run.candidates) ? run.candidates : [])
  .filter((c) => c && typeof c.slug === 'string' && c.rejected_by == null).map((c) => c.slug);

function isActiveIn(run, slug) {
  const keys = new Set(Array.isArray(run.active_keys) ? run.active_keys : []);
  const plugin = pluginOf(slug);
  if (keys.has(slug) || (plugin && keys.has(plugin))) return true;
  return (Array.isArray(run.candidates) ? run.candidates : []).some((c) => c?.slug === slug && c.active === true);
}

// outcomes(events, { windowMs, since }) -> { window_ms, since, hits, ignored, missed }.
//   hits / ignored: one row per (run, suggested slug): { slug, session, entry, mode, lang_guess, at, added, invoked },
//     hit when the slug is added or invoked in the same session within `windowMs` after the run.
//   missed: { slug, session, at, via: 'add'|'invoke', rankInLastRun } (see the rules in spec §5.3).
// Runs and events without a session are excluded. `since` (ms) only trims what is reported: earlier events still count
// as context, so a run just before the cutoff does not turn its own add into a miss.
export function outcomes(events, { windowMs = WINDOW_MS, since } = {}) {
  const { runs, adds, invokes } = prepare(events);
  const runsBySession = group(runs);
  const addsBySession = group(adds);
  const invokesBySession = group(invokes);

  // The vault slugs a session's runs saw: the set a hosted invoke (logged without a slug) is mapped against.
  const knownSlugs = new Map();
  for (const [session, list] of runsBySession) {
    knownSlugs.set(session, new Set(list.flatMap((r) => (Array.isArray(r.candidates) ? r.candidates : []).map((c) => c?.slug).filter((s) => typeof s === 'string'))));
  }
  const slugOfInvoke = (inv) => {
    if (typeof inv.slug === 'string' && inv.slug !== '') return inv.slug;
    return toVaultSlug(inv.skill, { slugs: knownSlugs.get(inv.session) ?? new Set(), enabledPlugins: {} });
  };
  const decided = [];
  for (const e of adds) decided.push({ kind: 'add', slug: e.slug, session: e.session, t: e.t, at: e.at });
  for (const e of invokes) {
    const slug = slugOfInvoke(e);
    if (slug) decided.push({ kind: 'invoke', slug, session: e.session, t: e.t, at: e.at });
  }
  decided.sort((a, b) => a.t - b.t);

  const hits = [];
  const ignored = [];
  const suggestedAt = new Map(); // session -> [{ slug, t }] for the miss rule
  for (const run of runs) {
    const entry = KNOWN_ENTRIES.has(run.entry) ? run.entry : 'other';
    const mode = KNOWN_MODES.has(run.mode) ? run.mode : 'other';
    const lang_guess = run.lang_guess === 'es' || run.lang_guess === 'en' ? run.lang_guess : 'n/a';
    for (const slug of new Set(suggestedSlugs(run))) {
      if (!suggestedAt.has(run.session)) suggestedAt.set(run.session, []);
      suggestedAt.get(run.session).push({ slug, t: run.t });
      const within = decided.filter((d) => d.session === run.session && d.slug === slug && d.t >= run.t && d.t - run.t <= windowMs);
      const row = { slug, session: run.session, entry, mode, lang_guess, at: run.at };
      const added = within.some((d) => d.kind === 'add');
      const invoked = within.some((d) => d.kind === 'invoke');
      if (added || invoked) hits.push({ ...row, added, invoked });
      else ignored.push(row);
    }
  }

  const missed = [];
  const counted = new Set();
  for (const d of decided) {
    const hookRan = (runsBySession.get(d.session) ?? []).some((r) => r.entry === 'hook');
    if (!hookRan) continue;
    const key = `${d.session}\u0000${d.slug}`;
    if (counted.has(key)) continue;
    // Suggested in the window before: that is a hit, not a miss.
    if ((suggestedAt.get(d.session) ?? []).some((s) => s.slug === d.slug && s.t <= d.t && d.t - s.t <= windowMs)) continue;
    // The add already decided this slug; a later invoke of it adds nothing.
    if (d.kind === 'invoke' && (addsBySession.get(d.session) ?? []).some((a) => a.slug === d.slug && a.t <= d.t)) continue;
    const last = (runsBySession.get(d.session) ?? []).filter((r) => r.t <= d.t && READ_ACTIVE.has(r.outcome)).at(-1);
    if (!last) continue; // no run had read the state yet: nothing the hook could have suggested
    if (isActiveIn(last, d.slug)) continue;
    counted.add(key);
    const index = (Array.isArray(last.candidates) ? last.candidates : []).findIndex((c) => c?.slug === d.slug);
    missed.push({ slug: d.slug, session: d.session, at: d.at, via: d.kind, rankInLastRun: index === -1 ? null : index + 1 });
  }

  const keep = Number.isFinite(since) ? (x) => Date.parse(x.at) >= since : () => true;
  return {
    window_ms: windowMs,
    since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    hits: hits.filter(keep), ignored: ignored.filter(keep), missed: missed.filter(keep),
  };
}

const precision = (n, d) => ({ pct: d === 0 ? null : Math.round((100 * n) / d), n, d });

// summarize(outcomes, events) -> rows per entry x mode x lang_guess: { entry, mode, lang_guess, runs, hits, ignored,
// precision: { pct, n, d } }, precision = hits / (hits + ignored). `lang_guess` is "n/a" for runs that ended before the
// query was prepared. Criterion 4's precision is the `hook` rows.
export function summarize(result, events) {
  const since = result.since ? Date.parse(result.since) : -Infinity;
  const rows = new Map();
  const row = (entry, mode, lang) => {
    const key = `${entry}\u0000${mode}\u0000${lang}`;
    if (!rows.has(key)) rows.set(key, { entry, mode, lang_guess: lang, runs: 0, hits: 0, ignored: 0 });
    return rows.get(key);
  };
  const lang = (v) => (v === 'es' || v === 'en' ? v : 'n/a');
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'run' || !isSession(e.session) || !(Date.parse(e.at) >= since)) continue;
    row(KNOWN_ENTRIES.has(e.entry) ? e.entry : 'other', KNOWN_MODES.has(e.mode) ? e.mode : 'other', lang(e.lang_guess)).runs += 1;
  }
  for (const h of result.hits) row(h.entry, h.mode, h.lang_guess).hits += 1;
  for (const i of result.ignored) row(i.entry, i.mode, i.lang_guess).ignored += 1;
  return [...rows.values()]
    .sort((a, b) => ENTRY_ORDER.indexOf(a.entry) - ENTRY_ORDER.indexOf(b.entry) || a.mode.localeCompare(b.mode) || a.lang_guess.localeCompare(b.lang_guess))
    .map((r) => ({ ...r, precision: precision(r.hits, r.hits + r.ignored) }));
}

export const formatPrecision = ({ pct, n, d }) => `${pct === null ? 'n/a' : `${pct}%`} (${n}/${d})`;

// A slug read from the log is printed only when it has the shape of a vault slug.
const safeSlug = (s) => (typeof s === 'string' && SLUG_RE.test(s) ? s : '<invalid slug>');

// The text report. `sinceLabel` is what the user typed for --since (e.g. "7d"), echoed as given by the caller.
export function formatReport(rows, result, { sinceLabel } = {}) {
  const minutes = Math.round(result.window_ms / 60_000);
  const lines = [`Suggestion outcomes (window ${minutes} min, ${sinceLabel ? `since ${sinceLabel}` : 'whole log'})`];
  if (!rows.length) lines.push('no runs');
  else {
    const cells = rows.map((r) => [r.entry, r.mode, r.lang_guess, String(r.runs), String(r.hits), String(r.ignored), formatPrecision(r.precision)]);
    const head = ['entry', 'mode', 'lang', 'runs', 'hits', 'ignored', 'precision'];
    const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
    const fmt = (c) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();
    lines.push(fmt(head), ...cells.map(fmt), 'precision = hits / (hits + ignored); the hook rows are the ones that count');
  }
  lines.push('', `missed (${result.missed.length})`);
  for (const m of result.missed) {
    lines.push(`  ${safeSlug(m.slug)}  ${m.via === 'add' ? 'added' : 'invoked'}  ${m.rankInLastRun === null ? 'not a candidate' : `rank ${m.rankInLastRun} in the last run`}`);
  }
  return lines.join('\n');
}
