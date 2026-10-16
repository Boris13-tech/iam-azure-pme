import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { seedActivationEvidence } from "../helpers/activation-evidence";

// Sovereign providers F4, slice S2 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 5): the data model
// of generic OIDC connections, held by the database itself. app_user (rawPrisma) is the runtime.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261016090000_provider_oidc_configuration";
const ROLLBACK = "docs/operations/PROVIDER-OIDC-CONFIGURATION-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;

type Org = { organizationId: string; tenantId: string; subjectId: string; local: string };
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name, slug: `${name}-${suffix}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const local = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", status: "ACTIVE", externalScopeId: tenantId, name: "LUXIA Local" } });
  const subject = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Admin", lifecycleState: "ACTIVE" } });
  return { organizationId, tenantId, subjectId: subject.id, local: local.id };
}
/** A new OIDC_GENERIC connection, DRAFT (the only initial state allowed for it). */
async function oidcConnection(org: Org): Promise<string> {
  const connection = await owner.providerConnection.create({ data: {
    organizationId: org.organizationId, providerType: "OIDC_GENERIC", status: "DRAFT", externalScopeId: `oidc-${randomUUID()}`, name: "Generic IdP" } });
  return connection.id;
}
// pg_advisory_xact_lock returns void, which $queryRaw cannot read: always run it with $executeRaw.
const lockSql = (org: Org) => Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))`;
/** As the runtime, inside the organization's scope; with the governance lock when asked. */
function asApp<T>(org: Org, work: (tx: Prisma.TransactionClient) => Promise<T>, options: { lock?: boolean } = {}): Promise<T> {
  return rawPrisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.organization_id', ${org.organizationId}, true), set_config('app.tenant_id', ${org.tenantId}, true)`;
    if (options.lock) await tx.$executeRaw(lockSql(org));
    return work(tx);
  });
}
async function asOwnerLocked<T>(org: Org, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return owner.$transaction(async (tx) => { await tx.$executeRaw(lockSql(org)); return work(tx); });
}
const insertConfig = (tx: Prisma.TransactionClient, org: Org, connection: string, fields: Record<string, string> = {}) => {
  const row = { issuer: "https://idp.example.com", clientId: "luxia-client", ...fields };
  const columns = Object.keys(row).map((key) => `"${key}"`).join(", ");
  const values = Object.values(row).map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  return tx.$executeRawUnsafe(`INSERT INTO "ProviderOidcConfiguration" ("id", "organizationId", "providerConnectionId", ${columns})
    VALUES ('${randomUUID()}', '${org.organizationId}', '${connection}', ${values})`);
};
const setStatus = (org: Org, connection: string, status: string) =>
  asOwnerLocked(org, (tx) => tx.$executeRawUnsafe(`UPDATE "ProviderConnection" SET status = '${status}' WHERE id = '${connection}'`));
const failure = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: unknown) => String(error instanceof Error ? error.message : error));
const hashOf = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("hex");

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("F4 S2: generic OIDC configuration, test runs and transaction purpose (PostgreSQL, app_user)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("oidca"); b = await organization("oidcb");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("a configuration is written only for an OIDC_GENERIC connection, under the governance lock; the hash is the database's", async () => {
    const connection = await oidcConnection(a);
    expect(await failure(asApp(a, (tx) => insertConfig(tx, a, connection)))).toContain("GOVERNANCE_LOCK_REQUIRED");
    expect(await failure(asApp(a, (tx) => insertConfig(tx, a, a.local), { lock: true }))).toContain("PROVIDER_OIDC_CONFIGURATION_TYPE");
    await asApp(a, (tx) => insertConfig(tx, a, connection, { configurationHash: "f".repeat(64) }), { lock: true });
    const saved = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: connection } });
    expect(saved).toMatchObject({ clientAuthMethod: "client_secret_basic", idTokenAlgorithm: "RS256", scopes: "openid profile email" });
    expect(saved.configurationHash).toBe(hashOf("https://idp.example.com", "luxia-client", "client_secret_basic", "RS256", "openid profile email"));
    // One configuration per connection (Prisma hides the message of a raw unique violation: assert on its code).
    expect(await failure(asApp(a, (tx) => insertConfig(tx, a, connection), { lock: true }))).toContain("23505");
  });

  it("it changes while DRAFT or TESTING, is frozen once ACTIVE, never changes its identity and is never deleted", async () => {
    const connection = await oidcConnection(a);
    await asApp(a, (tx) => insertConfig(tx, a, connection), { lock: true });
    const update = (sql: string) => asApp(a, (tx) => tx.$executeRawUnsafe(`UPDATE "ProviderOidcConfiguration" SET ${sql} WHERE "providerConnectionId" = '${connection}'`), { lock: true });
    await update(`scopes = 'openid email'`);
    await setStatus(a, connection, "TESTING");
    await update(`"idTokenAlgorithm" = 'ES256'`);
    const tested = await owner.providerOidcConfiguration.findUniqueOrThrow({ where: { providerConnectionId: connection } });
    expect(tested.configurationHash).toBe(hashOf("https://idp.example.com", "luxia-client", "client_secret_basic", "ES256", "openid email"));
    expect(await failure(update(`"providerConnectionId" = '${a.local}'`))).toContain("PROVIDER_OIDC_CONFIGURATION_IMMUTABLE");
    // Since S5 the database activates only on valid evidence (test fixture: a passing test and proof).
    await seedActivationEvidence(owner, a, connection);
    await setStatus(a, connection, "ACTIVE");
    expect(await failure(update(`scopes = 'openid'`))).toContain("PROVIDER_OIDC_CONFIGURATION_LOCKED");
    expect(await failure(asApp(a, (tx) => tx.$executeRawUnsafe(`DELETE FROM "ProviderOidcConfiguration" WHERE "providerConnectionId" = '${connection}'`), { lock: true })))
      .toMatch(/permission denied/);
    expect(await failure(owner.$executeRawUnsafe(`DELETE FROM "ProviderOidcConfiguration" WHERE "providerConnectionId" = '${connection}'`)))
      .toContain("PROVIDER_OIDC_CONFIGURATION_IMMUTABLE");
  });

  it("its shape holds no secret: an exact HTTPS issuer on port 443, an allowed client authentication, algorithm and scopes", async () => {
    const refused: Array<[string, Record<string, string>, string]> = [
      ["plain HTTP", { issuer: "http://idp.example.com" }, "ProviderOidcConfiguration_issuer"],
      ["another port", { issuer: "https://idp.example.com:8443" }, "ProviderOidcConfiguration_issuer"],
      ["credentials", { issuer: "https://user@idp.example.com" }, "ProviderOidcConfiguration_issuer"],
      ["a query", { issuer: "https://idp.example.com/?tenant=x" }, "ProviderOidcConfiguration_issuer"],
      ["a fragment", { issuer: "https://idp.example.com/#x" }, "ProviderOidcConfiguration_issuer"],
      ["a single-label host", { issuer: "https://localhost" }, "ProviderOidcConfiguration_issuer"],
      ["an address literal", { issuer: "https://169.254.169.254" }, "ProviderOidcConfiguration_issuer"],
      ["upper case", { issuer: "https://IDP.example.com" }, "ProviderOidcConfiguration_issuer"],
      ["a client id with a space", { clientId: "a b" }, "ProviderOidcConfiguration_clientId"],
      ["no client authentication", { clientAuthMethod: "none" }, "ProviderOidcConfiguration_clientAuthMethod"],
      ["HS256", { idTokenAlgorithm: "HS256" }, "ProviderOidcConfiguration_idTokenAlgorithm"],
      ["alg none", { idTokenAlgorithm: "none" }, "ProviderOidcConfiguration_idTokenAlgorithm"],
      ["scopes without openid", { scopes: "profile email" }, "ProviderOidcConfiguration_scopes"],
    ];
    for (const [name, fields, constraint] of refused) {
      const connection = await oidcConnection(a);
      expect(await failure(asApp(a, (tx) => insertConfig(tx, a, connection, fields), { lock: true })), name).toContain(constraint);
    }
    for (const issuer of ["https://accounts.google.com", "https://idp.example.com/realms/luxia", "https://idp.example.com:443/realms/luxia/", "https://login.microsoftonline.com/0f3c/v2.0"]) {
      const connection = await oidcConnection(a);
      expect(await failure(asApp(a, (tx) => insertConfig(tx, a, connection, { issuer }), { lock: true })), issuer).toBe("ACCEPTED");
    }
  });

  it("forced row-level security: no row without context, none of another organization, no write into another organization", async () => {
    const connection = await oidcConnection(a);
    await asApp(a, (tx) => insertConfig(tx, a, connection), { lock: true });
    await asApp(a, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ProviderTestRun" ("id", "organizationId", "providerConnectionId", "kind", "outcome", "reasonCode", "configurationHash", "actorSubjectId")
      VALUES ('${randomUUID()}', '${a.organizationId}', '${connection}', 'DISCOVERY', 'PASSED', 'DISCOVERY_PASSED', '${"a".repeat(64)}', '${a.subjectId}')`));
    expect(await rawPrisma.providerOidcConfiguration.count()).toBe(0);
    expect(await rawPrisma.providerTestRun.count()).toBe(0);
    expect(await asApp(b, (tx) => tx.providerOidcConfiguration.count({ where: { providerConnectionId: connection } }))).toBe(0);
    expect(await asApp(b, (tx) => tx.providerTestRun.count({ where: { providerConnectionId: connection } }))).toBe(0);
    expect(await asApp(a, (tx) => tx.providerTestRun.count({ where: { providerConnectionId: connection } }))).toBe(1);
    const foreign = await oidcConnection(a);
    // Holding A's lock too. Under M2's row-level security the guard cannot even see A's connection from B's scope, so it
    // refuses before the policy would; the configuration of A stays out of B's reach either way.
    expect(await failure(asApp(b, async (tx) => { await tx.$executeRaw(lockSql(a)); return insertConfig(tx, a, foreign); }))).toContain("PROVIDER_OIDC_CONFIGURATION_CONNECTION");
    expect(await owner.providerOidcConfiguration.count({ where: { providerConnectionId: foreign } })).toBe(0);
  });

  it("test runs are append-only and hold safe codes only", async () => {
    const connection = await oidcConnection(a);
    const run = (fields: Record<string, string> = {}) => {
      const row = { kind: "DISCOVERY", outcome: "FAILED", reasonCode: "OUTBOUND_PRIVATE_ADDRESS", configurationHash: "b".repeat(64), metadata: "{}", ...fields };
      return asApp(a, (tx) => tx.$executeRawUnsafe(`INSERT INTO "ProviderTestRun" ("id", "organizationId", "providerConnectionId", "kind", "outcome", "reasonCode", "configurationHash", "metadata", "actorSubjectId")
        VALUES ('${randomUUID()}', '${a.organizationId}', '${connection}', '${row.kind}', '${row.outcome}', '${row.reasonCode}', '${row.configurationHash}', '${row.metadata}'::jsonb, '${a.subjectId}')`));
    };
    await run();
    expect(await failure(run({ kind: "LIVE" }))).toContain("ProviderTestRun_kind");
    expect(await failure(run({ outcome: "MAYBE" }))).toContain("ProviderTestRun_outcome");
    expect(await failure(run({ reasonCode: "https://10.0.0.1/" }))).toContain("ProviderTestRun_reasonCode");
    expect(await failure(run({ configurationHash: "short" }))).toContain("ProviderTestRun_configurationHash");
    expect(await failure(run({ metadata: "[]" }))).toContain("ProviderTestRun_metadata");
    expect(await failure(asApp(a, (tx) => tx.$executeRawUnsafe(`UPDATE "ProviderTestRun" SET outcome = 'PASSED' WHERE "providerConnectionId" = '${connection}'`)))).toMatch(/permission denied/);
    expect(await failure(owner.$executeRawUnsafe(`UPDATE "ProviderTestRun" SET outcome = 'PASSED' WHERE "providerConnectionId" = '${connection}'`))).toContain("AUDIT_APPEND_ONLY");
    expect(await failure(owner.$executeRawUnsafe(`DELETE FROM "ProviderTestRun" WHERE "providerConnectionId" = '${connection}'`))).toContain("AUDIT_APPEND_ONLY");
  });

  it("an authorization transaction states its purpose; LINK and ACTIVATION_PROOF carry their subject, a sign-in none", async () => {
    const insert = (purpose: string | null, subjectId: string | null) => owner.$executeRawUnsafe(`INSERT INTO "AuthTransaction"
      ("id", "stateHash", "nonce", "codeVerifier", "expectedOrganizationId", "expectedTenantId", "expectedProviderConnectionId", "expiresAt"${purpose ? `, "purpose"` : ""}, "subjectId")
      VALUES ('${randomUUID()}', '${randomUUID()}', 'n', 'v', '${a.organizationId}', '${a.tenantId}', '${a.local}', now() + interval '5 minutes'${purpose ? `, '${purpose}'` : ""}, ${subjectId ? `'${subjectId}'` : "NULL"})`);
    expect(await failure(insert(null, null))).toBe("ACCEPTED");
    expect(await failure(insert("LINK", a.subjectId))).toBe("ACCEPTED");
    expect(await failure(insert("ACTIVATION_PROOF", a.subjectId))).toBe("ACCEPTED");
    expect(await failure(insert("SIGN_IN", a.subjectId))).toContain("AuthTransaction_purpose");
    expect(await failure(insert("LINK", null))).toContain("AuthTransaction_purpose");
    expect(await failure(insert("RECOVERY", a.subjectId))).toContain("AuthTransaction_purpose");
  });

  it("drill: the rollback restores the previous state exactly (enum order included), refuses once in use, and the migration applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_f4s2_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psqlOk(url, [
      "-c", `SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = '"ProviderType"'::regtype`,
      "-c", `SELECT coalesce(to_regclass('public."ProviderOidcConfiguration"')::text, '-') || ' ' || coalesce(to_regclass('public."ProviderTestRun"')::text, '-')`,
      "-c", `SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name = 'AuthTransaction'`,
      "-c", `SELECT count(*) FROM pg_proc WHERE proname = 'luxia_provider_oidc_configuration_guard'`,
      "-c", `SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = '"ProviderConnection"'::regclass AND attname = 'providerType'`,
    ]).replace(/\r/g, "").trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = state();
      expect(before).not.toContain("OIDC_GENERIC");
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      const after = state();
      expect(after).toContain(",OIDC_GENERIC\n");
      expect(after).toContain('"ProviderOidcConfiguration" "ProviderTestRun"');
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(state()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(state()).toBe(after);
      // Once a generic OIDC connection exists, the rollback refuses and changes nothing.
      const org = randomUUID();
      psqlOk(url, ["-1", "-c", `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ('${org}', 'Drill', 'drill-${suffix}', now());
        INSERT INTO "ProviderConnection" (id, "organizationId", "providerType", "externalScopeId", name, status, "updatedAt") VALUES ('${randomUUID()}', '${org}', 'OIDC_GENERIC', 'x', 'Drill', 'DRAFT', now());`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("ROLLBACK_REFUSED_OIDC_CONFIGURATION_IN_USE");
      expect(state()).toBe(after);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
