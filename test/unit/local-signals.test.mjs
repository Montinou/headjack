import assert from 'node:assert/strict';
import { localTest } from '../local-helpers.mjs';
import { tempDir } from '../helpers.mjs';
import { runtimeCheck } from '../../lib/local/runtime.mjs';
import { openVault, openVaultReadOnly } from '../../lib/local/schema.mjs';
import { createSqliteRepo, fuseSignals, searchTerms } from '../../lib/local/sqlite-repo.mjs';
import { contentTerms } from '../../lib/stopwords.mjs';

let sha = 0;
function skill(slug, description, body, extra = {}) {
  sha += 1;
  return {
    manifest: {
      slug, name: extra.name ?? slug, description, kind: 'skill', plugin_slug: extra.plugin_slug ?? null, tags: [],
      source: { kind: 'local' }, sha256: String(sha).padStart(64, '0'), status: extra.status ?? 'approved',
      review_notes: extra.review_notes ?? 'ok', scan_flags: [],
    },
    tarball: null,
    chunks: [{ text: body, kind: 'content' }],
  };
}

// A fixture vault: published in this order, so equal bm25 scores keep this order.
async function fixture() {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-signals-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  const rows = [
    skill('deploy-cron', 'Schedule deploy cron jobs', 'Runs a deploy on a cron schedule.'),
    skill('deploy-notes', 'Write deploy notes', 'Summarize what shipped.', { review_notes: 'grandfathered: imported' }),
    skill('gardening', 'Grow tomatoes', 'Water daily.'),
    skill('alphabet', 'Phonetic words', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november'),
    skill('p@m1:s', 'Zebra herding guide', 'Herding zebras across plains.', { name: 's', plugin_slug: 'p@m1' }),
    skill('p@m2:s', 'Zebra herding guide', 'Herding zebras across plains.', { name: 's', plugin_slug: 'p@m2' }),
    skill('zebra-facts', 'Zebra trivia', 'Stripes.'),
    skill('rejected-deploy', 'Deploy cron vercel everything', 'deploy deploy cron vercel', { status: 'rejected' }),
  ];
  for (const r of rows) await repo.publish(r);
  return { db, repo, dir, DatabaseSync };
}

localTest('searchTerms splits like searchText: letters, digits and marks, at least 2 chars, at most 24, quoted', () => {
  assert.deepEqual(searchTerms('Deploy, a vercel-cron! ñandú x2 é'), ['Deploy', 'vercel', 'cron', 'ñandú', 'x2']);
  assert.equal(searchTerms(Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ')).length, 24);
  assert.deepEqual(searchTerms('a ! ?'), []);
});

localTest('searchSignals finds the same skills searchText finds for the same query', async () => {
  const { db, repo } = await fixture();
  try {
    for (const q of ['deploy vercel cron', 'zebra, herding!', 'Grow-tomatoes x']) {
      // Id 6 is p@m2:s, collapsed into p@m1:s as an alternative.
      const text = await repo.searchText(q, 50);
      const signals = await repo.searchSignals(q, { limit: 50 });
      assert.deepEqual(signals.map((r) => r.id).sort(), text.filter((id) => id !== 6).sort(), q);
    }
    assert.deepEqual(await repo.searchSignals('a ! ?', {}), []);
  } finally {
    db.close();
  }
});

localTest('the rank-1 row carries the bm25 gap to rank 2 and its matched terms; lower rows carry null', async () => {
  const { db, repo } = await fixture();
  try {
    const rows = await repo.searchSignals('deploy vercel cron', {});
    assert.deepEqual(rows.map((r) => r.slug), ['deploy-cron', 'deploy-notes']);
    const [first, second] = rows;
    assert.deepEqual(rows.map((r) => [r.fts_table, r.table_rank]), [['en', 1], ['en', 2]]);
    assert.ok(first.bm25 < 0 && second.bm25 < 0);
    assert.equal(first.bm25_gap, second.bm25 - first.bm25);
    assert.ok(first.bm25_gap > 0);
    assert.equal(first.matched_terms, 2);
    assert.equal(second.bm25_gap, null);
    assert.equal(second.matched_terms, null);
    assert.deepEqual(Object.keys(first).sort(), [
      'bm25', 'bm25_gap', 'description', 'fts_table', 'id', 'kind', 'matched_terms', 'name', 'plugin_slug', 'review',
      'slug', 'table_rank', 'tags',
    ]);
    assert.equal(first.description, 'Schedule deploy cron jobs');
    assert.deepEqual(first.tags, []);
  } finally {
    db.close();
  }
});

localTest('a table with a single hit gives a null gap', async () => {
  const { db, repo } = await fixture();
  try {
    const rows = await repo.searchSignals('tomatoes', {});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, 'gardening');
    assert.equal(rows[0].table_rank, 1);
    assert.equal(rows[0].bm25_gap, null);
    assert.equal(rows[0].matched_terms, 1);
  } finally {
    db.close();
  }
});

localTest('duplicate installs collapse before the gap, so the gap is to the next distinct skill', async () => {
  const { db, repo } = await fixture();
  try {
    const rows = await repo.searchSignals('zebra herding', {});
    assert.deepEqual(rows.map((r) => r.slug), ['p@m1:s', 'zebra-facts']);
    assert.deepEqual(rows[0].alternatives, ['p@m2:s']);
    assert.equal(rows[1].alternatives, undefined);
    assert.equal(rows[1].table_rank, 2);
    assert.ok(rows[0].bm25_gap > 0);
    assert.equal(rows[0].bm25_gap, rows[1].bm25 - rows[0].bm25);
  } finally {
    db.close();
  }
});

localTest('rows without a current approved version never appear; review comes from the version notes', async () => {
  const { db, repo } = await fixture();
  try {
    const rows = await repo.searchSignals('deploy vercel cron everything', { limit: 50 });
    assert.ok(!rows.some((r) => r.slug === 'rejected-deploy'));
    assert.equal(rows.find((r) => r.slug === 'deploy-cron').review, 'approved');
    assert.equal(rows.find((r) => r.slug === 'deploy-notes').review, 'unreviewed');
    assert.deepEqual(await repo.searchSignals('everything', {}), []);
  } finally {
    db.close();
  }
});

localTest('limit truncates after the gaps are computed', async () => {
  const { db, repo } = await fixture();
  try {
    const five = await repo.searchSignals('deploy vercel cron', { limit: 5 });
    const one = await repo.searchSignals('deploy vercel cron', { limit: 1 });
    const byDefault = await repo.searchSignals('deploy vercel cron');
    assert.equal(one.length, 1);
    assert.equal(one[0].slug, five[0].slug);
    assert.ok(one[0].bm25_gap > 0);
    assert.equal(one[0].bm25_gap, five[0].bm25_gap);
    assert.deepEqual(byDefault, five);
  } finally {
    db.close();
  }
});

localTest('tables: unknown names throw; the not-yet-built es and en-gloss tables add nothing', async () => {
  const { db, repo } = await fixture();
  try {
    await assert.rejects(repo.searchSignals('deploy', { tables: ['fr'] }), /unknown search table: fr/);
    const en = await repo.searchSignals('deploy', {});
    assert.deepEqual(await repo.searchSignals('deploy', { tables: ['en', 'es', 'en-gloss'], glossaryTerms: ['ship'] }), en);
    assert.deepEqual(await repo.searchSignals('deploy', { tables: ['es'] }), []);
  } finally {
    db.close();
  }
});

localTest('matched_terms counts distinct tokens: inflections and diacritic variants of one word count once', async () => {
  const { db, repo } = await fixture();
  try {
    const [tomato] = await repo.searchSignals('tomato tomatoes Tomatoes', {});
    assert.equal(tomato.slug, 'gardening');
    assert.equal(tomato.matched_terms, 1);
    const [grow] = await repo.searchSignals('growing grow tomatoes', {});
    assert.equal(grow.matched_terms, 2);
    const [zebra] = await repo.searchSignals('zébra zebras herding', {});
    assert.equal(zebra.slug, 'p@m1:s');
    assert.equal(zebra.matched_terms, 2);
  } finally {
    db.close();
  }
});

localTest('matched_terms probes at most the first 12 distinct tokens', async () => {
  const { db, repo } = await fixture();
  try {
    const query = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november';
    const [top] = await repo.searchSignals(query, {});
    assert.equal(top.slug, 'alphabet');
    assert.equal(top.matched_terms, 12);
  } finally {
    db.close();
  }
});

localTest('fuseSignals keeps the best table_rank per skill and breaks ties en, es, en-gloss whatever the input order', () => {
  const row = (id, fts_table, table_rank, bm25) => ({ id, fts_table, table_rank, bm25 });
  const gloss = [row(1, 'en-gloss', 1, -9), row(2, 'en-gloss', 2, -8)];
  const es = [row(1, 'es', 1, -5), row(2, 'es', 2, -4), row(3, 'es', 3, -3)];
  const en = [row(1, 'en', 1, -2)];
  for (const lists of [[gloss, es, en], [es, en, gloss], [en, es, gloss]]) {
    const fused = fuseSignals(lists);
    assert.deepEqual(fused.map((r) => [r.id, r.fts_table, r.table_rank]), [[1, 'en', 1], [2, 'es', 2], [3, 'es', 3]]);
  }
  // Across skills, equal ranks order by table before bm25.
  assert.deepEqual(fuseSignals([[row(6, 'es', 1, -3)], [row(5, 'en', 1, -1)]]).map((r) => r.id), [5, 6]);
});

localTest('fuseSignals breaks rank ties by the order it is given, the default being en, es, en-gloss', () => {
  const row = (id, fts_table, table_rank, bm25) => ({ id, fts_table, table_rank, bm25 });
  const lists = [[row(5, 'en', 1, -1)], [row(6, 'es', 1, -3)]];
  assert.deepEqual(fuseSignals(lists).map((r) => r.id), [5, 6]);
  assert.deepEqual(fuseSignals(lists, ['es', 'en', 'en-gloss']).map((r) => r.id), [6, 5]);
  // The same skill in two tables at the same rank keeps the row of the preferred table.
  const both = [[row(7, 'en', 1, -1)], [row(7, 'es', 1, -3)]];
  assert.deepEqual(fuseSignals(both, ['es', 'en', 'en-gloss']).map((r) => r.fts_table), ['es']);
});

localTest('contentTerms drops English and Spanish function words and chat filler, folding case and accents', () => {
  assert.deepEqual(contentTerms(['Can', 'you', 'make', 'the', 'deploy', 'cron', 'work']), ['deploy', 'cron', 'work']);
  assert.deepEqual(contentTerms(['Armá', 'el', 'video', 'de', 'remotion', 'con', 'subtítulos', 'está']), ['Armá', 'video', 'remotion', 'subtítulos']);
  assert.deepEqual(contentTerms(['si', 'me', 'parece', 'bien']), ['parece']);
  assert.deepEqual(contentTerms([]), []);
});

localTest('searchSignals never searches stop words: they neither match nor count as matched terms', async () => {
  const { db, repo } = await fixture();
  try {
    await repo.publish(skill('spanish-guide', 'Una guía de la app', 'el la de con para que una los las del'));
    assert.deepEqual(await repo.searchSignals('el de la con para que', {}), []);
    assert.deepEqual(await repo.searchSignals('can you do the thing for me', {}), []);
    const rows = await repo.searchSignals('can you make the deploy cron for me', {});
    assert.equal(rows[0].slug, 'deploy-cron');
    assert.equal(rows[0].matched_terms, 2);
  } finally {
    db.close();
  }
});

localTest('matched_terms works on the read-only connection the suggestion hook opens, call after call', async () => {
  const { db, dir, DatabaseSync } = await fixture();
  db.close();
  const opened = openVaultReadOnly({ dir, DatabaseSync });
  assert.equal(opened.ok, true);
  try {
    const repo = createSqliteRepo(opened.db);
    assert.equal((await repo.searchSignals('deploy vercel cron', {}))[0].matched_terms, 2);
    assert.equal((await repo.searchSignals('tomato tomatoes', {}))[0].matched_terms, 1);
  } finally {
    opened.db.close();
  }
});

// ---- Spanish tables (es, en-gloss) ----

// Publishes the given skills and gives each its Spanish example requests (null: none) and enrichment version.
async function spanishFixture(rows) {
  const { DatabaseSync } = await runtimeCheck();
  const dir = await tempDir('sv-signals-es-');
  const db = openVault({ dir, DatabaseSync });
  const repo = createSqliteRepo(db);
  for (const [slug, description, es, v] of rows) {
    const { skillId, versionId } = await repo.publish(skill(slug, description, `${slug} body`));
    if (es !== null) await repo.setSpanish(skillId, versionId, es, v);
  }
  return { db, repo };
}

localTest('es: a skill whose Spanish example request matches ranks 1 in the es table', async () => {
  const { db, repo } = await spanishFixture([
    ['ship-it', 'Ship things', 'desplegar una app en vercel', 1],
    ['gardening', 'Grow tomatoes', 'regar las plantas', 1],
  ]);
  try {
    const rows = await repo.searchSignals('desplegar mi app', { tables: ['en', 'es'] });
    assert.deepEqual(rows.map((r) => [r.slug, r.fts_table, r.table_rank]), [['ship-it', 'es', 1]]);
    assert.equal(rows[0].matched_terms, 2);
    assert.ok(rows[0].bm25 < 0);
    // Accents and case fold in Spanish; the English table never sees these words.
    assert.deepEqual((await repo.searchSignals('DESPLEGÁR', { tables: ['es'] })).map((r) => r.slug), ['ship-it']);
    assert.deepEqual(await repo.searchSignals('desplegar mi app', { tables: ['en'] }), []);
  } finally {
    db.close();
  }
});

localTest('es: the query drops SPANISH_FILLER words, so filler alone never matches', async () => {
  const { db, repo } = await spanishFixture([
    ['ship-it', 'Ship things', 'desplegar una app', 1],
    ['soup', 'Cook soup', 'quiero hacer sopa', 1],
  ]);
  try {
    const rows = await repo.searchSignals('quiero hacer desplegar', { tables: ['es'] });
    assert.deepEqual(rows.map((r) => r.slug), ['ship-it']);
    assert.deepEqual(await repo.searchSignals('quiero hacer', { tables: ['es'] }), []);
  } finally {
    db.close();
  }
});

localTest('es: no stemming, and the table is queried only when asked for', async () => {
  const { db, repo } = await spanishFixture([['ship-it', 'Ship things', 'desplegar una app', 1]]);
  try {
    assert.deepEqual(await repo.searchSignals('despliegue', { tables: ['es'] }), []);
    assert.deepEqual(await repo.searchSignals('desplegar'), []);
  } finally {
    db.close();
  }
});

localTest('en-gloss: only rows with a null enrichment_v, matched on the glossary English terms', async () => {
  const { db, repo } = await spanishFixture([
    ['deploy-enriched', 'Deploy an app to vercel', 'desplegar una app', 1],
    ['deploy-plain', 'Deploy apps', null, null],
  ]);
  try {
    const opts = { glossaryTerms: ['deploy'] };
    const gloss = await repo.searchSignals('desplegar app', { ...opts, tables: ['en-gloss'] });
    assert.deepEqual(gloss.map((r) => [r.slug, r.fts_table, r.table_rank]), [['deploy-plain', 'en-gloss', 1]]);
    // The control: the same English terms do reach the enriched row through the en table.
    const en = await repo.searchSignals('deploy', { tables: ['en'] });
    assert.deepEqual(en.map((r) => r.slug).sort(), ['deploy-enriched', 'deploy-plain']);
    // No glossary terms, or the table not asked for: nothing.
    assert.deepEqual(await repo.searchSignals('desplegar app', { tables: ['en-gloss'] }), []);
    assert.deepEqual(await repo.searchSignals('qqq zzz', { ...opts, tables: ['en', 'es'] }), []);
  } finally {
    db.close();
  }
});

localTest('en-gloss terms are quoted like every other term, so no FTS5 syntax gets through', async () => {
  const { db, repo } = await spanishFixture([['deploy-plain', 'Deploy apps', null, null]]);
  try {
    const rows = await repo.searchSignals('x', { tables: ['en-gloss'], glossaryTerms: ['deploy" OR "apps', 'NEAR(deploy apps)'] });
    // The operators are split into plain words, so the row matches on its words and nothing else.
    assert.deepEqual(rows.map((r) => r.slug), ['deploy-plain']);
  } finally {
    db.close();
  }
});

localTest('ranks, gaps and matched terms are per table: each row keeps the numbers of the table it won in', async () => {
  const { db, repo } = await spanishFixture([
    ['zebra-strong', 'zebra zebra zebra stripes', null, null],
    ['zebra-weak', 'zebra', null, null],
    ['cebra-strong', 'Animals', 'cebra cebra cebra rayas', 1],
    ['cebra-weak', 'Pets', 'cebra', 1],
  ]);
  try {
    const query = 'zebra cebra';
    const both = await repo.searchSignals(query, { tables: ['en', 'es'], limit: 10 });
    assert.deepEqual(both.map((r) => [r.slug, r.fts_table, r.table_rank]), [
      ['zebra-strong', 'en', 1], ['cebra-strong', 'es', 1], ['zebra-weak', 'en', 2], ['cebra-weak', 'es', 2],
    ]);
    const bySlug = Object.fromEntries(both.map((r) => [r.slug, r]));
    assert.ok(bySlug['zebra-strong'].bm25_gap > 0 && bySlug['cebra-strong'].bm25_gap > 0);
    assert.equal(bySlug['zebra-strong'].bm25_gap, bySlug['zebra-weak'].bm25 - bySlug['zebra-strong'].bm25);
    assert.equal(bySlug['cebra-strong'].bm25_gap, bySlug['cebra-weak'].bm25 - bySlug['cebra-strong'].bm25);
    assert.equal(bySlug['zebra-weak'].bm25_gap, null);
    assert.equal(bySlug['cebra-weak'].bm25_gap, null);
    // Rank-1 rows count the query tokens their own table matches.
    assert.equal(bySlug['zebra-strong'].matched_terms, 1);
    assert.equal(bySlug['cebra-strong'].matched_terms, 1);
    // The same numbers as querying each table alone.
    const en = await repo.searchSignals(query, { tables: ['en'], limit: 10 });
    const es = await repo.searchSignals(query, { tables: ['es'], limit: 10 });
    assert.equal(en[0].bm25_gap, bySlug['zebra-strong'].bm25_gap);
    assert.equal(es[0].bm25_gap, bySlug['cebra-strong'].bm25_gap);
  } finally {
    db.close();
  }
});

localTest('an unknown table is still rejected', async () => {
  const { db, repo } = await spanishFixture([]);
  try {
    await assert.rejects(() => repo.searchSignals('x', { tables: ['fr'] }), /unknown search table: fr/);
  } finally {
    db.close();
  }
});
