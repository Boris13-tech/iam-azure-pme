import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { connectionSecretReference } from "../../lib/provider-adapters/infrastructure/secret-stores";

// F3 (docs/architecture/F3-SECRET-STORE-DESIGN.md): per-connection secret references on PostgreSQL. app_user (rawPrisma)
// is the runtime; owner checks the database guards directly.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261014110000_provider_secret_reference";
const ROLLBACK = "docs/operations/PROVIDER-SECRET-REFERENCE-ROLLBACK.sql";
const V1 = "0123456789abcdef0123456789abcdef", V2 = "fedcba9876543210fedcba9876543210";
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;

type Org = { organizationId: string; tenantId: string; connection: string };
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID();
  await owner.organization.create({ data: { id: organizationId, name, slug: `${name}-${suffix}` } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connection = await owner.providerConnection.create({ data: { organizationId, providerType: "MICROSOFT_ENTRA", externalScopeId: `d-${randomUUID()}`, name: "Federated" } });
  return { organizationId, tenantId, connection: connection.id };
}
const lock = (tx: Prisma.TransactionClient, org: Org) =>
  tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`resource-governance:${org.organizationId}:${org.tenantId}`}, 0))::text`;
const settle = (promise: Promise<unknown>) => promise.then((value) => value, (error: unknown) => error);
const text = (error: unknown) => String(error instanceof Error ? error.message : error);
/** Owner write under the governance lock (or without it, to check the guard). */
const write = <T>(org: Org, work: (tx: Prisma.TransactionClient) => Promise<T>, locked = true) =>
  owner.$transaction(async (tx) => { if (locked) await lock(tx, org); return work(tx); });
const insert = (org: Org, data: Partial<Prisma.ProviderSecretReferenceUncheckedCreateInput> = {}, locked = true) =>
  write(org, (tx) => tx.providerSecretReference.create({ data: { organizationId: org.organizationId, providerConnectionId: org.connection,
    purpose: "OIDC_CLIENT", store: "azure-key-vault", locator: "akv://luxia-app-kv/oidc-conn", activeVersion: V1, ...data } }), locked);
const ctx = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId, providerConnectionId: org.connection, operationId: randomUUID() });
function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("Provider secret references (F3, PostgreSQL)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("psra"); b = await organization("psrb");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("drill: the migration adds an empty table only; the rollback restores the previous state; it refuses once references exist", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_f3_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(c.relname::text || ':' || c.relkind::text, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(t.typname, ',' ORDER BY t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'`]).replace(/\r/g, "");
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(psqlOk(url, ["-c", `SELECT relrowsecurity || ':' || relforcerowsecurity FROM pg_class WHERE relname = 'ProviderSecretReference'`]).trim()).toBe("true:true");
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      psqlOk(url, ["-1", "-c", `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ('o1', 'Drill', 'drill-f3-${suffix}', now());
        INSERT INTO "Tenant" (id, "organizationId", name, "updatedAt") VALUES ('t1', 'o1', 'Production', now());
        INSERT INTO "ProviderConnection" (id, "organizationId", "providerType", "externalScopeId", name, "updatedAt") VALUES ('c1', 'o1', 'MICROSOFT_ENTRA', 'x', 'X', now());
        SELECT pg_advisory_xact_lock(hashtextextended('resource-governance:o1:t1', 0));
        INSERT INTO "ProviderSecretReference" (id, "organizationId", "providerConnectionId", purpose, store, locator, "activeVersion") VALUES ('r1', 'o1', 'c1', 'OIDC_CLIENT', 'azure-key-vault', 'akv://luxia-app-kv/oidc-c1', '${V1}');`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/ROLLBACK_REFUSED_SECRET_REFERENCES_IN_USE/);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 180_000);

  it("a reference points into a vault and cannot hold a value; versions are pinned; writes need the governance lock", async () => {
    const org = await organization("psrv");
    const refusals: Array<[Partial<Prisma.ProviderSecretReferenceUncheckedCreateInput>, RegExp]> = [
      [{ store: "environment", locator: "akv://luxia-app-kv/x" }, /ProviderSecretReference_store/],
      [{ locator: "env://ENTRA_AUTH_CLIENT_SECRET" }, /ProviderSecretReference_locator/],
      [{ locator: "s3cr3t~value.with+symbols" }, /ProviderSecretReference_locator/],
      [{ locator: "akv://luxia-app-kv/name?value=abc" }, /ProviderSecretReference_locator/],
      [{ locator: "akv://Luxia-App-KV/name" }, /ProviderSecretReference_locator/],
      [{ locator: "akv://luxia--kv/name" }, /ProviderSecretReference_locator/],
      [{ activeVersion: "latest" }, /ProviderSecretReference_versions/],
      [{ candidateVersion: V1 }, /ProviderSecretReference_versions/],
      [{ revokedAt: new Date() }, /PROVIDER_SECRET_REFERENCE_INITIAL/],
    ];
    for (const [data, error] of refusals) expect(text(await settle(insert(org, data))), JSON.stringify(data)).toMatch(error);
    expect(text(await settle(insert(org, {}, false)))).toMatch(/GOVERNANCE_LOCK_REQUIRED/);
    expect(await owner.providerSecretReference.count({ where: { organizationId: org.organizationId } })).toBe(0);
    await insert(org);
    expect(text(await settle(insert(org, { locator: "akv://luxia-app-kv/other" })))).toMatch(/ProviderSecretReference_live_key|Unique constraint/);
  });

  it("rotation only promotes the recorded candidate; identity is immutable; a revoked reference is frozen; nothing is deleted", async () => {
    const org = await organization("psrr");
    const ref = await insert(org);
    const update = (data: Prisma.ProviderSecretReferenceUncheckedUpdateInput, locked = true) => write(org, (tx) => tx.providerSecretReference.update({ where: { id: ref.id }, data }), locked);
    expect(text(await settle(update({ activeVersion: V2 })))).toMatch(/PROVIDER_SECRET_REFERENCE_PROMOTION_ONLY/);
    await update({ candidateVersion: V2 });
    expect(text(await settle(update({ activeVersion: V2 })))).toMatch(/PROVIDER_SECRET_REFERENCE_PROMOTION_ONLY/); // candidate must be cleared
    const promoted = await update({ activeVersion: V2, candidateVersion: null });
    expect(promoted).toMatchObject({ activeVersion: V2, candidateVersion: null, rotatedAt: expect.any(Date) });
    expect(text(await settle(update({ locator: "akv://luxia-app-kv/elsewhere" })))).toMatch(/PROVIDER_SECRET_REFERENCE_IMMUTABLE/);
    expect(text(await settle(update({ candidateVersion: V1 }, false)))).toMatch(/GOVERNANCE_LOCK_REQUIRED/);
    expect(text(await settle(owner.$executeRaw`DELETE FROM "ProviderSecretReference" WHERE id = ${ref.id}`))).toMatch(/PROVIDER_SECRET_REFERENCE_IMMUTABLE/);
    await update({ revokedAt: new Date() });
    expect(text(await settle(update({ candidateVersion: V1 })))).toMatch(/PROVIDER_SECRET_REFERENCE_REVOKED/);
    // After revocation, a new live reference may be recorded (for example in another store or vault).
    expect(await insert(org, { locator: "akv://luxia-app-kv2/oidc-conn" })).toMatchObject({ revokedAt: null });
  });

  it("forced RLS: the runtime reads and writes its own organization's references only; never deletes", async () => {
    await insert(a); await insert(b);
    expect(await rawPrisma.providerSecretReference.count({ where: { organizationId: { in: [a.organizationId, b.organizationId] } } })).toBe(0);
    const visible = await withTenantDb({ organizationId: a.organizationId, tenantId: a.tenantId }, (tx) =>
      tx.providerSecretReference.findMany({ where: { organizationId: { in: [a.organizationId, b.organizationId] } }, select: { organizationId: true } }));
    expect(visible.map((row) => row.organizationId)).toEqual([a.organizationId]);
    // Both organizations' governance locks are held, so the guard lets it through and row-level security is what refuses.
    const foreign = await settle(withTenantDb({ organizationId: a.organizationId, tenantId: a.tenantId }, async (tx) => {
      await lock(tx, a); await lock(tx, b);
      return tx.providerSecretReference.create({ data: { organizationId: b.organizationId, providerConnectionId: b.connection, purpose: "DIRECTORY",
        store: "azure-key-vault", locator: "akv://luxia-app-kv/foreign", activeVersion: V1 } });
    }));
    expect(text(foreign)).toMatch(/row-level security/);
    // A reference cannot point at another organization's connection (composite foreign key).
    expect(text(await settle(insert(a, { providerConnectionId: b.connection, purpose: "DIRECTORY" })))).toMatch(/ProviderSecretReference_connection_fkey|Foreign key/);
    expect(text(await settle(withTenantDb({ organizationId: a.organizationId, tenantId: a.tenantId }, (tx) =>
      tx.$executeRaw`DELETE FROM "ProviderSecretReference" WHERE "organizationId" = ${a.organizationId}`)))).toMatch(/permission denied/);
  });

  it("the store returns the live pinned reference of the context's connection, the candidate on request, nothing elsewhere", async () => {
    const org = await organization("psrs");
    const ref = await insert(org);
    expect(await connectionSecretReference(ctx(org), "OIDC_CLIENT")).toEqual({ key: "akv://luxia-app-kv/oidc-conn", version: V1 });
    expect(await connectionSecretReference(ctx(org), "OIDC_CLIENT", "candidate")).toBeNull();
    expect(await connectionSecretReference(ctx(org), "DIRECTORY")).toBeNull();
    await write(org, (tx) => tx.providerSecretReference.update({ where: { id: ref.id }, data: { candidateVersion: V2 } }));
    expect(await connectionSecretReference(ctx(org), "OIDC_CLIENT", "candidate")).toEqual({ key: "akv://luxia-app-kv/oidc-conn", version: V2 });
    // Another organization's context never sees it, even naming this connection.
    expect(await connectionSecretReference({ ...ctx(b), providerConnectionId: org.connection }, "OIDC_CLIENT")).toBeNull();
    await write(org, (tx) => tx.providerSecretReference.update({ where: { id: ref.id }, data: { revokedAt: new Date() } }));
    expect(await connectionSecretReference(ctx(org), "OIDC_CLIENT")).toBeNull();
  });
});
