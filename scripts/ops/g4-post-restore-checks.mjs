/**
 * The decisions the G4 post-restore command makes, as pure functions, so each can be driven to its failing answer by a
 * test instead of being read in the source (Codex F5, review of #195). The command itself only connects, reads and
 * reports; what counts as a fault lives here.
 */

/** Parameters a drill connection may carry. Anything else can send the connection somewhere other than the copy. */
export const ALLOWED_PARAMETERS = new Set(["sslmode", "schema", "connect_timeout", "connection_limit", "pool_timeout"]);
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
  const database = url.pathname.replace(/^\//, "");
  if (!/^[A-Za-z0-9_]+$/.test(database)) return fail(`${name} has no plain database name`);
  if (!DISPOSABLE_NAME.test(database)) return fail(`${name} names the database ${database}: the drill target must be named luxia_restore… so that no other database can be reached`);
  // localhost and 127.0.0.1 are the same endpoint here: both are refused unless they are loopback, and the two URLs
  // are compared on the resolved server identity as well, read back from each connection.
  return { url: url.toString(), database, endpoint: `${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "5432"}` };
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
    // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7) only.
    return /^(::1|fe[89ab][0-9a-f]:|f[cd][0-9a-f]{2}:)/i.test(plain) ? null
      : `the server answers ${address}, an address reachable beyond this network: the drill target must be a disposable copy here`;
  }
  const [a, b] = octets;
  const privateRange = a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  return privateRange ? null
    : `the server answers ${address}, an address reachable beyond this network: the drill target must be a disposable copy here`;
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
