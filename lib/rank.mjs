// Post-fusion ranking adjustments for search. No npm dependencies.

// Quality prior: skills.quality holds four audit scores (reuse, trigger, content, health), each 0-3, so the sum is at
// most 12. The prior adds at most 0.0001 to the RRF score. With k = 60 one rank step in a list is worth
// 1/((60+r)(61+r)): ≈ 0.00026 at the top, still > 0.0001 down to rank ~40, so near the top the prior only settles
// ties (e.g. two skills that each won one list, the usual case) and near-ties; only deep in the 50-candidate lists
// can a maximal prior swap two neighbours.
export const QUALITY_PRIOR_WEIGHT = 0.0001;
const QUALITY_KEYS = ['reuse', 'trigger', 'content', 'health'];

export function qualityPrior(quality) {
  if (!quality || typeof quality !== 'object') return 0;
  const sum = QUALITY_KEYS.reduce((s, k) => s + (Number.isFinite(quality[k]) ? quality[k] : 0), 0);
  return (QUALITY_PRIOR_WEIGHT * sum) / 12;
}

// "<plugin>@<marketplace>" → "<plugin>", so two installs of one plugin from different marketplaces share a key.
function pluginName(pluginSlug) {
  const at = pluginSlug.lastIndexOf('@');
  return at > 0 ? pluginSlug.slice(0, at) : pluginSlug;
}

// Collapses plugin skills with the same name whose plugins differ only by marketplace. Input is ranked best first;
// the first of each group is kept and the others' slugs are attached as `alternatives`.
export function collapseInstalls(results) {
  const kept = [];
  const byKey = new Map();
  for (const r of results) {
    const key = r.plugin_slug ? `${r.name}\0${pluginName(r.plugin_slug)}` : null;
    const first = key && byKey.get(key);
    if (first) {
      (first.alternatives ??= []).push(r.slug);
      continue;
    }
    if (key) byKey.set(key, r);
    kept.push(r);
  }
  return kept;
}
