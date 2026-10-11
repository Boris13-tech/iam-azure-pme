-- Read-only digest of every table: "table|row count|md5 of rows". The columns added by
-- 20261011180000_organization_status_session_scope (status, statusChangedAt, scope) are removed
-- from each row, so identical output before and after the migration (or its rollback) proves that
-- no existing data changed. Rate-limit tables are skipped: they hold a secret pepper and change
-- with every anonymous request.
SELECT s.table_name || '|' || (xpath('/row/n/text()', s.x))[1]::text || '|' || (xpath('/row/d/text()', s.x))[1]::text
FROM (
  SELECT t.table_name::text AS table_name, query_to_xml(format(
    'SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(r) - %L::text[])::text, %L ORDER BY (to_jsonb(r) - %L::text[])::text), %L)) AS d FROM public.%I r',
    '{status,statusChangedAt,scope}', '|', '{status,statusChangedAt,scope}', '', t.table_name), false, true, '') AS x
  FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    AND t.table_name NOT IN ('_prisma_migrations', 'RateLimitBucket', 'RateLimitConfig')
) s
ORDER BY s.table_name;
