create extension if not exists vector;

create table sources (
  id           bigserial primary key,
  kind         text not null check (kind in ('github','git','marketplace','local')),
  url          text,
  default_ref  text not null default 'HEAD',
  unique nulls not distinct (kind, url)
);

create table skills (
  id                  bigserial primary key,
  slug                text not null unique,
  name                text not null,
  description         text not null,
  kind                text not null check (kind in ('skill','plugin')),
  plugin_slug         text,
  source_id           bigint references sources(id),
  source_path         text,
  tags                text[] not null default '{}',
  current_version_id  bigint,
  fts                 tsvector generated always as
                        (to_tsvector('simple', name || ' ' || description)) stored
);

create table versions (
  id            bigserial primary key,
  skill_id      bigint not null references skills(id),
  commit_sha    text,
  sha256        text not null,
  tarball       bytea,
  size          integer,
  status        text not null check (status in ('approved','rejected')),
  reviewed_at   timestamptz not null default now(),
  review_notes  text,
  scan_flags    jsonb not null default '[]',
  unique (skill_id, sha256)
);
alter table skills add foreign key (current_version_id) references versions(id);

create table chunks (
  id          bigserial primary key,
  skill_id    bigint not null references skills(id) on delete cascade,
  version_id  bigint not null references versions(id) on delete cascade,
  text        text not null,
  embedding   vector(1536) not null
);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index skills_fts_idx on skills using gin (fts);

create table upstream (
  skill_id          bigint primary key references skills(id),
  latest_commit     text,
  checked_at        timestamptz,
  update_available  boolean not null default false
);
