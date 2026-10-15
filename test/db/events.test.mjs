// search_events / install_events through the repo, as the app role for one owner (RLS FORCE applies): 90-day
// retention and the conversion count per variant that scripts/ab-report.mjs reads.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../../lib/db.mjs';
import { repoForOwner } from '../../lib/repo.mjs';
import { appPool, migratedPg } from '../pglite.mjs';

let db;
const owners = {};
const repoOf = (name) => repoForOwner(db.withOwner, owners[name]);

before(async () => {
  db = createDb(appPool(await migratedPg()));
  for (const name of ['retention', 'bystander', 'conversions', 'roundtrip']) owners[name] = await db.resolveOwner('user', `user-${name}`);
});

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const DAY = 24 * 60;

// Raw inserts with an explicit created_at, written as that owner (the repo methods always stamp now()).
const exposure = (name, { session, variant, slugs, at }) => db.withOwner(owners[name], (tx) => tx.query(
  'insert into search_events (session_id, variant, query_hmac, top_slugs, created_at) values ($1, $2, $3, $4::text[], $5)',
  [session, variant, 'h'.repeat(64), slugs, at],
));
const install = (name, { session, slug, source, at, kind = 'skill' }) => db.withOwner(owners[name], (tx) => tx.query(
  'insert into install_events (session_id, slug, kind, source, created_at) values ($1, $2, $3, $4, $5)',
  [session, slug, kind, source, at],
));
const count = (name, table) => db.withOwner(owners[name], (tx) => tx.query(`select count(*)::int as n from ${table}`)).then((r) => r.rows[0].n);

test('deleteEventsOlderThan(90) deletes only rows older than 90 days, in both tables, for the calling owner only', async () => {
  await exposure('retention', { session: 's', variant: 'rrf-english', slugs: ['a'], at: minutesAgo(91 * DAY) });
  await exposure('retention', { session: 's', variant: 'rrf-english', slugs: ['a'], at: minutesAgo(89 * DAY) });
  await exposure('retention', { session: 's', variant: 'rrf-english', slugs: ['a'], at: minutesAgo(1) });
  await install('retention', { session: 's', slug: 'a', source: 'suggest', at: minutesAgo(100 * DAY) });
  await install('retention', { session: null, slug: 'a', source: 'manual', at: minutesAgo(1 * DAY) });
  await exposure('bystander', { session: 's', variant: 'rrf-english', slugs: ['a'], at: minutesAgo(200 * DAY) });
  await install('bystander', { session: 's', slug: 'a', source: 'suggest', at: minutesAgo(200 * DAY) });

  assert.equal(await repoOf('retention').deleteEventsOlderThan(90), 2);
  assert.equal(await count('retention', 'search_events'), 2);
  assert.equal(await count('retention', 'install_events'), 1);
  assert.equal(await count('bystander', 'search_events'), 1, 'RLS: another owner’s old rows are not touched');
  assert.equal(await count('bystander', 'install_events'), 1);
  assert.equal(await repoOf('retention').deleteEventsOlderThan(90), 0);
});

test('conversionsByVariant counts suggest installs within 30 min after a same-session exposure listing the slug', async () => {
  const T = 120; // minutes ago of the reference point
  // Exposures: english e1, e4; bilingual e2, e3, e5.
  await exposure('conversions', { session: 's1', variant: 'rrf-english', slugs: ['a', 'b'], at: minutesAgo(T - 0) }); // e1
  await exposure('conversions', { session: 's2', variant: 'rrf-bilingual', slugs: ['a'], at: minutesAgo(T - 0) }); // e2
  await exposure('conversions', { session: 's1', variant: 'rrf-bilingual', slugs: ['c'], at: minutesAgo(T - 20) }); // e3
  await exposure('conversions', { session: 's4', variant: 'rrf-english', slugs: ['d'], at: minutesAgo(T - 30) }); // e4
  await exposure('conversions', { session: 's4', variant: 'rrf-bilingual', slugs: ['d'], at: minutesAgo(T - 35) }); // e5
  // Converts (english, via e1): 10 min after, same session, slug listed.
  await install('conversions', { session: 's1', slug: 'a', source: 'suggest', at: minutesAgo(T - 10) });
  // Ignored: a plan install, another session, no session at all.
  await install('conversions', { session: 's1', slug: 'b', source: 'plan', at: minutesAgo(T - 10) });
  await install('conversions', { session: 's3', slug: 'a', source: 'suggest', at: minutesAgo(T - 10) });
  await install('conversions', { session: null, slug: 'a', source: 'suggest', at: minutesAgo(T - 10) });
  // Ignored: 40 min after e2 (outside the window); converts with a 60-min window.
  await install('conversions', { session: 's2', slug: 'a', source: 'suggest', at: minutesAgo(T - 40) });
  // Converts (bilingual, via e2): 5 min after.
  await install('conversions', { session: 's2', slug: 'a', source: 'suggest', at: minutesAgo(T - 5) });
  // Ignored: 'c' installed 5 min before e3 lists it (and e1 does not list it).
  await install('conversions', { session: 's1', slug: 'c', source: 'suggest', at: minutesAgo(T - 15) });
  // Both e4 and e5 qualify: counted once, for the latest exposure (e5, bilingual).
  await install('conversions', { session: 's4', slug: 'd', source: 'suggest', at: minutesAgo(T - 40) });

  const repo = repoOf('conversions');
  assert.deepEqual(await repo.conversionsByVariant({}), [
    { variant: 'rrf-bilingual', exposures: 3, conversions: 2 },
    { variant: 'rrf-english', exposures: 2, conversions: 1 },
  ]);
  assert.deepEqual(await repo.conversionsByVariant(), await repo.conversionsByVariant({ windowMinutes: 30 }), 'the window defaults to 30 min');
  assert.deepEqual(await repo.conversionsByVariant({ windowMinutes: 60 }), [
    { variant: 'rrf-bilingual', exposures: 3, conversions: 3 },
    { variant: 'rrf-english', exposures: 2, conversions: 1 },
  ]);
});

test('logSearchEvent and logInstallEvent write owner-scoped rows stamped now(), checked by the table constraints', async () => {
  const repo = repoOf('roundtrip');
  await repo.logSearchEvent({ sessionId: 'sess-1', variant: 'rrf-english', queryHmac: 'f'.repeat(64), topSlugs: ['p@m:skill', 'demo'] });
  await repo.logInstallEvent({ sessionId: 'sess-1', slug: 'p@m:skill', kind: 'skill', source: 'suggest' });
  await repo.logInstallEvent({ sessionId: null, slug: 'demo', kind: 'plugin', source: 'manual' });
  const { rows: [e] } = await db.withOwner(owners.roundtrip, (tx) => tx.query('select session_id, variant, query_hmac, top_slugs, owner_id::int as owner_id from search_events'));
  assert.deepEqual(e, { session_id: 'sess-1', variant: 'rrf-english', query_hmac: 'f'.repeat(64), top_slugs: ['p@m:skill', 'demo'], owner_id: owners.roundtrip });
  const { rows } = await db.withOwner(owners.roundtrip, (tx) => tx.query('select session_id, slug, kind, source from install_events order by id'));
  assert.deepEqual(rows, [
    { session_id: 'sess-1', slug: 'p@m:skill', kind: 'skill', source: 'suggest' },
    { session_id: null, slug: 'demo', kind: 'plugin', source: 'manual' },
  ]);
  assert.deepEqual(await repo.conversionsByVariant(), [{ variant: 'rrf-english', exposures: 1, conversions: 1 }]);
  await assert.rejects(repo.logInstallEvent({ sessionId: null, slug: 'demo', kind: 'skill', source: 'auto' }), /install_events_source_check/);
});
