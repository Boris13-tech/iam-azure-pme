import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertTestDatabase } from "../helpers/require-test-database";

const on = (runtime: string | undefined, owner: string | undefined) => ({ LUXIA_RESOURCE_RLS: "true", DATABASE_URL: runtime, DATABASE_MIGRATION_URL: owner });
const local = (name: string, port = 5432) => `postgresql://u:p@localhost:${port}/${name}?schema=public`;

describe("the PostgreSQL suites run only against a test database", () => {
  it("accepts the same luxia_* database, locally or on a certification clone through its pooler", () => {
    expect(() => assertTestDatabase(on(local("luxia_db"), local("luxia_db")))).not.toThrow();
    expect(() => assertTestDatabase(on("postgresql://u:p@ep-x-pooler.eu.neon.tech/luxia_cert", "postgresql://u:p@ep-x.eu.neon.tech/luxia_cert"))).not.toThrow();
  });

  it("refuses Production's name, mixed databases, mixed servers and a missing URL", () => {
    for (const [runtime, owner] of [
      [local("neondb"), local("neondb")],
      [local("luxia_db"), local("neondb")],
      [local("neondb"), local("luxia_db")],
      [local("luxia_a"), local("luxia_b")],
      [local("luxia_db"), "postgresql://u:p@ep-prod.eu.neon.tech/luxia_db"],
      [local("luxia_db", 5432), local("luxia_db", 5433)],
      ["postgresql://u:p@localhost/luxia_db", local("luxia_db", 5433)],
      [undefined, local("luxia_db")],
      [local("luxia_db"), undefined],
    ]) expect(() => assertTestDatabase(on(runtime, owner)), `${runtime} ${owner}`).toThrow("ISOLATED_DB_REQUIRED");
  });

  const runner = { LUXIA_RESOURCE_RLS: "true", LUXIA_PRODUCTION_RUNNER_CERTIFICATION: "true",
    DATABASE_URL: "postgresql://app_user:p@ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech/neondb",
    DATABASE_MIGRATION_URL: "postgresql://neondb_owner:p@ep-weathered-grass-ah5vrehj.c-3.us-east-1.aws.neon.tech/neondb" };

  it("the default port counts as 5432", () => {
    expect(() => assertTestDatabase(on("postgresql://u:p@localhost/luxia_db", local("luxia_db", 5432)))).not.toThrow();
  });

  it("the registered certification runner may use neondb, on its exact endpoint and roles, in exactly one of its modes", () => {
    expect(() => assertTestDatabase(runner)).not.toThrow();
    expect(() => assertTestDatabase({ ...runner, LUXIA_PRODUCTION_RUNNER_CERTIFICATION: undefined, LUXIA_PRODUCTION_RUNNER_NEGATIVES: "true" })).not.toThrow();
    for (const changed of [
      { LUXIA_PRODUCTION_RUNNER_CERTIFICATION: undefined },
      { LUXIA_PRODUCTION_RUNNER_NEGATIVES: "true" },
      { DATABASE_URL: runner.DATABASE_URL.replace("weathered-grass", "other"), DATABASE_MIGRATION_URL: runner.DATABASE_MIGRATION_URL.replace("weathered-grass", "other") },
      { DATABASE_URL: runner.DATABASE_URL.replace("app_user", "neondb_owner") },
      { DATABASE_MIGRATION_URL: runner.DATABASE_MIGRATION_URL.replace("neondb_owner", "someone") },
    ]) expect(() => assertTestDatabase({ ...runner, ...changed }), JSON.stringify(changed)).toThrow("ISOLATED_DB_REQUIRED");
  });

  it("does nothing when the PostgreSQL suites are off", () => {
    expect(() => assertTestDatabase({ DATABASE_URL: local("neondb") })).not.toThrow();
  });

  it("every test file goes through it", () => {
    expect(readFileSync("vitest.config.ts", "utf8")).toContain('setupFiles: ["./tests/helpers/require-test-database.ts"]');
  });
});
