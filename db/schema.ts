// Single source of the database schema (spec §4). drizzle-kit generates the migrations in drizzle/ from this file.
// Things Drizzle cannot express (extension, FORCE RLS, grants, functions, role) live in the custom SQL migrations
// drizzle/0001_app_foundation.sql and drizzle/0004_rls.sql, plus the hand-appended tail of drizzle/0005.
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, check, customType, foreignKey, index, integer, jsonb, pgPolicy, pgRole, pgSchema, pgTable, primaryKey, text,
  timestamp, unique, vector, type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

export * from './auth-schema.ts';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// Created (NOLOGIN) by drizzle/0001_app_foundation.sql; its password is set out of band, never in git.
export const headjackApp = pgRole('headjack_app').existing();

// app.current_owner_id() is NULL when app.owner_id is unset or '' (a pooled connection keeps '' after an earlier
// set_config), so no row passes and an insert without an owner fails the NOT NULL.
const CURRENT_OWNER = sql`app.current_owner_id()`;
const ownerIdColumn = () => bigint('owner_id', { mode: 'number' }).notNull().default(CURRENT_OWNER);
const ownerPolicy = (name: string) =>
  pgPolicy(name, { as: 'permissive', for: 'all', to: headjackApp, using: sql`owner_id = app.current_owner_id()`, withCheck: sql`owner_id = app.current_owner_id()` });

export const owners = pgTable('owners', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  refId: text('ref_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('owners_kind_ref_id_key').on(t.kind, t.refId),
  check('owners_kind_check', sql`${t.kind} in ('user','org')`),
  pgPolicy('owners_self', { as: 'permissive', for: 'select', to: headjackApp, using: sql`id = app.current_owner_id()` }),
]);

// Internal counters are accessible only through the definer functions in migration 0007.
export const app = pgSchema('app');
export const mcpSearchBudget = app.table('mcp_search_budget', {
  ownerId: bigint('owner_id', { mode: 'number' }).notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  used: integer('used').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.windowStart] }),
  foreignKey({ name: 'mcp_search_budget_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
]);

export const sources = pgTable('sources', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  kind: text('kind').notNull(),
  url: text('url'),
  defaultRef: text('default_ref').notNull().default('HEAD'),
  ownerId: ownerIdColumn(),
}, (t) => [
  check('sources_kind_check', sql`${t.kind} in ('github','git','marketplace','local')`),
  unique('sources_owner_id_kind_url_key').on(t.ownerId, t.kind, t.url).nullsNotDistinct(),
  unique('sources_id_owner_id_key').on(t.id, t.ownerId),
  foreignKey({ name: 'sources_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  ownerPolicy('sources_owner'),
]);

// skills and versions reference each other; the explicit return type breaks the circular type inference.
// The composite (x_id, owner_id) foreign keys stop a row from pointing at another owner's row: FK checks bypass RLS.
export const skills = pgTable('skills', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  kind: text('kind').notNull(),
  pluginSlug: text('plugin_slug'),
  sourceId: bigint('source_id', { mode: 'number' }),
  sourcePath: text('source_path'),
  tags: text('tags').array().notNull().default(sql`'{}'`),
  currentVersionId: bigint('current_version_id', { mode: 'number' }),
  quality: jsonb('quality'),
  tagsText: text('tags_text').notNull().default(''),
  fts: tsvector('fts').generatedAlwaysAs((): SQL => sql`setweight(to_tsvector('english', name), 'A') || setweight(to_tsvector('english', tags_text), 'B') || setweight(to_tsvector('english', description), 'C')`),
  ownerId: ownerIdColumn(),
  // The current version's Spanish enrichment queries, joined by a space; matched by the Spanish full-text branch.
  queriesEsText: text('queries_es_text').notNull().default(''),
  ftsEs: tsvector('fts_es').generatedAlwaysAs((): SQL => sql`setweight(to_tsvector('spanish', queries_es_text), 'B')`),
}, (t): PgTableExtraConfigValue[] => [
  unique('skills_owner_id_slug_key').on(t.ownerId, t.slug),
  unique('skills_id_owner_id_key').on(t.id, t.ownerId),
  check('skills_kind_check', sql`${t.kind} in ('skill','plugin')`),
  index('skills_fts_idx').using('gin', t.fts),
  index('skills_fts_es_idx').using('gin', t.ftsEs),
  foreignKey({ name: 'skills_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  foreignKey({ name: 'skills_source_owner_fkey', columns: [t.sourceId, t.ownerId], foreignColumns: [sources.id, sources.ownerId] }),
  foreignKey({ name: 'skills_current_version_owner_fkey', columns: [t.currentVersionId, t.ownerId], foreignColumns: [versions.id, versions.ownerId] }),
  ownerPolicy('skills_owner'),
]);

// Content-addressed tarballs, shared across owners. The app role reads a blob only through one of its own versions
// and writes only through app.put_blob (drizzle/0004_rls.sql), which hashes the bytes itself.
export const blobs = pgTable('blobs', {
  sha256: text('sha256').primaryKey(),
  data: bytea('data').notNull(),
  size: integer('size').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A row whose key is not the hash of its bytes cannot exist, whoever writes it.
  check('blobs_content_address_check', sql`${t.sha256} = encode(sha256(${t.data}), 'hex') and ${t.size} = length(${t.data})`),
  pgPolicy('blobs_select_visible', { as: 'permissive', for: 'select', to: headjackApp, using: sql`exists (select 1 from versions v where v.blob_sha256 = blobs.sha256)` }),
]);

export const versions = pgTable('versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  skillId: bigint('skill_id', { mode: 'number' }).notNull(),
  commitSha: text('commit_sha'),
  sha256: text('sha256').notNull(),
  size: integer('size'),
  status: text('status').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
  reviewNotes: text('review_notes'),
  scanFlags: jsonb('scan_flags').notNull().default(sql`'[]'`),
  ownerId: ownerIdColumn(),
  blobSha256: text('blob_sha256'),
}, (t): PgTableExtraConfigValue[] => [
  unique('versions_skill_id_sha256_key').on(t.skillId, t.sha256),
  unique('versions_id_owner_id_key').on(t.id, t.ownerId),
  check('versions_status_check', sql`${t.status} in ('approved','rejected')`),
  index('versions_blob_sha256_idx').on(t.blobSha256),
  foreignKey({ name: 'versions_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  foreignKey({ name: 'versions_skill_owner_fkey', columns: [t.skillId, t.ownerId], foreignColumns: [skills.id, skills.ownerId] }),
  foreignKey({ name: 'versions_blob_sha256_fkey', columns: [t.blobSha256], foreignColumns: [blobs.sha256] }),
  ownerPolicy('versions_owner'),
]);

export const chunks = pgTable('chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  skillId: bigint('skill_id', { mode: 'number' }).notNull(),
  versionId: bigint('version_id', { mode: 'number' }).notNull(),
  text: text('text').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  kind: text('kind').notNull().default('content'),
  ownerId: ownerIdColumn(),
}, (t) => [
  index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  index('chunks_owner_id_idx').on(t.ownerId),
  check('chunks_kind_check', sql`${t.kind} in ('content','query')`),
  foreignKey({ name: 'chunks_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  foreignKey({ name: 'chunks_skill_owner_fkey', columns: [t.skillId, t.ownerId], foreignColumns: [skills.id, skills.ownerId] }).onDelete('cascade'),
  foreignKey({ name: 'chunks_version_owner_fkey', columns: [t.versionId, t.ownerId], foreignColumns: [versions.id, versions.ownerId] }).onDelete('cascade'),
  ownerPolicy('chunks_owner'),
]);

export const upstream = pgTable('upstream', {
  skillId: bigint('skill_id', { mode: 'number' }).primaryKey(),
  latestCommit: text('latest_commit'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  updateAvailable: boolean('update_available').notNull().default(false),
  ownerId: ownerIdColumn(),
}, (t) => [
  index('upstream_owner_id_idx').on(t.ownerId),
  foreignKey({ name: 'upstream_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  foreignKey({ name: 'upstream_skill_owner_fkey', columns: [t.skillId, t.ownerId], foreignColumns: [skills.id, skills.ownerId] }),
  ownerPolicy('upstream_owner'),
]);

// Search exposures (spec §3.5): which variant answered a suggest search and its top slugs. The query text is never
// stored, only its HMAC. Rows are deleted after 90 days (hence the DELETE grant in drizzle/0005).
export const searchEvents = pgTable('search_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerId: ownerIdColumn(),
  sessionId: text('session_id').notNull(),
  variant: text('variant').notNull(),
  queryHmac: text('query_hmac').notNull(),
  topSlugs: text('top_slugs').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('search_events_owner_session_created_idx').on(t.ownerId, t.sessionId, t.createdAt),
  foreignKey({ name: 'search_events_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  ownerPolicy('search_events_owner'),
]);

// Installs reported by the CLI (spec §3.5); a suggest install converts a search_events row of the same session.
export const installEvents = pgTable('install_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ownerId: ownerIdColumn(),
  sessionId: text('session_id'),
  slug: text('slug').notNull(),
  kind: text('kind').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('install_events_kind_check', sql`${t.kind} in ('skill','plugin')`),
  check('install_events_source_check', sql`${t.source} in ('suggest','plan','manual')`),
  index('install_events_owner_session_created_idx').on(t.ownerId, t.sessionId, t.createdAt),
  foreignKey({ name: 'install_events_owner_id_fkey', columns: [t.ownerId], foreignColumns: [owners.id] }),
  ownerPolicy('install_events_owner'),
]);

// Invitation list for sign-up (stage 2 hook). No RLS policy and no grant to headjack_app: only the owner role reads it.
export const invites = pgTable('invites', {
  email: text('email').primaryKey(),
  invitedBy: text('invited_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});
