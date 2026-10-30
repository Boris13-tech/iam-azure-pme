import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkErasurePlan, ERASURE_PLAN_VALIDITY_MS, ERASURE_TABLES, ErasureRefusal, type ErasurePlan } from "../../lib/operators/organization-erasure";
import { planDigest } from "../../lib/operators/break-glass";

// R7: static checks of the organization erasure migration, its rollback and the operator plan.
const NEW = "20261023140000_organization_erasure";
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const migration = read(`prisma/migrations/${NEW}/migration.sql`);
const rollback = read("docs/operations/ORGANIZATION-ERASURE-ROLLBACK.sql");
const GUARDS = ["luxia_review_immutable_guard", "luxia_resource_onboarding_evidence_guard", "luxia_signup_code_guard",
  "luxia_invitation_guard", "luxia_organization_domain_guard", "luxia_recovery_code_guard", "luxia_audit_append_only",
  "luxia_provider_connection_guard", "luxia_provider_secret_reference_guard"];
const GATE = `  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
`;
function fn(sql: string, name: string) {
  const matches = [...sql.matchAll(new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`, "g"))];
  if (!matches.length) throw new Error(`missing ${name}`);
  const start = matches[matches.length - 1].index!;
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2).replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, "CREATE FUNCTION ");
}
/** The latest definition of a function before this migration. */
function previous(name: string) {
  const dirs = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
  let found = "";
  for (const dir of dirs) {
    const sql = read(`prisma/migrations/${dir}/migration.sql`);
    if (new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`).test(sql)) found = fn(sql, name);
  }
  return found;
}

describe("R7 organization erasure: migration architecture", () => {
  it("each guard is its previous body plus the erasure gate only, placed first", () => {
    for (const name of GUARDS) {
      const now = fn(migration, name);
      expect(now.split(GATE), name).toHaveLength(2);
      expect(now.replace(GATE, ""), name).toBe(previous(name));
      expect(now.indexOf(GATE), name).toBe(now.indexOf("\nBEGIN\n") + "\nBEGIN\n".length);
    }
  });

  it("the gate needs the marker, the table owner and a CLOSED organization; TRUNCATE and UPDATE are never let through", () => {
    const allowed = fn(migration, "luxia_erasure_allowed");
    expect(allowed).toContain("current_setting('luxia.erasure_organization', true) = p_organization_id");
    expect(allowed).toContain("c.relowner WHERE c.oid = p_relation AND r.rolname = current_user");
    expect(allowed).toContain("AND current_user = session_user");
    expect(allowed).toContain(`o."status" = 'CLOSED'`);
    expect(allowed).not.toMatch(/SECURITY DEFINER/);
    expect(GATE).toMatch(/^ {2}IF TG_OP = 'DELETE' AND /m);
  });

  it("the erasure covers every table that has an organizationId, in the order the code plans, and checks completeness", () => {
    const array = /v_tables CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/.exec(migration)![1];
    expect([...array.matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([...ERASURE_TABLES]);
    const schema = read("prisma/schema.prisma");
    const scoped = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+organizationId\s/m.test(body)).map(([, name]) => name)
      // OrganizationErasure outlives the organization. LegacyUserBridge is never erased: its presence refuses the erasure.
      .filter((name) => name !== "OrganizationErasure" && name !== "LegacyUserBridge");
    expect([...scoped].sort()).toEqual([...ERASURE_TABLES].sort());
    const erase = fn(migration, "luxia_organization_erase");
    for (const text of ["ERASURE_REQUIRES_BYPASSRLS", "ERASURE_ORGANIZATION_NOT_CLOSED", "ERASURE_LEGACY_DATA_PRESENT", "ERASURE_INCOMPLETE", `"expectedOrganizationId" = p_organization_id`,
      "format('DELETE FROM %I WHERE \"organizationId\" = $1', v_table) USING p_organization_id", "FOR UPDATE"])
      expect(erase).toContain(text);
    expect(erase).not.toMatch(/SECURITY DEFINER/);
    expect(migration).not.toMatch(/GRANT /);
    for (const name of ["luxia_erasure_allowed(TEXT, OID)", "luxia_organization_erase(TEXT)"]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${name} FROM PUBLIC;`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${name} FROM app_user;`);
    }
    expect(migration).toContain('REVOKE ALL ON "OrganizationErasure" FROM app_user;');
  });

  it("no SECURITY DEFINER function deletes from a table whose guard has the erasure gate (defence in depth)", () => {
    const guarded = ["AccessReviewCampaign", "AccessReviewItem", "CanonicalAdminAuditEvent", "SignupCode", "Invitation", "OrganizationDomain",
      "LocalRecoveryCode", "AuthenticationEvidence", "ProviderConnection", "ProviderSecretReference"];
    const latest = new Map<string, string>();
    for (const dir of readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort()) {
      const sql = read(`prisma/migrations/${dir}/migration.sql`);
      for (const m of sql.matchAll(/CREATE (OR REPLACE )?FUNCTION (public\.)?(\w+)\(/g)) latest.set(m[3], fn(sql, m[3]));
    }
    for (const [name, body] of latest) {
      if (!/SECURITY DEFINER/.test(body.slice(0, body.indexOf("$$")))) continue;
      expect(body, name).not.toMatch(/EXECUTE\s+format\(\s*'DELETE/i);
      for (const table of guarded) expect(body, `${name} deletes from ${table}`).not.toContain(`DELETE FROM "${table}"`);
    }
  });

  it("the rollback restores every guard exactly, refuses once an erasure is recorded, and removes the rest", () => {
    for (const name of GUARDS) expect(fn(rollback, name), name).toBe(previous(name));
    expect(rollback).toContain("ROLLBACK_REFUSED_ERASURE_RECORDED");
    for (const text of ["DROP FUNCTION luxia_organization_erase(TEXT);", "DROP FUNCTION luxia_erasure_allowed(TEXT, OID);", 'DROP TABLE "OrganizationErasure";', `'${NEW}'`])
      expect(rollback).toContain(text);
  });
});

describe("R7 organization erasure: operator plan", () => {
  const target = { host: "ep-example.eu-central-1.aws.neon.tech", database: "neondb", role: "neondb_owner" };
  const commit = "a".repeat(40);
  const at = new Date("2026-10-23T10:00:00.000Z");
  const plan: ErasurePlan = { kind: "LUXIA_ORGANIZATION_ERASURE_PLAN", organization: { id: "o1", slug: "acme", status: "CLOSED", statusChangedAt: null },
    counts: { Session: 2, Organization: 1 }, legacy: { bridgesForOrganization: 0, usersWithoutBridge: 0 }, target, toolVersion: commit, issuedAt: at.toISOString(), notAfter: new Date(at.getTime() + ERASURE_PLAN_VALIDITY_MS).toISOString() };
  const digest = planDigest(plan);
  const current = { target, toolVersion: commit };
  const refusal = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof ErasureRefusal ? error.message : `OTHER ${String(error)}`; } return "ACCEPTED"; };

  it("accepts only the intact plan, its digest, the typed identifier, in time, on the same database and commit", () => {
    expect(checkErasurePlan({ plan, digest }, digest, "acme", current, at)).toEqual(plan);
    expect(refusal(() => checkErasurePlan({ plan, digest }, "0".repeat(64), "acme", current, at))).toBe("CONFIRMATION_MISMATCH");
    expect(refusal(() => checkErasurePlan({ plan, digest }, digest, undefined, current, at))).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    expect(refusal(() => checkErasurePlan({ plan, digest }, digest, "Acme", current, at))).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    expect(refusal(() => checkErasurePlan({ plan: { ...plan, counts: { Session: 0, Organization: 1 } }, digest }, digest, "acme", current, at))).toBe("PLAN_TAMPERED");
    expect(refusal(() => checkErasurePlan({ plan: { ...plan, organization: { ...plan.organization, id: "o2" } }, digest }, digest, "acme", current, at))).toBe("PLAN_TAMPERED");
    expect(refusal(() => checkErasurePlan({ plan, digest }, digest, "acme", current, new Date(at.getTime() + ERASURE_PLAN_VALIDITY_MS + 1)))).toBe("PLAN_EXPIRED");
    expect(refusal(() => checkErasurePlan({ plan, digest }, digest, "acme", { target: { ...target, host: "ep-prod" }, toolVersion: commit }, at))).toBe("TARGET_MISMATCH");
    expect(refusal(() => checkErasurePlan({ plan, digest }, digest, "acme", { target, toolVersion: "b".repeat(40) }, at))).toBe("TOOL_VERSION_MISMATCH");
    expect(refusal(() => checkErasurePlan(null, digest, "acme", current, at))).toBe("NOT_AN_ERASURE_PLAN");
  });
});
