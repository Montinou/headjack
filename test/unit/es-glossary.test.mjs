import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY, glossaryTerms } from '../../lib/es-glossary.mjs';

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

test('the glossary is a fixed map of about 150 accent-free, lowercase keys to English words', () => {
  const keys = Object.keys(GLOSSARY);
  assert.ok(keys.length >= 120 && keys.length <= 220, `size ${keys.length}`);
  for (const [k, v] of Object.entries(GLOSSARY)) {
    assert.equal(k, fold(k), `key ${k} is accent-free lowercase`);
    assert.match(v, /^[a-z]+( [a-z]+)*$/, `value of ${k}`);
  }
});

test('glossaryTerms translates single words and multi-word keys on the joined query', () => {
  const out = glossaryTerms(['desplegar', 'pruebas', 'base', 'de', 'datos']);
  for (const want of ['deploy', 'test', 'database']) assert.ok(out.includes(want), `${want} in ${out}`);
});

test('lookup is accent- and case-insensitive', () => {
  assert.ok(glossaryTerms(['Autenticación']).includes('authentication'));
  assert.ok(glossaryTerms(['autenticacion']).includes('authentication'));
  assert.ok(glossaryTerms(['MIGRACIÓN']).includes('migration'));
  assert.ok(glossaryTerms(['Despliegue']).includes('deploy'));
});

test('a multi-word key matches only as adjacent whole words', () => {
  assert.ok(glossaryTerms(['una', 'base', 'de', 'datos', 'nueva']).includes('database'));
  assert.ok(!glossaryTerms(['base', 'nueva', 'de', 'datos']).includes('database'));
  assert.ok(!glossaryTerms(['abase', 'de', 'datos']).includes('database'));
});

test('unknown words add nothing, the result has no duplicates and an empty query gives an empty list', () => {
  assert.deepEqual(glossaryTerms(['kubernetes', 'helm']), []);
  assert.deepEqual(glossaryTerms([]), []);
  const out = glossaryTerms(['desplegar', 'despliegue', 'desplegar']);
  assert.deepEqual(out, [...new Set(out)]);
});
