-- Search enrichment: synthetic query chunks, audit quality scores, and a weighted full-text column with tags.
-- The runner applies this file once, inside one transaction; the guards keep a manual re-run harmless.
alter table chunks add column if not exists kind text not null default 'content'
  check (kind in ('content','query'));

alter table skills add column if not exists quality jsonb;

-- Space-joined skills.tags, maintained by the app: array_to_string is not immutable, so it cannot feed a
-- generated column directly.
alter table skills add column if not exists tags_text text not null default '';
update skills set tags_text = array_to_string(tags, ' ') where tags_text is distinct from array_to_string(tags, ' ');

-- Weighted full-text: name (A) > tags (B) > description (C). Same drop/recreate as 002.
drop index if exists skills_fts_idx;
alter table skills drop column if exists fts;
alter table skills add column fts tsvector generated always as (
  setweight(to_tsvector('english', name), 'A') ||
  setweight(to_tsvector('english', tags_text), 'B') ||
  setweight(to_tsvector('english', description), 'C')
) stored;
create index skills_fts_idx on skills using gin (fts);
