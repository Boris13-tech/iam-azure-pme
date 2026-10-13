import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// T0, audit integrity: static checks. The PostgreSQL suite (tests/resources/audit-append-only-postgres.test.ts)
// proves the same rules on a real database.
const root = join(__dirname, "../..");
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const MIGRATION = "prisma/migrations/20261013090000_audit_append_only/migration.sql";
const ROLLBACK = "docs/operations/T0-AUDIT-APPEND-ONLY-ROLLBACK.sql";
const TRIGGERS = [
  ["audit_append_only", "BEFORE UPDATE OR DELETE", "CanonicalAdminAuditEvent", "FOR EACH ROW"],
  ["audit_append_only_truncate", "BEFORE TRUNCATE", "CanonicalAdminAuditEvent", "FOR EACH STATEMENT"],
  ["evidence_append_only", "BEFORE UPDATE OR DELETE", "AuthenticationEvidence", "FOR EACH ROW"],
  ["evidence_append_only_truncate", "BEFORE TRUNCATE", "AuthenticationEvidence", "FOR EACH STATEMENT"],
] as const;

describe("T0 append-only audit trail", () => {
  it("the migration guards both tables against every UPDATE, DELETE and TRUNCATE, and changes no data", () => {
    const sql = read(MIGRATION);
    for (const [name, when, table, level] of TRIGGERS)
      expect(sql.replace(/\s+/g, " "), name).toContain(`CREATE TRIGGER ${name} ${when} ON "${table}" ${level} EXECUTE FUNCTION luxia_audit_append_only();`);
    expect(sql).toContain("RAISE EXCEPTION 'AUDIT_APPEND_ONLY'");
    expect(sql).toContain(`REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM app_user;`);
    expect(sql).toContain(`REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM PUBLIC;`);
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO|DROP|GRANT)\s+"/);
    expect(code).not.toMatch(/\bimmutable\b/i);
  });

  it("the rollback restores the previous state exactly: guards removed, UPDATE and DELETE given back to app_user", () => {
    const sql = read(ROLLBACK).replace(/--.*$/gm, "");
    for (const [name, , table] of TRIGGERS) expect(sql).toContain(`DROP TRIGGER IF EXISTS ${name} ON "${table}";`);
    expect(sql).toContain("DROP FUNCTION IF EXISTS luxia_audit_append_only();");
    expect(sql).toContain(`GRANT UPDATE, DELETE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" TO app_user;`);
    expect(sql).not.toMatch(/TRUNCATE/);
    expect(sql).not.toMatch(/resource_onboarding_evidence_immutable/);
  });

  it("the CI and Production runtime-role bootstraps never give the rights back", () => {
    const revoke = `REVOKE UPDATE, DELETE, TRUNCATE ON "CanonicalAdminAuditEvent", "AuthenticationEvidence" FROM app_user;`;
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/production-activation-gate.yml"]) {
      const text = read(workflow);
      expect(text, workflow).toContain(revoke);
      expect(text.indexOf(revoke), workflow).toBeGreaterThan(text.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;"));
    }
  });

  it("no application or operator code updates, upserts or deletes journal or evidence rows", () => {
    const offenders = ["lib", "app"].flatMap((dir) => sources(join(root, dir)))
      .filter((path) => /\b(canonicalAdminAuditEvent|authenticationEvidence)\.(update|updateMany|upsert|delete|deleteMany)\(|(UPDATE|DELETE FROM|TRUNCATE)\s+"(CanonicalAdminAuditEvent|AuthenticationEvidence)"/
        .test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
    // Tests clean up only through the superuser-only helper, which Production cannot use.
    const helper = read("tests/helpers/purge-test-organization.ts");
    expect(helper).toContain("SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user");
    expect(helper.indexOf("rolsuper")).toBeLessThan(helper.indexOf("SET LOCAL session_replication_role = replica"));
  });
});
