// The local vault: one SQLite file, one implicit owner. Schema changes are numbered statements applied in order inside
// one transaction; PRAGMA user_version holds how many have been applied. Append only: never edit or reorder an entry.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { UserError } from '../errors.mjs';

// skill_docs' tokenizer; local search signals tokenize query terms with the same one.
export const FTS_TOKENIZE = 'porter unicode61 remove_diacritics 2';
export const FTS_TOKENIZE_ES = 'unicode61 remove_diacritics 2';

export const MIGRATIONS = [
  `create table sources (
     id integer primary key,
     kind text not null check (kind in ('github','git','marketplace','local')),
     url text,
     default_ref text not null default 'HEAD'
   )`,
  // SQLite treats NULLs as distinct in a unique constraint; the expression makes (kind, no url) unique too.
  'create unique index sources_kind_url_key on sources (kind, coalesce(url, \'\'))',
  // tags and quality are JSON text; current_version_id points at an approved version.
  `create table skills (
     id integer primary key,
     slug text not null unique,
     name text not null,
     description text not null,
     kind text not null check (kind in ('skill','plugin')),
     plugin_slug text,
     source_id integer references sources(id),
     source_path text,
     tags text not null default '[]',
     quality text,
     current_version_id integer references versions(id)
   )`,
  // reviewed_at is an ISO-8601 UTC string ending in Z, so text order is time order.
  `create table versions (
     id integer primary key,
     skill_id integer not null references skills(id),
     commit_sha text,
     sha256 text not null,
     size integer,
     status text not null check (status in ('approved','rejected')),
     reviewed_at text not null,
     review_notes text,
     scan_flags text not null default '[]',
     tarball blob,
     unique (skill_id, sha256)
   )`,
  `create table upstream (
     skill_id integer primary key references skills(id),
     latest_commit text,
     checked_at text,
     update_available integer not null default 0
   )`,
  // rowid is the skill id; body is the content chunk texts of the current approved version.
  `create virtual table skill_docs using fts5(name, description, tags, body, tokenize='${FTS_TOKENIZE}')`,
  // Spanish example requests of the current version (set by `headjack enrich` and `headjack pull`, spec §6.3);
  // enrichment_v is the prompt version that wrote them, null when there are none.
  "alter table skills add column queries_es_text text not null default ''",
  'alter table skills add column enrichment_v integer',
  // rowid is the skill id, like skill_docs. Spanish: no stemming, case and diacritics folded.
  `create virtual table skill_docs_es using fts5(queries, tokenize='${FTS_TOKENIZE_ES}')`,
  // What each `headjack pull` stored: the content hash of the hosted version it copied, and when (ISO-8601 UTC).
  'create table pulls (slug text primary key, sha256 text not null, pulled_at text not null)',
];

const VAULT_FILE = 'vault.db';
export const vaultFile = (dir) => path.join(dir, VAULT_FILE);
const SQLITE_BUSY = 5;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

const one = (db, sql) => ({ ...db.prepare(sql).get() });

// A lock held by another connection or process (node:sqlite reports the primary result code in the low byte).
export function isBusy(e) {
  return e?.code === 'ERR_SQLITE_ERROR' && (e.errcode & 0xff) === SQLITE_BUSY;
}

// Pages that are not a database any more (SQLITE_CORRUPT, SQLITE_NOTADB), found by a query after the file opened.
export function isDamaged(e) {
  return e?.code === 'ERR_SQLITE_ERROR' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(e.errcode & 0xff);
}

// The one line every command shows for a damaged vault, wherever the damage is found.
export const damagedMessage = (dir) => `vault ${vaultFile(dir)} is damaged; run headjack verify`;

export function openVault({ dir, DatabaseSync }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = vaultFile(dir);
  const db = new DatabaseSync(file);
  try {
    // First, so the header read below waits for a process that is converting the file to WAL.
    db.exec('PRAGMA busy_timeout = 5000');
    // Read the header before anything can write: a file that is not a database is reported and left as it is.
    try {
      db.prepare('select count(*) from sqlite_master').get();
    } catch (e) {
      if (isBusy(e)) throw e;
      // Pages that are not a database are damage: the code lets the MCP server report vault_damaged, not a generic failure.
      const invalid = new UserError(`${file} is not a valid vault: ${e.message}`);
      throw isDamaged(e) ? Object.assign(invalid, { code: 'vault_damaged' }) : invalid;
    }
    // Before WAL is on, so the -wal and -shm files SQLite creates inherit mode 600.
    chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = one(db, 'PRAGMA user_version').user_version;
      if (applied > MIGRATIONS.length) throw new UserError('vault was written by a newer headjack');
      for (const statement of MIGRATIONS.slice(applied)) db.exec(statement);
      if (applied < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      db.exec('COMMIT');
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

// For the suggestion hook, which runs on every prompt: never creates the directory or file, never migrates, and gives up
// on a lock after busyTimeoutMs instead of the 5 s openVault waits. A busy error on open or on the first read is 'busy';
// pages that are not a database (isDamaged) are 'damaged'; any other failure, or a schema that is not exactly this
// headjack's, is 'schema'.
export function openVaultReadOnly({ dir, DatabaseSync, busyTimeoutMs = 200 }) {
  const file = vaultFile(dir);
  if (!existsSync(file)) return { ok: false, reason: 'no-vault' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: busyTimeoutMs });
    if (one(db, 'PRAGMA user_version').user_version !== MIGRATIONS.length) {
      db.close();
      return { ok: false, reason: 'schema' };
    }
    return { ok: true, db };
  } catch (e) {
    try {
      db?.close();
    } catch {
      // already closed or never opened
    }
    return { ok: false, reason: isBusy(e) ? 'busy' : isDamaged(e) ? 'damaged' : 'schema' };
  }
}

export function vaultInfo(db) {
  return {
    schemaVersion: one(db, 'PRAGMA user_version').user_version,
    skills: one(db, 'select count(*) as n from skills').n,
  };
}
