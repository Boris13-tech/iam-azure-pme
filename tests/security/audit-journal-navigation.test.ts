import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATION_LABELS, operationLabel } from "../../lib/ui/activity-labels";

describe("audit journal and navigation (legacy role model out of user journeys)", () => {
  it("navigation no longer links the legacy role model; its page redirects to the overview", () => {
    const layout = readFileSync("app/dashboard/layout.tsx", "utf8");
    expect(layout).not.toContain("/dashboard/roles");
    const roles = readFileSync("app/dashboard/roles/page.tsx", "utf8");
    expect(roles).toContain('redirect("/dashboard")');
    expect(roles).not.toMatch(/RoleForm|RoleManager|\/api\/roles/);
  });

  it("the audit journal reads the canonical journal, not the legacy AuditLog", () => {
    const page = readFileSync("app/dashboard/audit/page.tsx", "utf8");
    expect(page).toContain("/api/canonical/security-journal");
    expect(page).not.toMatch(/["'`]\/api\/audit|AuditLogViewer|0\.0\.0\.0/);
  });

  it("unused legacy user components are removed", () => {
    expect(existsSync("components/UserForm.tsx")).toBe(false);
    expect(existsSync("components/UserTable.tsx")).toBe(false);
  });

  it("operation labels: known codes, refused variants, and no guessing for unknown codes", () => {
    expect(operationLabel("SESSION.REVOKE")).toBe("Session révoquée");
    expect(operationLabel("RESOURCE.ONBOARDING.PLAN.DENIED")).toBe("Intégration de ressource refusée");
    expect(operationLabel("SUBJECT.CREATE.DENIED")).toBe("Identité créée (refusé)");
    expect(operationLabel("SOMETHING.UNKNOWN")).toBeNull();
    for (const label of Object.values(OPERATION_LABELS)) expect(label).not.toMatch(/[—–→]|[A-Z_]{4,}\./);
  });
});
