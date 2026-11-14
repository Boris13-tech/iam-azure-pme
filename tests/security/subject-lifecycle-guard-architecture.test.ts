// Issue #148: the lifecycle guard's transition table lives in two places, the application's (lib/identity/semantics.ts)
// and the database's (the migration). They must say the same thing, or the database would refuse a transition the
// application allows, or allow one it refuses. This test reads the table out of the SQL and compares it, state by state.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUBJECT_LIFECYCLE_STATES, canTransitionSubject } from "../../lib/identity/semantics";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const MIGRATION = "prisma/migrations/20261114090000_subject_lifecycle_guard/migration.sql";
const migration = read(MIGRATION);
const rollback = read("docs/operations/SUBJECT-LIFECYCLE-GUARD-ROLLBACK.sql");

/** The CASE arms of the guard, as {from: [to, ...]}; an empty ARRAY[] is a terminal state. */
function sqlTransitions(): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const [, from, body] of migration.matchAll(/WHEN '(\w+)'\s*THEN ARRAY(\[[^\]]*\])/g))
    table[from] = [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  return table;
}

describe("#148: the database's transition table is the application's", () => {
  it("every state is an arm of the CASE, so no state falls through to NULL unguarded", () => {
    expect(Object.keys(sqlTransitions()).sort()).toEqual([...SUBJECT_LIFECYCLE_STATES].sort());
    // A state added to the application without an arm would make v_allowed NULL: the guard refuses, it never allows.
    expect(migration).toContain("IF NEW.\"lifecycleState\" IS NULL OR v_allowed IS NULL OR NOT (NEW.\"lifecycleState\"::text = ANY (v_allowed)) THEN");
  });

  it("each arm lists exactly the transitions the application allows, and RETIRED is terminal in both", () => {
    const table = sqlTransitions();
    for (const from of SUBJECT_LIFECYCLE_STATES) {
      const allowed = SUBJECT_LIFECYCLE_STATES.filter((to) => to !== from && canTransitionSubject(from, to));
      expect([...table[from]].sort(), from).toEqual([...allowed].sort());
    }
    expect(table.RETIRED).toEqual([]);
    expect(canTransitionSubject("RETIRED", "ACTIVE")).toBe(false);
  });

  it("the database stamps the date and the version, and refuses a change without a state change", () => {
    const guard = /CREATE FUNCTION luxia_subject_lifecycle_guard[\s\S]*?\nEND \$\$;/.exec(migration)![0];
    for (const text of [`NEW."lifecycleChangedAt" := v_now;`, `NEW."lifecycleVersion" := 1;`, `NEW."lifecycleVersion" := OLD."lifecycleVersion" + 1;`,
      "SUBJECT_LIFECYCLE_DATE_IMMUTABLE", "SUBJECT_LIFECYCLE_VERSION_IMMUTABLE", "SUBJECT_LIFECYCLE_TRANSITION_INVALID",
      `v_now TIMESTAMP(3) := (clock_timestamp() AT TIME ZONE 'UTC')`]) expect(guard, text).toContain(text);
    // The stamp is the statement's time, not the transaction's: now() would let an old transaction age a fresh
    // retirement and make it eligible for R6 at once (Codex, review of #194). Read on the code, comments aside.
    const code = guard.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
    expect(code).not.toMatch(/\bnow\(\)/);
    expect(code).toMatch(/clock_timestamp\(\) AT TIME ZONE 'UTC'/);
    // Not a definer function: it runs with the privileges of whoever writes the row, and only ever changes NEW, so it
    // needs none of its own. It is never granted either, so no one can call it outside the trigger.
    expect(guard).not.toMatch(/SECURITY DEFINER/);
    expect(migration).toContain("REVOKE ALL ON FUNCTION luxia_subject_lifecycle_guard() FROM PUBLIC;");
    expect(migration).not.toMatch(/GRANT /);
    expect(migration).toContain(`CREATE TRIGGER subject_lifecycle_guard BEFORE INSERT OR UPDATE ON "Subject"`);
  });

  it("the rollback removes exactly the guard, warns that R6 must not enforce without it, and refuses if it is not the last migration", () => {
    expect(rollback).toContain("DROP TRIGGER IF EXISTS subject_lifecycle_guard ON \"Subject\";");
    expect(rollback).toContain("DROP FUNCTION IF EXISTS luxia_subject_lifecycle_guard();");
    expect(rollback).toContain("R6 MUST NOT ENFORCE WITHOUT THIS GUARD");
    expect(rollback).toContain("ROLLBACK_NOT_LATEST_MIGRATION");
    expect(rollback).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114090000_subject_lifecycle_guard';`);
  });

  it("the application no longer sends a lifecycle date of its own: the database is the only writer", () => {
    for (const path of ["lib/admin/canonical-administration.ts", "lib/onboarding/invitations.ts"]) {
      const source = read(path);
      expect(source, path).not.toMatch(/lifecycleChangedAt\s*:/);
      expect(source, path).not.toMatch(/lifecycleVersion\s*:/);
    }
  });
});
