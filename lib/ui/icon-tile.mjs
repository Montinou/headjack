// Icon tile mapping (spec section 5): a stable tint per slug and an icon per kind.
export const TILE_TINTS = Object.freeze(["cobalt", "teal", "amber", "rose", "violet", "green"]);

/**
 * FNV-1a 32-bit hash of the slug's UTF-8 bytes, mod the six tints.
 * @param {string} slug
 * @returns {string}
 */
export function tintForSlug(slug) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(slug)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return TILE_TINTS[hash % TILE_TINTS.length];
}

/**
 * @param {"skill" | "plugin"} kind
 * @param {string | null} pluginSlug
 * @returns {"book" | "puzzle" | "layers"}
 */
export function iconForKind(kind, pluginSlug) {
  if (kind === "plugin") return "puzzle";
  return pluginSlug ? "layers" : "book";
}
