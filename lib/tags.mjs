// Tag helpers shared by the API, enrichment and scripts. No npm dependencies.
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 50;
export const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Lowercase kebab-case: separators become '-', anything else outside [a-z0-9-] is dropped.
export function normalizeTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, MAX_TAG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

// Union of the lists in order, normalized, deduped, empty items dropped, capped.
export function mergeTags(...lists) {
  const out = [];
  for (const list of lists) {
    for (const t of Array.isArray(list) ? list : []) {
      const n = normalizeTag(t);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out.slice(0, MAX_TAGS);
}

// skills.tags_text feeds the weighted fts column (array_to_string is not immutable, so the app maintains it).
export const tagsText = (tags) => tags.join(' ');
