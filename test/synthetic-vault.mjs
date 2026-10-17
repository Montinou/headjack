// A deterministic synthetic local vault, for calibrating and testing the suggestion rule (scripts/derive-local-gap.mjs,
// the e2e tests): `skills` random skills whose ~25-word descriptions and ~400-word bodies are drawn from a seeded
// vocabulary of generated words by Zipf rank (a few words in most documents, a long tail in few, like real text), plus
// the `planted` skills published exactly as written. HEADJACK_HOME=<dir> then points at a valid vault (vault.db inside dir).
import { runtimeCheck } from '../lib/local/runtime.mjs';
import { openVault } from '../lib/local/schema.mjs';
import { createSqliteRepo } from '../lib/local/sqlite-repo.mjs';

export const VOCABULARY_SIZE = 3000;
const DESCRIPTION_WORDS = 25;
const BODY_WORDS = 400;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const WORD_LENGTH = { min: 5, max: 9 };

// mulberry32: a small seeded PRNG returning floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// VOCABULARY_SIZE distinct lowercase words, ordered by Zipf rank (index 0 is the most frequent), deterministic per seed.
export function syntheticVocabulary(seed) {
  const rand = mulberry32(seed);
  const seen = new Set();
  while (seen.size < VOCABULARY_SIZE) {
    const length = WORD_LENGTH.min + Math.floor(rand() * (WORD_LENGTH.max - WORD_LENGTH.min + 1));
    seen.add(Array.from({ length }, () => LETTERS[Math.floor(rand() * LETTERS.length)]).join(''));
  }
  return [...seen];
}

// The index of a word drawn with probability proportional to 1 / (rank + 1): log-uniform over the vocabulary.
export function zipfIndex(rand, size) {
  return Math.min(size - 1, Math.floor(Math.exp(rand() * Math.log(size + 1))) - 1);
}

// `count` random queries of two distinct vocabulary words each, drawn like the text (so common and rare words both
// appear), deterministic per (seed, querySeed).
export function syntheticQueries({ seed = 7, querySeed = 11, count = 1000 } = {}) {
  const vocabulary = syntheticVocabulary(seed);
  const rand = mulberry32(querySeed);
  return Array.from({ length: count }, () => {
    const first = zipfIndex(rand, vocabulary.length);
    let second = zipfIndex(rand, vocabulary.length);
    while (second === first) second = zipfIndex(rand, vocabulary.length);
    return `${vocabulary[first]} ${vocabulary[second]}`;
  });
}

// Deterministic per call: derived from the seed and the skill's index, not from earlier calls in the process.
const sha256Of = (seed, index) => `${seed.toString(16)}${index.toString(16)}`.padStart(64, '0');

function entry({ slug, name, description, body }, seed, index) {
  return {
    manifest: {
      slug, name, description, kind: 'skill', plugin_slug: null, tags: [], source: { kind: 'local' },
      sha256: sha256Of(seed, index), status: 'approved', review_notes: 'ok', scan_flags: [],
    },
    tarball: null,
    chunks: [{ text: body, kind: 'content' }],
  };
}

export async function buildSyntheticVault(dir, { skills = 400, seed = 7, planted = [] } = {}) {
  const { DatabaseSync } = await runtimeCheck();
  const db = openVault({ dir, DatabaseSync });
  try {
    const repo = createSqliteRepo(db);
    const vocabulary = syntheticVocabulary(seed);
    const rand = mulberry32(seed + 1);
    const words = (count) => Array.from({ length: count }, () => vocabulary[zipfIndex(rand, vocabulary.length)]).join(' ');
    for (let i = 0; i < skills; i += 1) {
      const slug = `synthetic-${String(i).padStart(4, '0')}`;
      await repo.publish(entry({ slug, name: slug, description: words(DESCRIPTION_WORDS), body: words(BODY_WORDS) }, seed, i));
    }
    for (const [i, p] of planted.entries()) await repo.publish(entry(p, seed, skills + i));
  } finally {
    db.close();
  }
}
