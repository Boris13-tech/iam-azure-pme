import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORITY, BREAK_GLASS_ACTIONS, JOURNAL_OPERATION, LUXIA_CERTIFICATION_ORGANIZATIONS } from "../../lib/operators/break-glass";

// First Admin / Break-glass v1, B4: the operator procedure, static checks.
const root = join(__dirname, "../..");
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const runtime = ["lib", "app"].flatMap((dir) => sources(join(root, dir)))
  .map((path) => ({ file: relative(root, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8").replace(/\r\n/g, "\n") }));
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
const SERVICE = "lib/operators/break-glass.ts", COMMAND = "scripts/operators/break-glass.ts";
const MIGRATION = "prisma/migrations/20261012180000_break_glass_operator_invitation/migration.sql";
function body(source: string, name: string) {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`missing ${name}`);
  const next = source.slice(start + 1).search(/\n(export )?(async )?function /);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}
const sqlFunction = (sql: string, name: string) => {
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name}\\(`));
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION");
};

describe("B4 operator break-glass architecture", () => {
  it("closed list, journal operations and the approved authority matrix (D7 + Q1), exactly", () => {
    expect([...BREAK_GLASS_ACTIONS].sort()).toEqual(Object.keys(JOURNAL_OPERATION).sort());
    expect(Object.values(JOURNAL_OPERATION).every((operation) => operation.startsWith("BREAK_GLASS."))).toBe(true);
    expect(AUTHORITY).toEqual({
      LUXIA_INCIDENT: ["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS"],
      LUXIA_CERTIFICATION: BREAK_GLASS_ACTIONS,
      VERIFIED_CUSTOMER_REQUEST: BREAK_GLASS_ACTIONS,
    });
    expect(LUXIA_CERTIFICATION_ORGANIZATIONS).toEqual(["luxia-certification-lab", "luxia-cert-b2-r6"]);
    // Every authority check sits in validateInput, which plan and apply both call first.
    const service = read(SERVICE);
    for (const check of ["ACTION_NOT_REQUESTED", "AUTHORITY[type].includes(action)", "certificationOrganizations.includes(organization)", "NAMED_PERSON_MISMATCH"])
      expect(body(service, "validateInput"), check).toContain(check);
    expect(body(service, "planBreakGlass")).toContain("validateInput(raw, options.certificationOrganizations)");
    expect(body(service, "applyBreakGlass")).toContain("validateInput(raw, options.certificationOrganizations)");
  });

  it("no free SQL, and nothing in the application can reach the procedure", () => {
    for (const file of [SERVICE, COMMAND]) expect(read(file), file).not.toMatch(/\$(queryRaw|executeRaw)Unsafe|Prisma\.raw\(|Prisma\.sql\(/);
    const importers = runtime.filter(({ file, source }) => file !== SERVICE && /operators\/break-glass/.test(source)).map(({ file }) => file);
    expect(importers).toEqual([]);
    // The command always uses the fixed list of certification organizations.
    expect(read(COMMAND)).not.toMatch(/certificationOrganizations/);
    expect(read(COMMAND)).toContain("rolbypassrls");
  });

  it("apply: locks first, plan recomputed and compared, then the action, the journal event and the constraints", () => {
    const fn = body(read(SERVICE), "applyBreakGlass");
    const order = ["refuse(\"PLAN_EXPIRED\"", "validateInput(raw", "IRREVERSIBLE_CONFIRMATION_REQUIRED", "lockTenantGovernance(tx", "FOR UPDATE",
      "computePlan(tx, input, options)", "digest !== options.confirm", "ensureOperatorSubject(tx, plan)", "perform(tx, plan",
      "SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS at", "canonicalAdminAuditEvent.create(", "SET CONSTRAINTS ALL IMMEDIATE",
      "readCommitted(db, applied.plan)"].map((part) => fn.indexOf(part));
    expect(order.every((index) => index > -1), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The journal time comes from the database transaction (same clock as statusChangedAt), never from Prisma's client default.
    expect(fn).toContain("metadata: eventMetadata(plan, digest, rest.effects), occurredAt,");
    expect(fn).toContain("const changeId = `break-glass:${digest}`");
    expect(fn).toContain(`refuse("ALREADY_APPLIED"`);
    // D2: account disabling goes through the last-administrator guard variant, never around it.
    expect(body(read(SERVICE), "perform")).toContain("preserveLastAdministratorUnlessSuspended(tx, scope, async () => {");
    // Status changes use the B3 primitive only.
    expect(read(SERVICE)).not.toMatch(/organization\.update(Many)?\(|UPDATE "Organization"/);
  });

  it("the operator gets no authority, and the invitation token is shown once, never stored", () => {
    const service = read(SERVICE);
    expect(body(service, "ensureOperatorSubject")).toContain(`type: "SERVICE"`);
    expect(body(service, "ensureOperatorSubject")).toContain(`lifecycleState: "DISABLED"`);
    expect(service).not.toMatch(/\.assignment\.|identityAccount\.create|session\.create|grantAdministrator/);
    expect(body(service, "eventMetadata")).not.toMatch(/token/i);
    expect(body(service, "issueRecoveryInvitation")).toContain("issuedByOperatorChangeId: changeId");
    const command = read(COMMAND);
    expect(command).toContain("const { invitationToken, ...recorded } = result;");
    expect(command).toContain(`{ kind: "LUXIA_BREAK_GLASS_APPLY", ...recorded }`);
    expect(command).not.toMatch(/writeEvidence\([^\n]*invitationToken/);
    // Acceptance: an operator invitation's authority is its break-glass event, never the inviter's rights.
    const acceptance = read("lib/onboarding/invitations.ts");
    expect(acceptance).toContain(`operation: "BREAK_GLASS.RECOVERY_INVITATION.ISSUE", result: "SUCCESS"`);
  });

  it("the migration is expand only, enforces D3 in the database, and its rollback restores the previous guard", () => {
    const sql = read(MIGRATION);
    expect(sql).not.toMatch(/DROP (TABLE|COLUMN|TYPE|FUNCTION)|GRANT /);
    for (const rule of ["INVITATION_OPERATOR_ONLY", "interval '24 hours'", "INVITATION_OPERATOR_AUTHORITY_MISSING",
      `"issuedByOperatorChangeId" IS DISTINCT FROM OLD."issuedByOperatorChangeId"`, "rolbypassrls"]) expect(sql, rule).toContain(rule);
    const previous = sqlFunction(read("prisma/migrations/20261011180000_organization_status_session_scope/migration.sql"), "luxia_invitation_guard");
    const rollback = read("docs/operations/B4-BREAK-GLASS-ROLLBACK.sql");
    expect(sqlFunction(rollback, "luxia_invitation_guard")).toBe(previous);
    expect(rollback.indexOf(`SET "revokedAt"`)).toBeLessThan(rollback.indexOf("CREATE OR REPLACE FUNCTION luxia_invitation_guard"));
    expect(rollback).toContain(`DROP COLUMN "issuedByOperatorChangeId"`);
  });
});
