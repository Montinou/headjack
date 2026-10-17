// Review status of a skill's current version, derived from versions.review_notes. No npm dependencies.
// cli/import.mjs writes these exact prefixes on versions nobody reviewed; everything else counts as approved.
const UNREVIEWED_PREFIXES = ['grandfathered:', 'plugin:', 'plugin skill:'];

export function reviewOf(notes) {
  return typeof notes === 'string' && UNREVIEWED_PREFIXES.some((p) => notes.startsWith(p)) ? 'unreviewed' : 'approved';
}
