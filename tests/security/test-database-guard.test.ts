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
      [undefined, local("luxia_db")],
      [local("luxia_db"), undefined],
    ]) expect(() => assertTestDatabase(on(runtime, owner)), `${runtime} ${owner}`).toThrow("ISOLATED_DB_REQUIRED");
  });

  it("does nothing when the PostgreSQL suites are off", () => {
    expect(() => assertTestDatabase({ DATABASE_URL: local("neondb") })).not.toThrow();
  });

  it("every test file goes through it", () => {
    expect(readFileSync("vitest.config.ts", "utf8")).toContain('setupFiles: ["./tests/helpers/require-test-database.ts"]');
  });
});
