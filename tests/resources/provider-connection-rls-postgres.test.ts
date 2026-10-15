import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { resolveLoginOrganization } from "../../lib/auth/organization-login";

// Sovereign providers F2, M2: forced row-level security on ProviderConnection (design 4.7, finding M3).
// app_user (rawPrisma) is the runtime: a connection exists for it only inside its organization's scope.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261014100000_provider_connection_rls";
const ROLLBACK = "docs/operations/PROVIDER-CONNECTION-RLS-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);
let owner: PrismaClient;

type Org = { organizationId: string; tenantId: string; slug: string; connection: string };
async function organization(name: string): Promise<Org> {
  const organizationId = randomUUID(); const tenantId = randomUUID(); const slug = `${name}-${suffix}`;
  await owner.organization.create({ data: { id: organizationId, name, slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connection = await owner.providerConnection.create({ data: { organizationId, providerType: "LUXIA_LOCAL", status: "ACTIVE", externalScopeId: tenantId, name: "LUXIA Local" } });
  await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
  return { organizationId, tenantId, slug, connection: connection.id };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const settle = (promise: Promise<unknown>) => promise.then((value) => value, (error: unknown) => error);
const text = (error: unknown) => String(error instanceof Error ? error.message : error);
function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("ProviderConnection forced row-level security (PostgreSQL, app_user)", () => {
  let a: Org, b: Org;
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
    a = await organization("rlsa"); b = await organization("rlsb");
  }, 120_000);
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("row-level security is enabled and forced, with the organization policy", async () => {
    const [flags] = await owner.$queryRaw<Array<{ enabled: boolean; forced: boolean }>>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = '"ProviderConnection"'::regclass`;
    expect(flags).toEqual({ enabled: true, forced: true });
    const policies = await owner.$queryRaw<Array<{ policyname: string }>>`SELECT policyname FROM pg_policies WHERE tablename = 'ProviderConnection'`;
    expect(policies.map((row) => row.policyname)).toEqual(["provider_connection_organization_isolation"]);
  });

  it("outside any scope the runtime sees no connection; inside one, only its organization's", async () => {
    expect(await rawPrisma.providerConnection.count({ where: { id: { in: [a.connection, b.connection] } } })).toBe(0);
    const visible = await withTenantDb(scope(a), (tx) => tx.providerConnection.findMany({ where: { id: { in: [a.connection, b.connection] } }, select: { id: true } }));
    expect(visible.map((row) => row.id)).toEqual([a.connection]);
    // A relation read follows the same rule.
    const account = await withTenantDb(scope(a), (tx) => tx.providerConnection.findFirst({ where: { id: b.connection } }));
    expect(account).toBeNull();
  });

  it("the runtime cannot create or change another organization's connection", async () => {
    expect(text(await settle(withTenantDb(scope(a), (tx) => tx.providerConnection.create({ data: { organizationId: b.organizationId, providerType: "MICROSOFT_ENTRA", status: "DRAFT", externalScopeId: `x-${randomUUID()}`, name: "Foreign" } })))))
      .toMatch(/row-level security|violates row-level security policy/);
    const changed = await withTenantDb(scope(a), (tx) => tx.providerConnection.updateMany({ where: { id: b.connection }, data: { name: "Taken" } }));
    expect(changed.count).toBe(0);
    expect((await owner.providerConnection.findUniqueOrThrow({ where: { id: b.connection } })).name).toBe("LUXIA Local");
  });

  it("sign-in still resolves the organization's connections (read inside its scope)", async () => {
    expect(await resolveLoginOrganization(a.slug)).toMatchObject({ organizationId: a.organizationId, localConnectionId: a.connection });
  });

  it("drill: the rollback restores the previous state exactly, and the migration applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_m2_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psqlOk(url, ["-c", `SELECT relrowsecurity || ':' || relforcerowsecurity FROM pg_class WHERE relname = 'ProviderConnection'`,
      "-c", `SELECT count(*) FROM pg_policies WHERE tablename = 'ProviderConnection'`]).replace(/\r/g, "").trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = state();
      expect(before).toBe("false:false\n0");
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(state()).toBe("true:true\n1");
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(state()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(state()).toBe("true:true\n1");
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 180_000);
});
