import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema.ts';

const tables = Object.values(schema).filter((t) => t instanceof PgTable).map((t) => getTableConfig(t));
const pub = (name) => tables.find((t) => t.name === name && !t.schema);

test('the schema holds the app tables in public and re-exports the Better Auth tables in auth', () => {
  assert.deepEqual(tables.filter((c) => !c.schema).map((c) => c.name).sort(), ['blobs', 'chunks', 'install_events', 'invites', 'owners', 'search_events', 'skills', 'sources', 'upstream', 'versions']);
  assert.equal(tables.filter((c) => c.schema === 'auth').length, 17);
});

test('every owner-scoped table has owner_id and one policy for headjack_app; invites has neither', () => {
  for (const name of ['skills', 'versions', 'sources', 'chunks', 'upstream']) {
    const c = pub(name);
    assert.ok(c.columns.find((col) => col.name === 'owner_id')?.notNull, `${name}.owner_id not null`);
    assert.equal(c.policies.length, 1, name);
    assert.equal(c.policies[0].to.name, 'headjack_app', name);
  }
  assert.deepEqual(pub('owners').policies.map((p) => p.for), ['select']);
  assert.deepEqual(pub('blobs').policies.map((p) => p.for), ['select']);
  assert.equal(pub('invites').policies.length, 0);
  assert.ok(!pub('invites').columns.some((c) => c.name === 'owner_id'));
});

test('v1 parity pieces survive in the final schema', () => {
  assert.ok(pub('skills').columns.find((c) => c.name === 'fts').generated);
  assert.ok(pub('skills').uniqueConstraints.some((u) => u.name === 'skills_owner_id_slug_key'));
  assert.equal(pub('chunks').columns.find((c) => c.name === 'embedding').getSQLType(), 'vector(1536)');
  assert.ok(pub('sources').uniqueConstraints.find((u) => u.name === 'sources_owner_id_kind_url_key').nullsNotDistinct);
  assert.ok(!pub('versions').columns.some((c) => c.name === 'tarball'));
  assert.ok(pub('versions').columns.some((c) => c.name === 'blob_sha256'));
});

test('MCP budget is represented in app schema with required columns, composite key and public owner FK', () => {
  const c = tables.find((t) => t.schema === 'app' && t.name === 'mcp_search_budget');
  assert.ok(c, 'app budget is part of the generated schema');
  assert.deepEqual(c.columns.map((col) => [col.name, col.getSQLType(), col.notNull]), [
    ['owner_id', 'bigint', true], ['window_start', 'timestamp with time zone', true], ['used', 'integer', true],
  ]);
  assert.deepEqual(c.primaryKeys.map((key) => key.columns.map((col) => col.name)), [['owner_id', 'window_start']]);
  const [fk] = c.foreignKeys.map((key) => key.reference());
  assert.deepEqual(fk.columns.map((col) => col.name), ['owner_id']);
  assert.equal(fk.foreignTable, schema.owners);
  assert.deepEqual(fk.foreignColumns.map((col) => col.name), ['id']);
});
