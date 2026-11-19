/**
 * The decisions the G4 post-restore command makes, as pure functions, so each can be driven to its failing answer by a
 * test instead of being read in the source (Codex F5, review of #195). The command itself only connects, reads and
 * reports; what counts as a fault lives here.
 */

/**
 * Parameters a drill connection may carry. Anything else can send the connection somewhere other than the copy. Only
 * libpq's own are kept for psql; `schema` is Prisma's, accepted only as `public` and dropped before psql sees the URL,
 * which refuses any parameter it does not know (Gemini 4 Hydrogen finding 4, review of #195).
 */
export const ALLOWED_PARAMETERS = new Set(["sslmode", "connect_timeout", "schema"]);
/** A restore copy names itself one: the drill creates it, so it can be named so, and no other database qualifies. */
export const DISPOSABLE_NAME = /^luxia_restore[a-z0-9_]*$/;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]", "::1"];

/**
 * One validated connection string, or a refusal message. `fail` is called with the reason and must not return.
 * Returns the URL as given back by the parser, the database name and the endpoint, so two URLs can be compared.
 */
export function validate(name, value, fail) {
  if (!value) return fail(`set ${name}`);
  // A "#" is a fragment to this parser and not to libpq, so the two could read different targets from one string; it
  // has no use in a connection string and is refused outright (Gemini 4 Neon finding 1, seventh review).
  if (value.includes("#")) return fail(`${name} contains "#", which libpq and this check would not read the same way`);
  let url;
  try { url = new URL(value); } catch { return fail(`${name} is not a URL`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) return fail(`${name} is not a postgres URL (${url.protocol})`);
  if (!LOOPBACK.includes(url.hostname)) return fail(`${name} points at ${url.hostname}: the drill target must be a disposable copy on this machine`);
  for (const parameter of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(parameter)) return fail(`${name} carries the parameter ${parameter}, which could send the connection elsewhere`);
  }
  const schemas = url.searchParams.getAll("schema");
  if (schemas.some((schema) => schema !== "public")) return fail(`${name} names the schema ${schemas.join(",")}: the drill checks schema public only`);
  const database = url.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]+$/.test(database)) return fail(`${name} has no plain database name`);
  if (!DISPOSABLE_NAME.test(database)) return fail(`${name} names the database ${database}: the drill target must be named luxia_restore… so that no other database can be reached`);
  // What psql receives is rebuilt from the parts just checked, not passed through: scheme, credentials, the loopback
  // host and port, the database, and libpq's own parameters. What Prisma receives: the same, schema pinned to public.
  const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const credentials = url.username ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  const libpq = new URLSearchParams([...url.searchParams].filter(([key]) => key !== "schema"));
  const query = libpq.toString() ? `?${libpq}` : "";
  const forPsql = new URL(`postgresql://${credentials}${host}${url.port ? `:${url.port}` : ""}/${database}${query}`);
  const forPrisma = new URL(forPsql.toString()); forPrisma.searchParams.set("schema", "public");
  // localhost and 127.0.0.1 are the same endpoint here: both are refused unless they are loopback, and the two URLs
  // are compared on the resolved server identity as well, read back from each connection.
  return { url: forPsql.toString(), prismaUrl: forPrisma.toString(), database,
    endpoint: `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "5432"}` };
}

/**
 * The same server, another disposable database: the reference that the copy is compared with. It is migrated from the
 * same release, so every object a migration defines can be compared one for one with the restored copy's.
 */
export function referenceOf(owner, suffix) {
  // Its own name, never derived by appending to the copy's: PostgreSQL cuts a name at 63 bytes, and a long copy name
  // plus "_ref" could be cut back to the copy's own, which would then be dropped (Gemini 4 Hydrogen finding 4).
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error("the reference needs an 8-hex suffix");
  const database = `luxia_restore_ref_${suffix}`;
  if (database === owner.database) throw new Error("the reference would be the copy");
  const url = new URL(owner.url);
  url.pathname = `/${database}`;
  const forPrisma = new URL(url.toString()); forPrisma.searchParams.set("schema", "public");
  return { url: url.toString(), prismaUrl: forPrisma.toString(), database, endpoint: owner.endpoint };
}

/** The server part of what a connection reports about itself, so a copy and its reference can be compared. */
export const serverOf = (identity) => /\son (.+)$/.exec(identity)?.[1] ?? "";

/**
 * Everything the migrations define that guards the data, one line per object, read the same way from the copy and from
 * the reference. A list of named checks kept missing what it did not name — a weakened policy, a guard trigger nobody
 * had listed, a function body changed in place (Gemini 4 Hydrogen findings 1, 2 and 5, review of #195) — so the copy is
 * compared with a database migrated from the same release instead: anything missing, changed or added is a fault.
 *
 * Read: the schemas; the relations of schema public with their kind, owner and row-level security flags, and every
 * grant on them, on their columns, on the schema and on the functions; every column with its type, nullability and
 * default; every constraint and index as PostgreSQL prints them; every view's definition; every policy with its
 * command, roles and both expressions; every trigger as PostgreSQL prints it, with its state; every function with its
 * owner, security attributes, settings, a digest of its body, and whether PUBLIC may execute it; and the default
 * privileges. The reference is given the activation gate's grants too, so the comparison covers what the runtime role
 * may do as well as what the migrations define (Gemini 4 Hydrogen finding 1 and Argon findings 1 to 3, fourth review).
 * The role that migrated is written "owner" on both sides, whatever it is called. That role is the owner of the
 * migration history in each database, not the role running this: a Production backup restored as it is keeps
 * Production's owner name, and the reference is owned by the local one (Argon finding 3, seventh review).
 */
const MIGRATOR = `pg_get_userbyid(coalesce((SELECT relowner FROM pg_class WHERE oid = to_regclass('public._prisma_migrations')),
  (SELECT oid FROM pg_roles WHERE rolname = current_user)))`;
const OWNER = `CASE WHEN %s = ${MIGRATOR} THEN 'owner' ELSE %s::text END`;
const owned = (expression) => OWNER.replaceAll("%s", expression);
// The backup role (scripts/backup/luxia-backup-role.sql) is the backup system's, not the release's: Production and any
// copy restored from it carry its read grants, a reference migrated from the release does not. Its entries are left out
// of the comparison and judged on their own instead: read only (BACKUP_ROLE_SQL below).
// Ordered by the entry itself: "ORDER BY 1" inside an aggregate orders by the constant 1, which is no order at all, and
// two identical lists could print differently (Gemini 4 Hydrogen finding 4, seventh review).
const ACL_ENTRY = `${owned("CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END")} || ':' || a.privilege_type
      || CASE WHEN a.is_grantable THEN '+grant' ELSE '' END`;
const ACL = (column) => `coalesce((SELECT string_agg(${ACL_ENTRY}, ',' ORDER BY ${ACL_ENTRY}) FROM aclexplode(${column}) a
      WHERE a.grantee IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')), 'default')`;
export const FINGERPRINT_SQL = `SELECT coalesce(string_agg(line, chr(10) ORDER BY line), '') FROM (
  SELECT 'schema ' || n.nspname || ' owner=' || ${owned("pg_get_userbyid(n.nspowner)")} || ' acl=' || ${ACL("n.nspacl")} AS line
    FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
  UNION ALL SELECT 'table ' || c.relname || ' ' || c.relkind::text || ' owner=' || ${owned("pg_get_userbyid(c.relowner)")}
      || ' rls=' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text || ' acl=' || ${ACL("c.relacl")}
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
      || ' notnull=' || a.attnotnull::text || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-') || ' acl=' || ${ACL("a.attacl")}
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT 'constraint ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'index ' || pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'view ' || c.relname || ' ' || md5(pg_get_viewdef(c.oid))
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')
  UNION ALL SELECT 'default-privileges ' || ${owned("pg_get_userbyid(da.defaclrole)")} || ' ' || da.defaclobjtype::text
      || ' schema=' || coalesce(da.defaclnamespace::regnamespace::text, '-') || ' acl=' || ${ACL("da.defaclacl")}
    FROM pg_default_acl da
  UNION ALL SELECT 'policy ' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' to=' || array_to_string(roles, ',')
      || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL SELECT 'trigger ' || pg_get_triggerdef(t.oid) || ' state=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
  -- The internal triggers that enforce foreign keys: named after object ids, so read by their constraint, table and
  -- kind, with their state. ALTER TABLE ... DISABLE TRIGGER ALL switches them off and leaves every constraint in place
  -- (Codex F2, seventh review).
  UNION ALL SELECT 'constraint-trigger ' || c.relname || ' ' || k.conname || ' type=' || t.tgtype::text || ' state=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_constraint k ON k.oid = t.tgconstraint
    WHERE t.tgisinternal AND c.relnamespace = 'public'::regnamespace
  -- The whole definition, as PostgreSQL prints it: body, language, volatility, strictness, leakproofness, security
  -- and settings, not the body alone (Argon finding 3, sixth review).
  UNION ALL SELECT 'function ' || p.oid::regprocedure::text || ' owner=' || ${owned("pg_get_userbyid(p.proowner)")}
      || ' definer=' || p.prosecdef::text
      || ' config=' || coalesce(array_to_string(p.proconfig, ';'), '-')
      || ' definition=' || md5(CASE WHEN p.prokind IN ('f', 'p', 'w') THEN pg_get_functiondef(p.oid) ELSE coalesce(p.prosrc, '') END)
      || ' public=' || has_function_privilege('public', p.oid, 'EXECUTE')::text || ' acl=' || ${ACL("p.proacl")}
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  -- Rules rewrite what a statement does to a table; views keep theirs in the view line above.
  UNION ALL SELECT 'rule ' || c.relname || ' ' || r.rulename || ' ' || md5(pg_get_ruledef(r.oid))
    FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = 'public'::regnamespace AND r.rulename <> '_RETURN'
  -- An index that is not valid or not ready enforces nothing, and prints the same definition.
  UNION ALL SELECT 'index-state ' || c.relname || ' valid=' || i.indisvalid::text || ' ready=' || i.indisready::text
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'type ' || t.typname || ' ' || t.typtype::text || ' owner=' || ${owned("pg_get_userbyid(t.typowner)")}
      || ' labels=' || coalesce((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '-')
      || ' acl=' || ${ACL("t.typacl")}
    FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd', 'c')
      AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid AND c.relkind <> 'c')
  -- Settings that every session of the database, or of the runtime role, starts with.
  -- The migration history: the same migrations, with the same checksums, finished and not rolled back.
  UNION ALL SELECT 'migration ' || m.migration_name || ' checksum=' || m.checksum || ' finished=' || (m.finished_at IS NOT NULL)::text
      || ' rolled_back=' || (m.rolled_back_at IS NOT NULL)::text
    FROM public._prisma_migrations m
) lines`;

/**
 * The activation gate's grant step, read from the release's own gate, for the reference: Production's grants are the
 * migrations' plus these, so the reference only matches a restored Production copy once it has them too. The gate
 * names Production's database; the reference's own name takes its place.
 */
export function gateGrantSql(gate, database) {
  if (!/^luxia_restore_ref_[a-f0-9]{8}$/.test(database)) throw new Error("gate grants are only ever applied to a reference database");
  const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gate.replace(/\r/g, ""))?.[1];
  if (!block) throw new Error("the release's activation gate has no grant step");
  return block.replace(/^ {10}/gm, "").replace(/DATABASE neondb\b/g, `DATABASE ${database}`);
}

/**
 * What the backup role holds on the copy beyond reading: it may connect, use the schema and read tables and sequences,
 * and nothing else, with no grant option. Empty when it holds no more, or does not exist.
 */
// Every way the backup role could be more than a reader: what scripts/backup/luxia-backup-role.sql makes it is a role
// that cannot create, replicate or inherit, starts every session read only, has no member and is a member of nothing,
// and holds SELECT on tables and sequences — not USAGE on a sequence, which lets nextval() write (Argon finding 1 and
// Gemini 4 Hydrogen finding 1, sixth review). BYPASSRLS it has by design: a backup must read every organization.
export const BACKUP_ROLE_SQL = `SELECT coalesce(string_agg(DISTINCT entry, ', '), '') FROM (
  SELECT 'superuser' AS entry FROM pg_roles WHERE rolname = 'luxia_backup' AND rolsuper
  UNION ALL SELECT 'createrole' FROM pg_roles WHERE rolname = 'luxia_backup' AND rolcreaterole
  UNION ALL SELECT 'createdb' FROM pg_roles WHERE rolname = 'luxia_backup' AND rolcreatedb
  UNION ALL SELECT 'replication' FROM pg_roles WHERE rolname = 'luxia_backup' AND rolreplication
  UNION ALL SELECT 'inherit' FROM pg_roles WHERE rolname = 'luxia_backup' AND rolinherit
  -- Its sessions on this database start read only: the per-database setting wins over the role's, so an override here
  -- to anything else is a fault even when the role-wide one says on (Gemini 4 Hydrogen and Argon finding 2, seventh
  -- review). A role that cannot log in opens no session at all: restore.mjs recreates the roles a backup names that
  -- way, without their settings, which must not fail a clean restore.
  UNION ALL SELECT 'sessions are not read only' FROM pg_roles r WHERE r.rolname = 'luxia_backup' AND r.rolcanlogin AND coalesce(
      (SELECT split_part(c.setting, '=', 2) FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c(setting)
        WHERE s.setrole = r.oid AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND split_part(c.setting, '=', 1) = 'default_transaction_read_only'),
      (SELECT split_part(c.setting, '=', 2) FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c(setting)
        WHERE s.setrole = r.oid AND s.setdatabase = 0 AND split_part(c.setting, '=', 1) = 'default_transaction_read_only'),
      'off') NOT IN ('on', 'true', '1')
  -- Nothing on the database but CONNECT, no ownership of it, no grant on a type.
  UNION ALL SELECT 'holds ' || a.privilege_type || ' on the database' FROM pg_database d CROSS JOIN aclexplode(d.datacl) a
    WHERE d.datname = current_database() AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
      AND (a.privilege_type <> 'CONNECT' OR a.is_grantable)
  UNION ALL SELECT 'owns the database' FROM pg_database d
    WHERE d.datname = current_database() AND d.datdba = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
  UNION ALL SELECT t.typname || ':' || a.privilege_type FROM pg_type t CROSS JOIN aclexplode(t.typacl) a
    WHERE t.typnamespace = 'public'::regnamespace AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
  UNION ALL SELECT 'has the member ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
    WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
  UNION ALL SELECT c.relname || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '+grant' ELSE '' END
    FROM pg_class c CROSS JOIN aclexplode(c.relacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
      AND (a.privilege_type <> 'SELECT' OR a.is_grantable)
  UNION ALL SELECT c.relname || '.' || t.attname || ':' || a.privilege_type || CASE WHEN a.is_grantable THEN '+grant' ELSE '' END
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid CROSS JOIN aclexplode(t.attacl) a
    WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
      AND (a.privilege_type <> 'SELECT' OR a.is_grantable)
  UNION ALL SELECT n.nspname || ':' || a.privilege_type FROM pg_namespace n CROSS JOIN aclexplode(n.nspacl) a
    WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup') AND (a.privilege_type <> 'USAGE' OR a.is_grantable)
  UNION ALL SELECT p.oid::regprocedure::text || ':' || a.privilege_type FROM pg_proc p CROSS JOIN aclexplode(p.proacl) a
    WHERE p.pronamespace = 'public'::regnamespace AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
  UNION ALL SELECT 'default ' || da.defaclobjtype::text || ':' || a.privilege_type FROM pg_default_acl da CROSS JOIN aclexplode(da.defaclacl) a
    WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup') AND (a.privilege_type <> 'SELECT' OR a.is_grantable)
  UNION ALL SELECT 'member of ' || r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'luxia_backup')
) held`;

/**
 * Settings every session on this database starts with, for the runtime role, the job's role, every role, or the
 * database itself. They cannot be compared with the reference: a role-wide setting is the cluster's and shows the same
 * on both sides (Gemini 4 Hydrogen finding 1 and Argon finding 1, seventh review). So they are judged: only timeouts,
 * which only narrow a session. session_replication_role, row_security, search_path or a read-write default would each
 * change what the guards and the policies do.
 */
export const SESSION_TIMEOUTS = ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "idle_session_timeout"];
export const SESSION_SETTINGS_SQL = `SELECT coalesce(string_agg(DISTINCT
    CASE WHEN s.setrole = 0 THEN 'every role' ELSE pg_get_userbyid(s.setrole) END
    || CASE WHEN s.setdatabase = 0 THEN ' everywhere' ELSE ' here' END || ': ' || c.setting, '; '), '')
  FROM pg_db_role_setting s CROSS JOIN unnest(s.setconfig) c(setting)
  WHERE s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
    AND (s.setrole = 0 OR s.setrole IN (SELECT oid FROM pg_roles WHERE rolname IN ('app_user', 'luxia_retention')))
    AND split_part(c.setting, '=', 1) NOT IN (${SESSION_TIMEOUTS.map((name) => `'${name}'`).join(", ")})`;

/** The lines of the reference missing from the copy, and the copy's lines the reference does not have. */
export function fingerprintFaults(copy, reference) {
  const have = new Set(copy);
  const expected = new Set(reference);
  const missing = reference.filter((line) => !have.has(line)).map((line) => `missing or changed: ${line}`);
  const added = copy.filter((line) => !expected.has(line)).map((line) => `not in the release: ${line}`);
  return [...missing, ...added];
}

/**
 * The privileges the activation gate takes from app_user, read from the release's own gate: every
 * `REVOKE … ON … FROM app_user` of its grant step. The copy must not give app_user back any of them (Gemini 4 Hydrogen
 * finding 5, review of #195), and reading them from the gate means a narrowing added later is checked without this file
 * having to name it.
 */
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"];
export function gateRevokes(gate) {
  // In order, as the gate runs them: a REVOKE takes privileges away and a later GRANT on the same named objects gives
  // some back (REVOKE ALL on Invitation, then GRANT SELECT, INSERT, UPDATE). What is left revoked at the end is what
  // app_user must not hold. The broad grant on ALL TABLES comes first and names no table, so it is not read here.
  const revoked = new Map();
  const pattern = /(REVOKE|GRANT) ([A-Z, ]+) ON (SEQUENCE )?((?:"[A-Za-z0-9_]+"(?:, *)?)+) (FROM|TO) app_user;/g;
  for (const match of gate.replace(/\r/g, "").matchAll(pattern)) {
    const [, verb, list, sequenceWord, objects, direction] = match;
    if ((verb === "REVOKE") !== (direction === "FROM")) continue;
    const sequence = Boolean(sequenceWord);
    const named = list.split(",").map((privilege) => privilege.trim());
    const privileges = named.includes("ALL") ? (sequence ? SEQUENCE_PRIVILEGES : TABLE_PRIVILEGES) : named;
    for (const object of objects.split(",").map((name) => name.trim().replace(/"/g, ""))) {
      for (const privilege of privileges) {
        const key = `${object}\u0000${privilege}\u0000${sequence}`;
        if (verb === "REVOKE") revoked.set(key, { object, privilege, sequence });
        else revoked.delete(key);
      }
    }
  }
  return [...revoked.values()];
}
/** SQL listing the revoked privileges app_user holds again on the copy; objects the release does not have are skipped. */
export function heldRevokedSql(revokes) {
  if (revokes.length === 0) return `SELECT 'the gate revokes nothing from app_user'`;
  const rows = revokes.map(({ object, privilege, sequence }) => {
    if (!/^[A-Za-z0-9_]+$/.test(object) || !/^[A-Z]+$/.test(privilege)) throw new Error(`unexpected revoke: ${object} ${privilege}`);
    return `('${object}', '${privilege}', ${sequence})`;
  });
  return `SELECT coalesce(string_agg(r.object || ':' || r.privilege, ', ' ORDER BY r.object, r.privilege), '') FROM (VALUES ${rows.join(", ")}) r(object, privilege, sequence)
    WHERE to_regclass(format('public.%I', r.object)) IS NOT NULL
      AND CASE WHEN r.sequence THEN has_sequence_privilege('app_user', format('public.%I', r.object), r.privilege)
               ELSE has_table_privilege('app_user', format('public.%I', r.object), r.privilege) END`;
}

/**
 * The two URLs must reach one database on one server. Comparing the database name alone let the owner checks run on the
 * restored copy while the runtime-role checks ran on a different, clean instance of the same name (Codex F2).
 */
export function oneTarget(owner, app) {
  if (owner.database !== app.database) return `the two URLs name different databases: ${owner.database} and ${app.database}`;
  if (owner.endpoint !== app.endpoint) return `the two URLs point at different servers: ${owner.endpoint} and ${app.endpoint}`;
  return null;
}

/**
 * What each connection says about itself, read back from the server: both must answer the same database on the same
 * server. A URL pair that passes the checks above can still be pointed elsewhere by something outside them.
 */
export function sameServer(ownerIdentity, appIdentity) {
  return ownerIdentity === appIdentity ? null : `the two connections reached different targets: ${ownerIdentity} and ${appIdentity}`;
}

/**
 * The address the server reports for a connection, judged: null when it is one no database beyond this network can
 * have, or the reason it is refused. A copy in a container answers the container's own private address rather than
 * 127.0.0.1, so loopback alone would refuse an ordinary drill; a managed database reached through a local tunnel
 * answers a globally routable address, which is what this refuses (Antigravity finding 1, review of #195).
 *
 * What it cannot tell apart: another machine inside the same private network. The drill's own report says so.
 */
export function publicAddress(identity) {
  // The port is after the last colon, because an IPv6 address carries colons of its own.
  const address = /\son (.+):[^:]*$/.exec(identity)?.[1];
  if (!address) return `the server did not report an address: ${identity}`;
  // Every drill connection is TCP to a loopback address, so the server must see a TCP peer. A server that reports none
  // was reached over a Unix socket at its end: a local port forwarded to some other machine's socket would look like
  // that (Gemini 4 Hydrogen finding 3).
  if (address === "socket") return "the server saw no network connection, though the drill connects over TCP: something forwards it";
  const plain = address.replace(/\/\d+$/, "");
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(plain)?.slice(1).map(Number);
  if (!octets) {
    // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7) only. Loopback is the whole address: an
    // unanchored ::1 also accepted ::1234:… and ::10.0.0.1 (Antigravity finding 2, third review of #195).
    return /^(::1$|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i.test(plain) ? null
      : `the server answers ${address}, an address reachable beyond this network: the drill target must be a disposable copy here`;
  }
  const [a, b] = octets;
  const privateRange = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  return privateRange ? null
    : `the server answers ${address}, an address reachable beyond this network: the drill target must be a disposable copy here`;
}

/**
 * The checks that establish the target. If one of them failed, the command must stop before it migrates or writes
 * anything: it would otherwise do both to a database it has just failed to recognise (Antigravity finding 1, third
 * review of #195). Returns the reason, or null when the target is established.
 */
export const TARGET_CHECKS = [
  "the connection reached the disposable copy, not a database beyond this network",
  "both connections reached the same copy",
];
export function refusedTarget(checks) {
  for (const name of TARGET_CHECKS) {
    const entry = checks.find((candidate) => candidate.name === name);
    if (!entry) return `the target check "${name}" did not run`;
    if (!entry.ok) return `the target is not established: ${entry.detail}`;
  }
  return null;
}

/** How the daily job's connection must answer for itself: its role, and nothing that widens it. */
export const runnerExpected = (role) =>
  `${role} superuser=false bypassrls=false createrole=false createdb=false replication=false memberships=0 owns=0`;

/**
 * The runtime role as it must answer for itself on the copy: no attribute that widens it, no role it can become, and
 * nothing it owns, since an owner is exempt from row-level security unless it is forced and can always change it.
 */
export const EXPECTED_RUNTIME_ROLE =
  "app_user bypassrls=false superuser=false createrole=false createdb=false replication=false memberships=0 owns=0 database=none";

/**
 * The two tables that hold an organization without row-level security, by review: Tenant, the scope itself, and
 * LegacyUserBridge, the only link to the legacy tables, which R7 refuses to erase. The set read from the copy must be
 * exactly these: one more is customer data open to the runtime role, one fewer means the reviewed list no longer
 * matches the schema.
 */
export const REVIEWED_UNPROTECTED = ["LegacyUserBridge", "Tenant"];
export function unprotectedFault(found) {
  const names = found.split(",").filter(Boolean).sort();
  const extra = names.filter((name) => !REVIEWED_UNPROTECTED.includes(name));
  const gone = REVIEWED_UNPROTECTED.filter((name) => !names.includes(name));
  if (extra.length) return `without both row-level security flags, beyond the reviewed exceptions: ${extra.join(", ")}`;
  if (gone.length) return `the reviewed exceptions no longer match the schema: ${gone.join(", ")} not found among the tables without both flags`;
  return null;
}

/** The tables only their owner may touch. Each must still be owner-only, so none drifts out of the candidate set. */
export const EXPECTED_OWNER_ONLY = ["OrganizationErasure", "RateLimitBucket", "RateLimitConfig", "RetentionHold", "RetentionHoldEvent",
  "RetentionRun", "SignupCode"];
export function ownerOnlyFault(found) {
  const missing = EXPECTED_OWNER_ONLY.filter((name) => !found.includes(name));
  return missing.length ? `no longer owner-only: ${missing.join(", ")}` : null;
}

/** The environment every tool runs with: the parent's, minus every libpq variable (PGHOST, PGHOSTADDR, PGSERVICE…). */
export const cleanEnvironment = (environment) => Object.fromEntries(Object.entries(environment).filter(([key]) => !/^PG/i.test(key)));

/**
 * The guard triggers, each with the table it must be attached to, the function it must run, and the operations it must
 * cover. The name alone proved nothing: an enabled trigger of the same name on another table satisfied it while the
 * protected table had no guard (Codex F3). Timing and level are part of the contract too: an AFTER trigger cannot
 * refuse a write, and a statement-level trigger cannot see a row.
 */
export const EXPECTED_TRIGGERS = {
  audit_append_only: "CanonicalAdminAuditEvent luxia_audit_append_only BEFORE ROW DELETE,UPDATE",
  audit_append_only_truncate: "CanonicalAdminAuditEvent luxia_audit_append_only BEFORE STATEMENT TRUNCATE",
  evidence_append_only: "AuthenticationEvidence luxia_audit_append_only BEFORE ROW DELETE,UPDATE",
  evidence_append_only_truncate: "AuthenticationEvidence luxia_audit_append_only BEFORE STATEMENT TRUNCATE",
  invitation_guard: "Invitation luxia_invitation_guard BEFORE ROW DELETE,INSERT,UPDATE",
  organization_slug_immutable: "Organization luxia_organization_slug_guard BEFORE ROW UPDATE",
  organization_status_guard: "Organization luxia_organization_status_guard BEFORE ROW INSERT,UPDATE",
  provider_connection_guard: "ProviderConnection luxia_provider_connection_guard BEFORE ROW DELETE,INSERT,UPDATE",
  provider_secret_reference_guard: "ProviderSecretReference luxia_provider_secret_reference_guard BEFORE ROW DELETE,INSERT,UPDATE",
  session_guard: "Session luxia_session_guard BEFORE ROW INSERT,UPDATE",
  signup_code_guard: "SignupCode luxia_signup_code_guard BEFORE ROW DELETE,UPDATE",
};

/**
 * The states in which a trigger fires for an ordinary write: O (origin) and A (always). D is disabled, and R fires only
 * for a replication apply, so a guard left in R does not refuse anything an application does (Codex F1).
 */
const FIRES_ON_ORDINARY_WRITES = new Set(["O", "A"]);
const described = (state) => (state === "D" ? "disabled" : state === "R" ? "replica-only, so it does not fire for ordinary writes" : `in state ${state}`);

/**
 * Every fault in the restored copy's guard triggers. `lines` are the catalog's own rows, one per trigger, as
 * `<name>|<table> <function> <timing> <level> <events>|<state>`; `expected` is the contract above.
 */
export function triggerFaults(lines, expected = EXPECTED_TRIGGERS) {
  const found = new Map();
  for (const line of lines) {
    const [name, shape, state] = line.split("|");
    // Two triggers of one name on different tables are kept apart: collapsing them was how a guard on the wrong table
    // satisfied the check.
    found.set(`${name}|${shape}`, { name, shape, state });
  }
  const faults = [];
  for (const [name, shape] of Object.entries(expected)) {
    const exact = found.get(`${name}|${shape}`);
    if (!exact) {
      const byName = [...found.values()].filter((row) => row.name === name);
      faults.push(byName.length === 0 ? `${name} is missing` : `${name} is ${byName.map((row) => row.shape).join(" and ")}, not ${shape}`);
      continue;
    }
    if (!FIRES_ON_ORDINARY_WRITES.has(exact.state)) faults.push(`${name} is ${described(exact.state)}`);
  }
  // A guard outside the contract that has been switched off is a fault too: the copy is meant to come back intact.
  for (const row of found.values()) {
    if (!FIRES_ON_ORDINARY_WRITES.has(row.state) && !faults.some((fault) => fault.startsWith(`${row.name} is`))) {
      faults.push(`${row.name} on ${row.shape.split(" ")[0]} is ${described(row.state)}`);
    }
  }
  return [...new Set(faults)];
}
