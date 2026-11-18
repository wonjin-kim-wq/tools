-- 참코딩 DB 구조 비교용(읽기 전용). 기존 프로젝트와 새 프로젝트에서 같은 결과가 나와야 한다.
select json_build_object(
  'columns', (select json_agg(x order by x) from (
    select format('%s.%s %s%s%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod),
      case when a.attnotnull then ' not null' else '' end,
      coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')) x
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'tools\_%' and a.attnum > 0 and not a.attisdropped) s),
  'constraints', (select json_agg(x order by x) from (
    select format('%s %s', c.relname, pg_get_constraintdef(k.oid)) x
    from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'tools\_%') s),
  'indexes', (select json_agg(indexdef order by indexdef) from pg_indexes where schemaname = 'public' and tablename like 'tools\_%'),
  'rls', (select json_agg(format('%s rls=%s', relname, relrowsecurity) order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'tools\_%'),
  'policies', (select json_agg(format('%s.%s %s %s %s using(%s) check(%s)', schemaname, tablename, policyname, cmd, roles, qual, with_check) order by tablename, policyname)
    from pg_policies where tablename like 'tools\_%' or (schemaname = 'storage' and (qual like '%chamcoding%' or with_check like '%chamcoding%'))),
  'functions', (select json_agg(format('%s(%s) %s', p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid))) order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'tools\_%'),
  'triggers', (select json_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname like 'tools\_%'),
  'table_grants', (select json_agg(format('%s %s %s', table_name, grantee, privilege_type) order by table_name, grantee, privilege_type)
    from information_schema.role_table_grants where table_schema = 'public' and table_name like 'tools\_%' and grantee in ('anon', 'authenticated')),
  'function_grants', (select json_agg(format('%s %s', routine_name, grantee) order by routine_name, grantee)
    from information_schema.role_routine_grants where routine_schema = 'public' and routine_name like 'tools\_%' and grantee in ('anon', 'authenticated', 'public'))
) as structure;
