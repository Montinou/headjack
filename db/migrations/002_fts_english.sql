-- Full-text search with stemming and stop-word removal ('simple' had neither).
drop index if exists skills_fts_idx;
alter table skills drop column fts;
alter table skills add column fts tsvector generated always as
  (to_tsvector('english', name || ' ' || description)) stored;
create index skills_fts_idx on skills using gin (fts);
