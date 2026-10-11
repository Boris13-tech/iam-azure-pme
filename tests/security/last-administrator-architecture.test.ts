import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { GOVERNANCE_ADMIN_V2 } from "../../lib/resources/admin-bundle";

// First Admin / Break-glass v1, B1. Every runtime write that can end a durable administrator (subject
// lifecycle, identity account status, grant status or entitlement) must sit lexically inside a guard
// call. The few writers that cannot remove an administrator are listed with the exact content that makes
// them harmless, checked on each writer, not only counted. A new writer outside a guard fails this test.
const root = join(__dirname, "../..");
const WRITER = /\.(assignment|identityAccount|subject|entitlement)\.(update|updateMany|upsert|delete|deleteMany)\(/g;
const ASSIGNMENT_WRITER = /\.assignment\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
const GUARD_CALLS = ["preserveLastAdministrator(", "guardLastAdministrator("];

/** Index of the parenthesis closing the one at `open`, skipping strings and comments. */
function closing(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return i;
  }
  throw new Error("UNBALANCED_SOURCE");
}

/** Argument spans of every guard call. A guard definition (`name<T>(`) is not a call. */
function guardSpans(source: string): Array<[number, number]> {
  return GUARD_CALLS.flatMap(call => [...source.matchAll(new RegExp(call.replace("(", "\\("), "g"))]
    .map(match => { const open = match.index! + call.length - 1; return [open, closing(source, open)] as [number, number]; }));
}

/** Writers outside every guard call, each with the text of its own call. */
function unguardedWriters(source: string): string[] {
  const spans = guardSpans(source);
  return [...source.matchAll(WRITER)]
    .filter(match => !spans.some(([start, end]) => match.index! > start && match.index! < end))
    .map(match => { const open = match.index! + match[0].length - 1; return source.slice(match.index!, closing(source, open) + 1); });
}

// Reviewed writers: each one must contain this text in its own call.
const REVIEWED: Record<string, { writers: number; proof: string; reason: string }> = {
  "lib/auth/dual-write-service.ts": { writers: 1, proof: 'source: "LEGACY_ROLE"', reason: "LEGACY_ROLE grants never count" },
  "lib/onboarding/invitations.ts": { writers: 1, proof: 'data: { lifecycleState: "ACTIVE"', reason: "activation only (PROVISIONING to ACTIVE)" },
};
// Writers of grants that do not take the tenant lock themselves, with the reason.
const LOCK_REVIEWED: Record<string, string> = {
  "lib/onboarding/provisioning.ts": "runs inside signup (new organization) or invitation acceptance, which takes the lock first",
  "lib/auth/backfill-service.ts": "legacy backfill, creates LEGACY_ROLE grants, not reachable from a product route",
};

function sources(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const runtime = ["lib", "app"].flatMap(dir => sources(join(root, dir)))
  .map(path => ({ file: relative(root, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8").replace(/\r\n/g, "\n") }));
const read = (file: string) => runtime.find(entry => entry.file === file)!.source;
const body = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}(`);
  return source.slice(start, source.indexOf("\nexport ", start + 1));
};

describe("B1 last-administrator guard architecture", () => {
  it("the scanner flags a real new writer, including one prepared outside the guard and passed to it", () => {
    expect(unguardedWriters(`async function x(tx) { await tx.assignment.update({ where: { id }, data: { status: "REVOKED" } }); }`)).toHaveLength(1);
    expect(unguardedWriters(`await preserveLastAdministrator(tx, auth, () => tx.identityAccount.update({ data: { status: ")" } }));`)).toEqual([]);
    expect(unguardedWriters(`const change = () => tx.subject.update({ data: {} });\nawait preserveLastAdministrator(tx, auth, change);`)).toHaveLength(1);
    expect(unguardedWriters(`export async function preserveLastAdministrator<T>(tx) { await tx.entitlement.delete({ where: {} }); }`)).toHaveLength(1);
  });

  it("every runtime writer of subjects, accounts, grants or entitlements is inside a guard or reviewed one by one", () => {
    const outside = Object.fromEntries(runtime.map(({ file, source }) => [file, unguardedWriters(source)] as const).filter(([, writers]) => writers.length));
    expect(Object.keys(outside).sort()).toEqual(Object.keys(REVIEWED).sort());
    for (const [file, { writers, proof }] of Object.entries(REVIEWED)) {
      expect(outside[file], file).toHaveLength(writers);
      for (const writer of outside[file]) expect(writer, file).toContain(proof);
    }
  });

  it("no raw SQL or nested relation write can bypass the scan", () => {
    for (const { file, source } of runtime) {
      expect(source, file).not.toMatch(/\b(UPDATE|DELETE\s+FROM)\s+"(Subject|IdentityAccount|Assignment|Entitlement)"/);
      expect(source, file).not.toMatch(/\b(updateMany|deleteMany)\s*:/);
    }
  });

  it("uses one tenant lock, the one the SoD trigger takes, before any row lock", () => {
    const guard = read("lib/admin/last-administrator.ts");
    const trigger = readFileSync(join(root, "prisma/migrations/20261004160000_static_sod_v1/migration.sql"), "utf8");
    expect(guard).toContain("hashtextextended(${`resource-governance:${scope.organizationId}:${scope.tenantId}`}, 0)");
    expect(trigger).toContain(`hashtextextended('resource-governance:'||NEW."organizationId"||':'||NEW."tenantId",0)`);
    expect(guard).not.toMatch(/administrators:/);
    expect(guard.indexOf("await lockTenantGovernance(tx, scope)")).toBeLessThan(guard.indexOf("SAVEPOINT luxia_last_administrator"));
    expect(guard).toContain("ROLLBACK TO SAVEPOINT luxia_last_administrator");

    // Every runtime writer of grants takes that lock (the SoD trigger would take it later, after rows).
    for (const { file, source } of runtime.filter(entry => ASSIGNMENT_WRITER.test(entry.source))) {
      if (LOCK_REVIEWED[file]) continue;
      expect(source, file).toMatch(/lockTenantGovernance\(tx|preserveLastAdministrator\(tx|`resource-governance:\$\{/);
    }
    const canonical = read("lib/admin/canonical-administration.ts");
    for (const name of ["updateSubject", "disableIdentityAccount", "revokeAssignment", "grantAssignment"]) {
      const fn = body(canonical, name);
      expect(fn, name).toContain("return withTenantDb(auth");
      if (name !== "grantAssignment") expect(fn, name).toContain("guardLastAdministrator(tx, auth");
      expect(fn.indexOf("await lockTenantGovernance(tx, auth)"), name).toBeGreaterThan(-1);
      expect(fn.indexOf("await lockTenantGovernance(tx, auth)"), name).toBeLessThan(fn.indexOf("assertUnusedChangeId"));
    }
    const acceptance = body(read("lib/onboarding/invitations.ts"), "completeAcceptance");
    expect(acceptance.indexOf("await lockTenantGovernance(tx, scope)")).toBeGreaterThan(-1);
    expect(acceptance.indexOf("await lockTenantGovernance(tx, scope)")).toBeLessThan(acceptance.indexOf("tx.invitation.updateMany"));
    const dualWrite = read("lib/auth/dual-write-service.ts");
    expect(dualWrite.split("await lockTenantGovernance(tx, auth)").length - 1).toBe(2);
  });

  it("counts durable administrators only: permanent native grant, active human, own active account", () => {
    const guard = read("lib/admin/last-administrator.ts");
    expect(guard).toContain('type: "HUMAN", lifecycleState: "ACTIVE"');
    expect(guard).toContain('status: "ACTIVE", source: { not: "LEGACY_ROLE" }, validUntil: null');
    expect(guard).toContain("OR: [{ validFrom: null }, { validFrom: { lte: now } }]");
    expect(guard).toContain('identities: { some: { organizationId: scope.organizationId, tenantId: scope.tenantId, status: "ACTIVE" } }');
    expect(guard).toContain("if (before > 0 && after === 0)");
    expect(read("lib/onboarding/checklist.ts")).toContain("countDurableAdministrators(tx, scope, now)");
  });

  it("resource-scoped paths cannot select a catalog grant such as assignments.manage", () => {
    const service = read("lib/resources/service.ts");
    for (const name of ["revokeAssignment", "updateAssignment", "revokeEntitlement"]) {
      const start = service.indexOf(`export function ${name}(`);
      expect(service.slice(start, service.indexOf("\nexport ", start + 1)), name).toMatch(/resourceScopeId: \{ not: null \}/);
    }
    expect(read("lib/resources/access-reviews.ts")).toMatch(/entitlement: \{ active: true, resourceScopeId: \{ not: null \} \}/);
    expect(GOVERNANCE_ADMIN_V2).not.toContain("assignments.manage");
  });
});
