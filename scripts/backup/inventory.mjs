// Inventory of a LUXIA database: every table's row count and content hash, and a fingerprint of the schema
// (columns, constraints, indexes, triggers, functions, RLS policies, privileges, roles). The backup records it
// inside the same snapshot as pg_dump; the restore recomputes it on the restored database and compares.
// It holds no personal data in clear: rows appear only as hashes, and it is stored encrypted next to the dump.
import { jsonLines, psql } from "./pg.mjs";

const USER_SCHEMAS = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
const ACL = (column, kind, owner) => `coalesce((SELECT string_agg(g, ',' ORDER BY g COLLATE "C") FROM (SELECT
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END AS g
  FROM aclexplode(coalesce(${column}, acldefault(${kind}, ${owner}))) a) z), '')`;
const NOT_EXTENSION = (classid, objid) => `NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.classid = '${classid}'::regclass AND dep.objid = ${objid} AND dep.deptype = 'e')`;

// Each category is a list of text lines, sorted, so two databases compare line by line.
const CATALOG = {
  database: `SELECT concat_ws(' ', 'encoding=' || pg_encoding_to_char(d.encoding), 'collate=' || d.datcollate, 'ctype=' || d.datctype)
    FROM pg_database d WHERE d.datname = current_database()`,
  tables: `SELECT concat_ws(' ', n.nspname || '.' || c.relname, 'kind=' || c.relkind::text, 'rls=' || c.relrowsecurity, 'force=' || c.relforcerowsecurity,
      'owner=' || pg_get_userbyid(c.relowner), 'acl=' || ${ACL("c.relacl", "CASE WHEN c.relkind = 'S' THEN 's'::\"char\" ELSE 'r'::\"char\" END", "c.relowner")})
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','S','f') AND ${USER_SCHEMAS}`,
  columns: `SELECT concat_ws(' ', n.nspname || '.' || c.relname, row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum), a.attname,
      format_type(a.atttypid, a.atttypmod), 'notnull=' || a.attnotnull, 'default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
      'identity=' || a.attidentity::text, 'generated=' || a.attgenerated::text, 'collation=' || coalesce(co.collname, ''),
      'acl=' || coalesce((SELECT string_agg(g, ',' ORDER BY g COLLATE "C") FROM (SELECT pg_get_userbyid(x.grantee) || ':' || x.privilege_type AS g FROM aclexplode(a.attacl) x) z), ''))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 0 AND co.collname <> 'default'
    WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND ${USER_SCHEMAS}`,
  constraints: `SELECT concat_ws(' ', n.nspname || '.' || coalesce(c.relname, t.typname, '-'), con.conname, 'type=' || con.contype::text,
      'validated=' || con.convalidated, 'deferrable=' || con.condeferrable, 'deferred=' || con.condeferred, pg_get_constraintdef(con.oid))
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
    LEFT JOIN pg_class c ON c.oid = con.conrelid LEFT JOIN pg_type t ON t.oid = con.contypid WHERE ${USER_SCHEMAS}`,
  indexes: `SELECT concat_ws(' ', pg_get_indexdef(i.indexrelid), 'valid=' || i.indisvalid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS}`,
  triggers: `SELECT concat_ws(' ', pg_get_triggerdef(t.oid), 'enabled=' || t.tgenabled::text)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND ${USER_SCHEMAS}`,
  functions: `SELECT concat_ws(' ', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', 'kind=' || p.prokind::text,
      'secdef=' || p.prosecdef, 'config=' || coalesce(array_to_string(p.proconfig, ';'), ''), 'owner=' || pg_get_userbyid(p.proowner),
      'acl=' || ${ACL("p.proacl", "'f'::\"char\"", "p.proowner")},
      'def=' || CASE WHEN p.prokind IN ('f','p') THEN encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') ELSE '' END)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${USER_SCHEMAS} AND ${NOT_EXTENSION("pg_proc", "p.oid")}`,
  policies: `SELECT concat_ws(' ', n.nspname || '.' || c.relname, pol.polname, 'cmd=' || pol.polcmd::text, 'permissive=' || pol.polpermissive,
      'roles=' || (SELECT string_agg(g, ',' ORDER BY g COLLATE "C") FROM (SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END AS g FROM unnest(pol.polroles) r) z),
      'using=' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), ''), 'check=' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS}`,
  sequences: `SELECT concat_ws(' ', schemaname || '.' || sequencename, 'type=' || data_type, 'last=' || coalesce(last_value::text, 'null'))
    FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
  views: `SELECT concat_ws(' ', n.nspname || '.' || c.relname, encode(sha256(convert_to(pg_get_viewdef(c.oid), 'UTF8')), 'hex'))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v','m') AND ${USER_SCHEMAS}`,
  types: `SELECT concat_ws(' ', n.nspname || '.' || t.typname, 'type=' || t.typtype::text,
      'labels=' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), ''))
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype IN ('e','d','c') AND ${USER_SCHEMAS} AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind <> 'c')`,
  extensions: `SELECT e.extname || ' ' || e.extversion FROM pg_extension e`,
  defaultPrivileges: `SELECT concat_ws(' ', pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'), 'type=' || d.defaclobjtype::text,
      'acl=' || coalesce((SELECT string_agg(g, ',' ORDER BY g COLLATE "C") FROM (SELECT pg_get_userbyid(x.grantee) || ':' || x.privilege_type AS g FROM aclexplode(d.defaclacl) x) z), ''))
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`,
  // Security attributes of every role the schema refers to. Login, password, connection limit and settings
  // belong to the environment and are set at cutover, so they are recorded below but not compared.
  roleAttributes: `SELECT concat_ws(' ', r.rolname, 'super=' || r.rolsuper, 'bypassrls=' || r.rolbypassrls, 'createrole=' || r.rolcreaterole,
      'createdb=' || r.rolcreatedb, 'replication=' || r.rolreplication, 'inherit=' || r.rolinherit)
    FROM pg_roles r WHERE r.oid IN (SELECT role FROM referenced_roles)`,
};

const REFERENCED_ROLES = `WITH referenced_roles(role) AS (
  SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS}
  UNION SELECT a.grantee FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a WHERE ${USER_SCHEMAS}
  UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${USER_SCHEMAS}
  UNION SELECT a.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, aclexplode(p.proacl) a WHERE ${USER_SCHEMAS}
  UNION SELECT unnest(pol.polroles) FROM pg_policy pol
  UNION SELECT d.defaclrole FROM pg_default_acl d
  UNION SELECT a.grantee FROM pg_default_acl d, aclexplode(d.defaclacl) a
  UNION SELECT n.nspowner FROM pg_namespace n WHERE ${USER_SCHEMAS}
)`;

function script(snapshot) {
  const lines = [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
    ...(snapshot ? [`SET TRANSACTION SNAPSHOT '${snapshot.replace(/[^0-9A-Fa-f-]/g, "")}';`] : []),
    // Fail rather than filter: with row_security off, a table this role cannot fully read raises an error.
    "SET LOCAL row_security = off;",
    "SET LOCAL DateStyle = ISO, YMD; SET LOCAL TimeZone = 'UTC'; SET LOCAL IntervalStyle = postgres;",
    "SET LOCAL extra_float_digits = 3; SET LOCAL bytea_output = hex;",
    `SELECT json_build_object('kind','meta','serverVersionNum', current_setting('server_version_num')::int, 'database', current_database(),
      'user', current_user, 'largeObjects', (SELECT count(*) FROM pg_largeobject_metadata),
      'migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
      'lastMigration', (SELECT max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL));`,
    `SELECT format($f$SELECT json_build_object('kind','table','name',%L,'rows',count(*),'sha256',
        encode(sha256(convert_to(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), ''), 'UTF8')), 'hex'))
      FROM (SELECT encode(sha256(convert_to(t::text, 'UTF8')), 'hex') AS h FROM %I.%I t) s;$f$, n.nspname || '.' || c.relname, n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND ${USER_SCHEMAS} ORDER BY 1 \\gexec`,
    ...Object.entries(CATALOG).map(([name, sql]) =>
      `${REFERENCED_ROLES} SELECT json_build_object('kind','catalog','name','${name}','items', coalesce(json_agg(x ORDER BY x COLLATE "C"), '[]'::json)) FROM (${sql}) s(x);`),
    `${REFERENCED_ROLES} SELECT json_build_object('kind','roles','items', coalesce(json_agg(json_build_object('name', r.rolname, 'super', r.rolsuper,
      'bypassrls', r.rolbypassrls, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'replication', r.rolreplication, 'inherit', r.rolinherit,
      'login', r.rolcanlogin, 'connectionLimit', r.rolconnlimit, 'config', r.rolconfig) ORDER BY r.rolname), '[]'::json))
      FROM pg_roles r WHERE r.oid IN (SELECT role FROM referenced_roles);`,
    "COMMIT;",
  ];
  return lines.join("\n") + "\n";
}

export function takeInventory(env, snapshot = null) {
  const records = jsonLines(psql(env, script(snapshot)).stdout);
  const meta = records.find(r => r.kind === "meta");
  const tables = Object.fromEntries(records.filter(r => r.kind === "table").map(r => [r.name, { rows: Number(r.rows), sha256: r.sha256 }]));
  const catalog = Object.fromEntries(records.filter(r => r.kind === "catalog").map(r => [r.name, r.items]));
  const roles = records.find(r => r.kind === "roles")?.items ?? [];
  if (!meta || Object.keys(catalog).length !== Object.keys(CATALOG).length) throw new Error("incomplete inventory");
  return { meta, tables, catalog, roles };
}

// Compares two inventories. Returns the list of differences (empty when identical).
export function compareInventories(expected, actual) {
  const differences = [];
  for (const key of ["serverVersionNum", "migrations", "lastMigration", "largeObjects"]) {
    const a = key === "serverVersionNum" ? Math.floor(expected.meta[key] / 10000) : expected.meta[key];
    const b = key === "serverVersionNum" ? Math.floor(actual.meta[key] / 10000) : actual.meta[key];
    if (a !== b) differences.push(`meta.${key}: expected ${a}, found ${b}`);
  }
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const e = expected.tables[name]; const a = actual.tables[name];
    if (!e) differences.push(`table ${name}: unexpected`);
    else if (!a) differences.push(`table ${name}: missing`);
    else if (e.rows !== a.rows) differences.push(`table ${name}: ${e.rows} rows expected, ${a.rows} found`);
    else if (e.sha256 !== a.sha256) differences.push(`table ${name}: same row count, different content`);
  }
  for (const name of Object.keys(CATALOG)) {
    const e = new Set(expected.catalog[name] ?? []); const a = new Set(actual.catalog[name] ?? []);
    for (const line of e) if (!a.has(line)) differences.push(`catalog.${name} missing: ${line.slice(0, 160)}`);
    for (const line of a) if (!e.has(line)) differences.push(`catalog.${name} unexpected: ${line.slice(0, 160)}`);
  }
  return differences;
}

export function summarize(inventory) {
  const rows = Object.values(inventory.tables).reduce((sum, t) => sum + t.rows, 0);
  return { tables: Object.keys(inventory.tables).length, rows, catalog: Object.fromEntries(Object.entries(inventory.catalog).map(([k, v]) => [k, v.length])) };
}
