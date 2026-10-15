// Content fingerprint of the vault: row counts plus digests of every version's folder hash and tarball bytes. Equal
// before and after drizzle/0002-0004 means the move to owners + blobs lost nothing (spec §1, success criterion 4).
// Works on both shapes: v1 (versions.tarball) and multi-user (versions.blob_sha256 → blobs.data).
export async function fingerprint(query) {
  const [{ has_tarball: hasTarball }] = await query(
    `select exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'versions' and column_name = 'tarball') as has_tarball`,
  );
  const bytes = hasTarball
    ? 'select v.id, v.sha256, v.tarball as data from versions v'
    : 'select v.id, v.sha256, b.data from versions v left join blobs b on b.sha256 = v.blob_sha256';
  const [row] = await query(`
    select (select count(*) from skills)::int as skills, (select count(*) from versions)::int as versions,
           (select count(*) from chunks)::int as chunks, (select count(*) from sources)::int as sources,
           (select count(*) from upstream)::int as upstream,
           (select count(*) from (${bytes}) t where t.data is not null)::int as tarballs,
           (select md5(coalesce(string_agg(t.id || ':' || t.sha256 || ':' || coalesce(encode(sha256(t.data), 'hex'), '-'), ',' order by t.id), ''))
              from (${bytes}) t) as versions_digest,
           (select md5(coalesce(string_agg(s.id || ':' || s.slug || ':' || coalesce(s.current_version_id::text, '-'), ',' order by s.id), ''))
              from skills s) as skills_digest,
           (select md5(coalesce(string_agg(c.id || ':' || c.version_id || ':' || md5(c.text), ',' order by c.id), ''))
              from chunks c) as chunks_digest`);
  return row;
}
