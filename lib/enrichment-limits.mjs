// Limits on enrichment output, shared by lib/enrich.mjs and the publish handler, which re-applies them to whatever an
// injected enricher returns. No npm dependencies.
import { normalizeTag } from './tags.mjs';

export const MAX_QUERY_CHARS = 140;
export const MAX_QUERIES_EN = 5;
export const MAX_QUERIES_ES = 3;
export const MAX_QUERIES = 8; // combined cap: 5 English + 3 Spanish
export const MAX_ENRICH_TAGS = 6;
// Bounded work per item: a runaway string is cut before any regex runs over it.
const MAX_RAW_CHARS = MAX_QUERY_CHARS * 8;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Control characters (Postgres rejects NUL in text columns) and lone surrogates are dropped.
const stripUnsafe = (s) => s.replace(CONTROL_RE, '').replace(LONE_SURROGATE_RE, '');

function clip(q) {
  if (q.length <= MAX_QUERY_CHARS) return q;
  const cut = q.slice(0, MAX_QUERY_CHARS + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, MAX_QUERY_CHARS)).trim();
}

// One query: safe characters only, whitespace collapsed, at most MAX_QUERY_CHARS (cut at a word boundary when there is
// one). '' when nothing is left or the item is not a string.
export function cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  const q = clip(stripUnsafe(raw.slice(0, MAX_RAW_CHARS)).replace(/\s+/g, ' ').trim());
  return stripUnsafe(q).trim(); // a hard cut can split a surrogate pair
}

// Cleaned, deduped (case-insensitively, against `seen` too) and capped queries of one language.
function limitQueries(list, max, seen) {
  const out = [];
  for (const raw of list) {
    if (out.length === max) break;
    const q = cleanQuery(raw);
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    out.push(q);
  }
  return out;
}

// Charset, length and count limits for an enrichment of unknown origin: each language cleaned, deduped
// case-insensitively (English first, across both) and capped (MAX_QUERIES_EN, MAX_QUERIES_ES); `queries` is their
// concatenation, never more than MAX_QUERIES; tags normalized (lowercase kebab-case), deduped and capped at
// MAX_ENRICH_TAGS. The caller has already checked that queries_en, queries_es and tags are arrays.
export function limitEnrichment({ queries_en, queries_es, tags }) {
  const seen = new Set();
  const en = limitQueries(queries_en, MAX_QUERIES_EN, seen);
  const es = limitQueries(queries_es, MAX_QUERIES_ES, seen);
  const out = { queries_en: en, queries_es: es, queries: [...en, ...es].slice(0, MAX_QUERIES), tags: [] };
  for (const raw of tags) {
    if (out.tags.length === MAX_ENRICH_TAGS) break;
    const t = normalizeTag(raw);
    if (t && !out.tags.includes(t)) out.tags.push(t);
  }
  return out;
}
