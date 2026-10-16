import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// F4, slice S4: migration 20261016100000 (AuthTransaction bound to a configuration hash). Expand only, with its rollback
// drilled on a scratch database: exact restore, refusal once in use, and a clean re-apply.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261016100000_auth_transaction_configuration_binding";
const ROLLBACK = "docs/operations/AUTH-TRANSACTION-CONFIGURATION-BINDING-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}

describe.runIf(enabled)("F4 S4: AuthTransaction configuration binding (PostgreSQL)", () => {
  let owner: PrismaClient;
  beforeAll(() => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await owner?.$disconnect(); });

  it("the column accepts NULL (Microsoft) or a 64-hex hash only", async () => {
    const insert = (hash: string | null) => owner.authTransaction.create({ data: {
      id: randomUUID().replace(/-/g, ""), stateHash: `binding-${randomUUID()}`, nonce: "n", codeVerifier: "v", expectedOrganizationId: "o",
      expectedTenantId: "t", expectedProviderConnectionId: "p", expectedConfigurationHash: hash, expiresAt: new Date(Date.now() + 60_000) } })
      .then(() => "ACCEPTED", (error: unknown) => String((error as { message?: string }).message ?? error));
    expect(await insert(null)).toBe("ACCEPTED");
    expect(await insert("0123456789abcdef".repeat(4))).toBe("ACCEPTED");
    for (const bad of ["", "A".repeat(64), "0".repeat(63), "0".repeat(65), "g".repeat(64)]) {
      expect(await insert(bad)).toContain("AuthTransaction_expectedConfigurationHash");
    }
  });

  it("drill: the rollback restores the previous state exactly, refuses once in use, and the migration applies again", () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    const name = `luxia_f4s4_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psqlOk(url, [
      "-c", `SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_name = 'AuthTransaction'`,
      "-c", `SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = '"AuthTransaction"'::regclass`,
    ]).replace(/\r/g, "").trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = state();
      expect(before).not.toContain("expectedConfigurationHash");
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      const after = state();
      expect(after).toContain("expectedConfigurationHash:text:YES");
      expect(after).toContain("AuthTransaction_expectedConfigurationHash");
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(state()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(state()).toBe(after);
      // Once a generic round trip has started (a transaction carries a hash), the rollback refuses and changes nothing.
      psqlOk(url, ["-1", "-c", `INSERT INTO "AuthTransaction" (id, "stateHash", nonce, "codeVerifier", "expectedOrganizationId", "expectedTenantId",
        "expectedProviderConnectionId", "expectedConfigurationHash", "expiresAt") VALUES ('${randomUUID().replace(/-/g, "")}', 'drill', 'n', 'v', 'o', 't', 'p', '${"a".repeat(64)}', now())`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("ROLLBACK_REFUSED_CONFIGURATION_BINDING_IN_USE");
      expect(state()).toBe(after);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
