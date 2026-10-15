// Normalized dump of a schema's structure: columns (with their position), constraints, indexes, RLS flags, policies,
// triggers and functions. `query(text) → Promise<rows>`. Output is a sorted array of strings, comparable across
// databases and PG versions (NOT NULL constraints, which Postgres 18 also lists in pg_constraint, are covered by the
// column lines). A column's position is its rank among the table's live columns, not attnum, which keeps the gaps
// that dropped columns leave (v1's 002/003 dropped and re-added skills.fts). Functions that belong to an extension
// (pgvector installs its own into public) are left out: they follow the extension's version, not our migrations.
export async function dumpSchema(query, schema = 'public', { exclude = [] } = {}) {
  const lines = [];
  const add = (rows, f) => rows.forEach((r) => lines.push(f(r)));
  add(await query(`
    select c.relname, a.attname, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid) as def, a.attgenerated,
           row_number() over (partition by a.attrelid order by a.attnum)::int as position
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where n.nspname = '${schema}' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`),
    (r) => `column ${r.relname}.${r.attname} #${r.position} ${r.type}${r.attnotnull ? ' not null' : ''}${r.def ? ` ${r.attgenerated === 's' ? 'generated' : 'default'} ${r.def}` : ''}`);
  add(await query(`
    select c.relname, k.conname, pg_get_constraintdef(k.oid) as def
      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = '${schema}' and k.contype in ('p','u','f','c')`),
    (r) => `constraint ${r.relname}.${r.conname} ${r.def}`);
  add(await query(`select tablename, indexname, indexdef from pg_indexes where schemaname = '${schema}'`),
    (r) => `index ${r.tablename}.${r.indexname} ${r.indexdef}`);
  add(await query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = '${schema}' and c.relkind = 'r'`),
    (r) => `table ${r.relname} rls=${r.relrowsecurity} force=${r.relforcerowsecurity}`);
  add(await query(`select tablename, policyname, permissive, roles::text as roles, cmd, qual, with_check from pg_policies where schemaname = '${schema}'`),
    (r) => `policy ${r.tablename}.${r.policyname} ${r.permissive} ${r.roles} ${r.cmd} using(${r.qual ?? ''}) check(${r.with_check ?? ''})`);
  add(await query(`
    select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = '${schema}' and not t.tgisinternal`),
    (r) => `trigger ${r.relname}.${r.tgname} ${r.def}`);
  add(await query(`
    select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prokind,
           case when p.prokind in ('f','p') then pg_get_functiondef(p.oid) end as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = '${schema}'
       and not exists (select 1 from pg_depend e
                        where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')`),
    (r) => `function ${r.proname}(${r.args}) kind=${r.prokind} ${(r.def ?? '').replace(/\s+/g, ' ').trim()}`);
  // Every line but a function's names its table second (`kind table.name …`); a function line carries `name(args)`
  // there, which never equals a table name, so `exclude` only drops table-bound lines.
  const table = (l) => l.split(' ')[1].split('.')[0];
  return lines.filter((l) => !exclude.includes(table(l))).sort();
}
