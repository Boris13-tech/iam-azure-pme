// The runtime role's table privileges are set in two places: the CI bootstrap (scripts/ci/bootstrap-app-user.sql), which
// every PostgreSQL suite runs against, and the Production activation gate, which applies the migrations to Production
// and then re-grants broadly before narrowing. Both start with the same broad grant, so every narrowing must be in
// both: one missing in the gate silently widens Production after each activation, while CI keeps passing.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const BROAD_TABLES = "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;";
const BROAD_SEQUENCES = "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;";

/** Table and sequence statements made after the broad grant, normalized; function, schema and database grants left out. */
function narrowing(text: string): string[] {
  const statements = text.split("\n").map((line) => line.trim()).filter((line) => /^(GRANT|REVOKE) /.test(line));
  const start = statements.indexOf(BROAD_TABLES);
  expect(start, "broad table grant").toBeGreaterThanOrEqual(0);
  expect(statements).toContain(BROAD_SEQUENCES);
  return statements.slice(start + 1)
    .filter((line) => line !== BROAD_SEQUENCES && !/ ON (FUNCTION|DATABASE|SCHEMA) /.test(line))
    .sort();
}

describe("runtime grants: the CI bootstrap and the Production activation gate narrow the same way", () => {
  const bootstrap = narrowing(read("scripts/ci/bootstrap-app-user.sql"));
  const gateText = read(".github/workflows/production-activation-gate.yml");
  const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gateText)?.[1] ?? "";
  // The gate's default privileges for future tables are its own (CI creates app_user after the migrations).
  const gate = narrowing(block).filter((line) => !line.startsWith("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES")
    && !line.startsWith("GRANT USAGE, SELECT ON SEQUENCES"));

  it("the same table and sequence narrowing, statement for statement", () => {
    expect(bootstrap.length).toBeGreaterThan(5);
    expect(gate).toEqual(bootstrap);
  });

  it("every owner-only table, the erasure record included, is taken back from the runtime role", () => {
    for (const statement of ['REVOKE ALL ON "OrganizationErasure" FROM app_user;', 'REVOKE ALL ON SEQUENCE "OrganizationErasure_id_seq" FROM app_user;',
      'REVOKE ALL ON "RetentionRun" FROM app_user;', 'REVOKE ALL ON SEQUENCE "RetentionRun_id_seq" FROM app_user;',
      'REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user;', 'REVOKE DELETE, TRUNCATE ON "ProviderSecretReference" FROM app_user;'])
      expect(gate, statement).toContain(statement);
  });
});
