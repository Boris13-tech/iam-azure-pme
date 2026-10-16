import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTION_ACTIONS } from "../../lib/admin/provider-connection-lifecycle";
import { REFUSAL_LABELS, operationLabel } from "../../lib/ui/activity-labels";

// Sovereign providers, phase F2 (docs/architecture/F2-PROVIDER-CONNECTION-LIFECYCLE.md): static guarantees.
// The behavior is proven on PostgreSQL in tests/resources/provider-connection-lifecycle-postgres.test.ts.
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}
const MIGRATION = "prisma/migrations/20261014090000_provider_connection_lifecycle/migration.sql";

describe("ProviderConnection lifecycle (F2)", () => {
  it("the application reads connections only inside a tenant scope, never through the unscoped client (ready for M2 RLS)", () => {
    const unscoped = [...files("lib"), ...files("app")].filter(file => /rawPrisma\s*\.\s*providerConnection\b/.test(read(file)));
    expect(unscoped).toEqual([]);
  });

  it("the kill switch sits in the core: the sign-in resolver, session creation and the database", () => {
    const resolver = read("lib/auth/organization-login.ts");
    expect(resolver).toMatch(/providerConnection\.findMany\(\{[\s\S]*status: "ACTIVE"/);
    const sessions = read("lib/auth/session-store.ts");
    expect(sessions.indexOf("lockOrganizationActive(tx, ctx.organizationId)")).toBeGreaterThan(0);
    expect(sessions.indexOf("lockProviderConnectionActive(tx, ctx.organizationId, ctx.identityAccountId)"))
      .toBeGreaterThan(sessions.indexOf("lockOrganizationActive(tx, ctx.organizationId)"));
    const migration = read(MIGRATION);
    expect(migration).toContain("CREATE TRIGGER session_guard_provider_connection BEFORE INSERT ON \"Session\"");
    // The callback checks the status before any call to the provider.
    const callback = read("app/auth/callback/route.ts");
    expect(callback.indexOf('provider.status !== "ACTIVE"')).toBeGreaterThan(0);
    expect(callback.indexOf('provider.status !== "ACTIVE"')).toBeLessThan(callback.indexOf("completeEntraAuthentication({"));
  });

  it("M1 is expand only: no row-level security switch, no DROP, no data rewrite; a connection is never deleted", () => {
    const migration = read(MIGRATION);
    expect(migration).not.toMatch(/ROW LEVEL SECURITY/);
    expect(migration).not.toMatch(/\bDROP\b/);
    expect(migration).not.toMatch(/^\s*(UPDATE|DELETE)\b/m);
    expect(migration).toContain(`ADD COLUMN "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'ACTIVE'`);
    expect(migration).toContain(`REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user`);
    expect(read("scripts/ci/bootstrap-app-user.sql")).toContain(`REVOKE DELETE, TRUNCATE ON "ProviderConnection" FROM app_user`);
    expect(read("docs/operations/PROVIDER-CONNECTION-LIFECYCLE-ROLLBACK.sql")).toContain("ROLLBACK_REFUSED_CONNECTION_STATUS_IN_USE");
  });

  it("new connections: LUXIA_LOCAL ACTIVE, any other DRAFT until tested and activated (F4)", () => {
    expect(read("lib/admin/canonical-administration.ts")).toContain(`status: input.providerType === "LUXIA_LOCAL" ? "ACTIVE" : "DRAFT"`);
    expect(read("lib/onboarding/signup.ts")).toMatch(/providerType: "LUXIA_LOCAL", status: "ACTIVE"/);
    expect(read("app/api/auth/local/enrollment/begin/route.ts")).toMatch(/providerType: "LUXIA_LOCAL",\s*status: "ACTIVE"/);
  });

  it("the administrator's actions match the database's transitions, offer TESTING to ACTIVE only on evidence, and never touch LUXIA_LOCAL", () => {
    // F4 (S5) deliberately adds TESTING to ACTIVATE: the first activation, which needs activation evidence (below).
    expect(CONNECTION_ACTIONS).toEqual({
      DISABLE: { from: ["ACTIVE"], to: "DISABLED" },
      ACTIVATE: { from: ["DISABLED", "TESTING"], to: "ACTIVE" },
      QUARANTINE: { from: ["ACTIVE", "DISABLED"], to: "QUARANTINED" },
      RELEASE: { from: ["QUARANTINED"], to: "DISABLED" },
    });
    const migration = read(MIGRATION);
    for (const [, rule] of Object.entries(CONNECTION_ACTIONS))
      for (const from of rule.from) expect(migration).toMatch(new RegExp(`OLD\\."status" = '${from}' AND NEW\\."status" (= '${rule.to}'|IN \\([^)]*'${rule.to}')`));
    const service = read("lib/admin/provider-connection-lifecycle.ts");
    expect(service).toContain(`target.providerType === "LUXIA_LOCAL"`);
    expect(service).not.toMatch(/fetch\(|https?:\/\//);
    // The first activation reads its evidence in the plan and again in the apply, under the row lock, into the digest.
    const evidence = "const evidence = firstActivation(target, to) ? await activationEvidence(tx, auth, target, clock(options)) : undefined;";
    expect(service.split(evidence)).toHaveLength(3);
    const apply = service.slice(service.indexOf("export function applyConnectionTransition"));
    expect(apply.indexOf("readTarget(tx, auth, providerConnectionId, true)")).toBeLessThan(apply.indexOf(evidence));
    expect(apply.indexOf(evidence)).toBeLessThan(apply.indexOf("connectionPlanDigest(auth, target, action, evidence)"));
    expect(service).toContain(`const firstActivation = (target: Target, to: ProviderConnectionStatus) => target.status === "TESTING" && to === "ACTIVE";`);
  });

  it("every journaled operation and the sign-in refusal have a French label (B5)", () => {
    for (const action of [...Object.keys(CONNECTION_ACTIONS), "PLAN"]) {
      expect(operationLabel(`PROVIDER.CONNECTION.${action}`), action).toBeTruthy();
      expect(operationLabel(`PROVIDER.CONNECTION.${action}.DENIED`), action).toMatch(/\(refusé\)$/);
    }
    expect(REFUSAL_LABELS.PROVIDER_CONNECTION_NOT_ACTIVE).toBeTruthy();
  });
});
