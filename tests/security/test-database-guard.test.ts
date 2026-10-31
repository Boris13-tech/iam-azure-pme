import { readdirSync, readFileSync } from "node:fs";
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
      [local("luxia_db"), `${local("luxia_db")}&host=remote.example.test`],
      [`${local("luxia_db")}&hostaddr=192.0.2.1`, local("luxia_db")],
      [local("luxia_db"), undefined],
    ]) expect(() => assertTestDatabase(on(runtime, owner)), `${runtime} ${owner}`).toThrow("ISOLATED_DB_REQUIRED");
  });

  it("the default port counts as 5432", () => {
    expect(() => assertTestDatabase(on("postgresql://u:p@localhost/luxia_db", local("luxia_db", 5432)))).not.toThrow();
  });

  it("no flag or endpoint opens neondb", () => {
    const clone = { DATABASE_URL: "postgresql://app_user:p@ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech/neondb",
      DATABASE_MIGRATION_URL: "postgresql://neondb_owner:p@ep-weathered-grass-ah5vrehj.c-3.us-east-1.aws.neon.tech/neondb" };
    for (const flag of ["LUXIA_PRODUCTION_RUNNER_CERTIFICATION", "LUXIA_PRODUCTION_RUNNER_NEGATIVES"])
      expect(() => assertTestDatabase({ LUXIA_RESOURCE_RLS: "true", ...clone, [flag]: "true" })).toThrow("ISOLATED_DB_REQUIRED");
  });

  it("does nothing when the PostgreSQL suites are off", () => {
    expect(() => assertTestDatabase({ DATABASE_URL: local("neondb") })).not.toThrow();
  });

  it("no test file sits at the root of tests/: CI selects by folder and would never run it", () => {
    expect(readdirSync("tests").filter((name) => name.endsWith(".test.ts"))).toEqual([]);
  });

  it("every test file goes through it", () => {
    expect(readFileSync("vitest.config.ts", "utf8")).toContain('setupFiles: ["./tests/helpers/require-test-database.ts"]');
  });
});
