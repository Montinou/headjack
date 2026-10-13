import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankSkills } from '../../lib/search.mjs';

const row = (id, slug) => ({ id, slug, name: slug, description: slug, kind: 'skill', plugin_slug: null, tags: [], quality: null, update_available: false });

function repoWith(calls) {
  return {
    searchVector: async () => { calls.push('vector'); return [{ id: 2, sim: 0.9 }]; },
    searchText: async () => { calls.push('text'); return [1, 2]; },
    getSkillsByIds: async (ids) => ids.map((id) => row(id, `s${id}`)),
  };
}

test('rankSkills without an embedder returns the text results and never calls searchVector', async () => {
  const calls = [];
  const out = await rankSkills({ repo: repoWith(calls), embed: undefined, query: 'q', tags: [], k: 8, variant: 'rrf-english' });
  assert.deepEqual(calls, ['text']);
  assert.deepEqual(out.map((r) => r.slug), ['s1', 's2']);
  assert.ok(out.every((r) => r.matched === 'fts' && r.vector_rank === null && r.similarity === null));
});

test('rankSkills with an embedder that throws still rejects with the query embedding error', async () => {
  const calls = [];
  await assert.rejects(
    rankSkills({ repo: repoWith(calls), embed: async () => { throw new Error('gateway down'); }, query: 'q', tags: [], k: 8, variant: 'rrf-english' }),
    /query embedding failed: gateway down/,
  );
  assert.deepEqual(calls, []);
});

test('rankSkills with an embedder fuses the vector and text rankings', async () => {
  const calls = [];
  const out = await rankSkills({ repo: repoWith(calls), embed: async () => [[0.1]], query: 'q', tags: [], k: 8, variant: 'rrf-english' });
  assert.deepEqual(calls.sort(), ['text', 'vector']);
  assert.equal(out.find((r) => r.slug === 's2').matched, 'both');
});
