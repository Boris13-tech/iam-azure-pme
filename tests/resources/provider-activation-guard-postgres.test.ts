import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// F4, slice S5: migration 20261016110000 (database order and clock for test runs, the activation evidence function and
// the activation guard). Its rollback is drilled on a scratch database: exact restore, refusal once in use, re-apply.
// The behaviour of the guard is proven in tests/resources/provider-connection-proof-postgres.test.ts.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261016110000_provider_activation_guard";
const ROLLBACK = "docs/operations/PROVIDER-ACTIVATION-GUARD-ROLLBACK.sql";
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

describe.runIf(enabled)("F4 S5: activation guard migration (PostgreSQL)", () => {
  it("drill: the rollback restores the previous state exactly, refuses once in use, and the migration applies again", () => {
    if (!process.env.DATABASE_MIGRATION_URL) throw new Error("ISOLATED_DB_REQUIRED");
    const admin = process.env.DATABASE_MIGRATION_URL;
    const name = `luxia_f4s5_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const state = () => psqlOk(url, [
      "-c", `SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(is_identity, ''), ',' ORDER BY column_name)
             FROM information_schema.columns WHERE table_name = 'ProviderTestRun'`,
      "-c", `SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'ProviderTestRun'`,
      "-c", `SELECT string_agg(pg_get_triggerdef(oid), ' | ' ORDER BY tgname) FROM pg_trigger
             WHERE NOT tgisinternal AND tgrelid IN ('"ProviderTestRun"'::regclass, '"ProviderConnection"'::regclass)`,
      "-c", `SELECT string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE proname LIKE 'luxia_provider_%'`,
    ]).replace(/\r/g, "").trim();
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = state();
      expect(before).not.toMatch(/sequence|provider_test_run_stamp|activation/);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      const after = state();
      expect(after).toContain("sequence:bigint:NO:YES");
      expect(after).toContain("ProviderTestRun_sequence_key");
      expect(after).toContain("provider_connection_activation_guard");
      expect(after).toContain("luxia_provider_activation_evidence");
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(state()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(state()).toBe(after);
      // Once a test run exists (its database order would be lost), the rollback refuses and changes nothing.
      const org = randomUUID(); const connection = randomUUID();
      psqlOk(url, ["-1", "-c", `INSERT INTO "Organization" (id, name, slug, "updatedAt") VALUES ('${org}', 'Drill', 'drill-${suffix}', now());
        INSERT INTO "ProviderConnection" (id, "organizationId", "providerType", "externalScopeId", name, status, "updatedAt")
          VALUES ('${connection}', '${org}', 'OIDC_GENERIC', 'x', 'Drill', 'DRAFT', now());
        INSERT INTO "ProviderTestRun" (id, "organizationId", "providerConnectionId", kind, outcome, "reasonCode", "configurationHash", "actorSubjectId")
          VALUES ('${randomUUID()}', '${org}', '${connection}', 'DISCOVERY', 'PASSED', 'DISCOVERY_PASSED', '${"a".repeat(64)}', 'drill');`]);
      const refused = psql(url, ["-1", "-f", ROLLBACK]);
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("ROLLBACK_REFUSED_ACTIVATION_GUARD_IN_USE");
      expect(state()).toBe(after);
    } finally {
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
