-- Read-only digest of every pre-existing table: "table|row count|md5 of rows". Organization is
-- hashed without its new "slug" column. Run before and after the Customer Self-Onboarding v1
-- migration: identical output proves that no existing business data changed.
SELECT s.table_name || '|' || (xpath('/row/n/text()', s.x))[1]::text || '|' || (xpath('/row/d/text()', s.x))[1]::text
FROM (
  SELECT t.table_name::text AS table_name, query_to_xml(format(
    'SELECT count(*) AS n, md5(coalesce(string_agg((to_jsonb(r) - %L)::text, %L ORDER BY (to_jsonb(r) - %L)::text), %L)) AS d FROM public.%I r',
    'slug', '|', 'slug', '', t.table_name), false, true, '') AS x
  FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    AND t.table_name NOT IN ('_prisma_migrations', 'SignupCode', 'OrganizationDomain', 'Invitation', 'RateLimitBucket', 'RateLimitConfig')
) s
ORDER BY s.table_name;
