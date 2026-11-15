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
  // What psql receives: libpq's parameters only. What Prisma receives: the same, with its schema pinned to public.
  const forPsql = new URL(url.toString()); forPsql.searchParams.delete("schema");
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
export function referenceOf(owner) {
  const url = new URL(owner.url);
  const database = `${owner.database}_ref`;
  url.pathname = `/${database}`;
  const forPrisma = new URL(url.toString()); forPrisma.searchParams.set("schema", "public");
  return { url: url.toString(), prismaUrl: forPrisma.toString(), database, endpoint: owner.endpoint };
}

/**
 * Everything the migrations define that guards the data, one line per object, read the same way from the copy and from
 * the reference. A list of named checks kept missing what it did not name — a weakened policy, a guard trigger nobody
 * had listed, a function body changed in place (Gemini 4 Hydrogen findings 1, 2 and 5, review of #195) — so the copy is
 * compared with a database migrated from the same release instead: anything missing, changed or added is a fault.
 *
 * Read: the tables of schema public and their row-level security flags; every policy with its command, roles and both
 * expressions; every trigger as PostgreSQL itself prints it, with its state; every function with its security
 * attributes, its settings, a digest of its body, and whether PUBLIC may execute it. Grants to app_user are not here:
 * the activation gate gives them, not the migrations, and they are checked against the gate below.
 */
export const FINGERPRINT_SQL = `SELECT coalesce(string_agg(line, chr(10) ORDER BY line), '') FROM (
  SELECT 'table ' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text AS line
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
  UNION ALL SELECT 'policy ' || tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' to=' || array_to_string(roles, ',')
      || ' using=' || coalesce(qual, '-') || ' check=' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL SELECT 'trigger ' || pg_get_triggerdef(t.oid) || ' state=' || t.tgenabled::text
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
  UNION ALL SELECT 'function ' || p.oid::regprocedure::text || ' definer=' || p.prosecdef::text
      || ' config=' || coalesce(array_to_string(p.proconfig, ';'), '-') || ' body=' || md5(coalesce(p.prosrc, ''))
      || ' public=' || has_function_privilege('public', p.oid, 'EXECUTE')::text
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
) lines`;

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
  if (address === "socket") return null;
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

/**
 * The runtime role as it must answer for itself on the copy: no attribute that widens it, no role it can become, and
 * nothing it owns, since an owner is exempt from row-level security unless it is forced and can always change it.
 */
export const EXPECTED_RUNTIME_ROLE = "app_user bypassrls=false superuser=false createrole=false memberships=0 owns=0";

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
