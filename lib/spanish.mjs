// Filler words of Spanish requests ("quiero hacer…", "¿cómo puedo…?"). The 'spanish' text-search config does not
// drop them as stop words, so without this list they would match almost every skill's Spanish queries.
export const SPANISH_FILLER = new Set(['quiero', 'necesito', 'como', 'cómo', 'hacer', 'puedo', 'ayudame', 'ayúdame', 'podés', 'podrías']);

// The Spanish full-text terms: the already-extracted query terms minus the filler words, compared case-insensitively.
export function spanishTerms(terms) {
  return terms.filter((t) => !SPANISH_FILLER.has(t.toLowerCase()));
}
