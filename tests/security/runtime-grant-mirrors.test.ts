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
  // The default privileges for future tables are not a narrowing; both sides set them and are compared below.
  const isDefault = (line: string) => line.startsWith("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES") || line.startsWith("GRANT USAGE, SELECT ON SEQUENCES");
  const bootstrapText = read("scripts/ci/bootstrap-app-user.sql");
  const bootstrap = narrowing(bootstrapText).filter((line) => !isDefault(line));
  const gateText = read(".github/workflows/production-activation-gate.yml");
  const block = /Bootstrap least-privilege runtime grants[\s\S]*?<<'SQL'\n([\s\S]*?)\n\s*SQL\n/.exec(gateText)?.[1] ?? "";
  const gate = narrowing(block).filter((line) => !isDefault(line));

  it("the same table and sequence narrowing, statement for statement", () => {
    expect(bootstrap.length).toBeGreaterThan(5);
    expect(gate).toEqual(bootstrap);
  });

  // The G4 post-restore command compares a restored copy with a reference given the gate's grants; CI's copy only
  // matched once the bootstrap set the same default privileges (review of #195).
  it("the same default privileges for tables and sequences created later", () => {
    const defaults = (text: string) => text.replace(/\s+/g, " ").match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT [A-Z, ]+ ON (TABLES|SEQUENCES) TO app_user;/g)?.sort() ?? [];
    expect(defaults(bootstrapText)).toHaveLength(2);
    expect(defaults(bootstrapText)).toEqual(defaults(block));
  });

  it("every owner-only table, the erasure record included, is taken back from the runtime role", () => {
    for (const statement of ['REVOKE ALL ON "OrganizationErasure" FROM app_user;', 'REVOKE ALL ON SEQUENCE "OrganizationErasure_id_seq" FROM app_user;',
      'REVOKE ALL ON "RetentionRun" FROM app_user;', 'REVOKE ALL ON SEQUENCE "RetentionRun_id_seq" FROM app_user;',
      'REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user;', 'REVOKE DELETE, TRUNCATE ON "ProviderSecretReference" FROM app_user;'])
      expect(gate, statement).toContain(statement);
  });
});
