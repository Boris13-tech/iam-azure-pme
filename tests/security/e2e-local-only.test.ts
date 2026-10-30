import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ownerDatabaseUrl } from "../e2e/support/local-db";

const saved = process.env.E2E_OWNER_DATABASE_URL;
afterEach(() => { if (saved === undefined) delete process.env.E2E_OWNER_DATABASE_URL; else process.env.E2E_OWNER_DATABASE_URL = saved; });

describe("the end-to-end suite writes to a local database and a local server only", () => {
  it("accepts a local owner URL", () => {
    process.env.E2E_OWNER_DATABASE_URL = "postgresql://u:p@127.0.0.1:5432/luxia_db?schema=public";
    expect(ownerDatabaseUrl()).toBe(process.env.E2E_OWNER_DATABASE_URL);
  });

  it("refuses a remote host, and a parameter that overrides the host", () => {
    for (const url of ["postgresql://u:p@db.example.test:5432/luxia_db", "postgresql://u:p@localhost:5432/luxia_db?host=db.example.test", "postgresql://u:p@localhost:5432/luxia_db?hostaddr=192.0.2.1"]) {
      process.env.E2E_OWNER_DATABASE_URL = url;
      expect(() => ownerDatabaseUrl(), url).toThrow(/NOT_LOCAL/);
    }
  });

  it("the browser's base URL must be local", () => {
    expect(readFileSync("playwright.config.ts", "utf8")).toContain("E2E_BASE_URL_NOT_LOCAL");
  });
});
