import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDomain } from "../../lib/onboarding/domains";
import { OPERATION_LABELS } from "../../lib/ui/activity-labels";

// Customer Self-Onboarding v1, steps 5 to 7: contract checks without a database.
describe("Domains, invitations and checklist contract", () => {
  it("requirement 10: domains are normalized; anything that is not a plain domain name is refused", () => {
    expect(normalizeDomain(" Example.COM. ")).toBe("example.com");
    expect(normalizeDomain("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["localhost", "com", "http://example.com", "example.com/path", "example.com:443", "user@example.com", "192.168.0.1", "-bad.example", "a..b", "", 7])
      expect(normalizeDomain(bad), String(bad)).toBeNull();
  });

  it("requirement 16: invitations offer only a link to copy; nothing claims an email was sent", () => {
    const page = readFileSync("app/dashboard/organization/page.tsx", "utf8");
    expect(page).toContain("Copier le lien d’invitation");
    expect(page).toContain("Invitation créée, en attente d’acceptation");
    expect(page).not.toMatch(/envoy[ée]e?\b|sent\b/i);
    for (const file of ["lib/onboarding/invitations.ts", "app/api/onboarding/invitations/route.ts"])
      expect(readFileSync(file, "utf8")).not.toMatch(/nodemailer|sendgrid|resend|smtp|sendMail/i);
  });

  it("requirements 8, 9: tokens are hashed, carried in the URL fragment, and acceptance never reads tenant, role or person from the request", () => {
    const lib = readFileSync("lib/onboarding/invitations.ts", "utf8");
    expect(lib).toContain("tokenHash: sha256Hex(token)");
    expect(lib).not.toMatch(/console\.(log|error)\([^)]*token/);
    expect(lib).toMatch(/row\.role === "ADMIN"/);
    expect(readFileSync("app/api/onboarding/invitations/route.ts", "utf8")).toContain("/invitation#${token}");
    const complete = readFileSync("app/api/auth/invitation/complete/route.ts", "utf8");
    expect(complete).not.toMatch(/body\.(role|tenantId|organizationId|subjectId|organization)\b/);
    const page = readFileSync("app/invitation/accept-invitation.tsx", "utf8");
    expect(page).toContain("window.history.replaceState(null, \"\", window.location.pathname)");
  });

  it("new operations have French labels without technical codes or dashes", () => {
    for (const key of ["ORGANIZATION.CREATE", "DOMAIN.ADD", "DOMAIN.CHECK", "DOMAIN.READ", "INVITATION.CREATE", "INVITATION.REVOKE", "INVITATION.ACCEPT", "INVITATION.READ", "ONBOARDING.CHECKLIST.READ"]) {
      expect(OPERATION_LABELS[key], key).toBeTruthy();
      expect(OPERATION_LABELS[key]).not.toMatch(/[—–→]|[A-Z_]{4,}/);
    }
  });

  it("step 7: the checklist is facts only (booleans), never a score", () => {
    const lib = readFileSync("lib/onboarding/checklist.ts", "utf8");
    expect(lib).toContain("const items: Record<ChecklistItem, boolean> = {");
    const code = (source: string) => source.replace(/\/\/.*$/gm, "");
    expect(code(lib)).not.toMatch(/score|percent|%/i);
    expect(code(readFileSync("app/dashboard/onboarding-checklist.tsx", "utf8"))).not.toMatch(/score|%/i);
  });
});
