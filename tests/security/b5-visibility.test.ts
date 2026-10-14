import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASSURANCE_LABELS, OPERATOR_ACTION_PREFIX, REFUSAL_LABELS, SIGN_IN_METHOD_LABELS, operationLabel } from "../../lib/ui/activity-labels";
import { JOURNAL_OPERATION } from "../../lib/operators/break-glass";
import { RECOVERY_ASSURANCE_PROFILE, signInMethodKey } from "../../lib/auth/recovery-evidence";

// First Admin / Break-glass v1, B5: what the customer sees of the recovery codes (B2) and of the
// LUXIA operator procedure (B4). Static checks; the PostgreSQL suites check the same facts on data.
const root = join(__dirname, "../..");
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
/** Plain French: no technical code (the brand name aside) and no dash or arrow. */
const plain = (label: string) => !/[—–→]|[A-Z_]{4,}/.test(label.replaceAll("LUXIA", ""));

describe("B5 visibility for the customer", () => {
  it("every LUXIA operator action reads as such in the organization's journal", () => {
    for (const operation of Object.values(JOURNAL_OPERATION)) {
      const label = operationLabel(operation);
      expect(label, operation).toBeTruthy();
      expect(label!.startsWith(OPERATOR_ACTION_PREFIX), operation).toBe(true);
      expect(plain(label!), label!).toBe(true);
    }
    // G1 correction events are operator actions too, and read as such.
    for (const operation of ["OPERATOR.AUTHENTICATOR.ASSURANCE_CORRECTION", "OPERATOR.AUTHENTICATOR.ASSURANCE_CORRECTION.REVERT"]) {
      expect(operationLabel(operation)!.startsWith(OPERATOR_ACTION_PREFIX), operation).toBe(true);
      expect(plain(operationLabel(operation)!), operation).toBe(true);
    }
    // Nothing else may borrow the operator prefix.
    for (const operation of ["RECOVERY.SIGN_IN", "SESSION.REVOKE", "IDENTITY_ACCOUNT.DISABLE"])
      expect(operationLabel(operation)!.startsWith(OPERATOR_ACTION_PREFIX), operation).toBe(false);
  });

  it("every operation the application journals has a French label, so the journal never shows « Autre action »", () => {
    const patterns = [/operation:\s*"([A-Z_]+(?:\.[A-Z_]+)+)"/g, /operation\([^,()]+,\s*[^,()]+,\s*"([A-Z_]+(?:\.[A-Z_]+)+)"/g];
    const operations = new Set<string>();
    for (const file of ["lib", "app"].flatMap((dir) => sources(join(root, dir))))
      for (const pattern of patterns) for (const match of readFileSync(file, "utf8").matchAll(pattern)) operations.add(match[1]);
    expect(operations.size).toBeGreaterThan(50);
    const missing = [...operations].filter((operation) => !operationLabel(operation));
    expect(missing).toEqual([]);
    for (const operation of ["RECOVERY_CODES.GENERATE", "RECOVERY_CODES.REVOKE", "RECOVERY.SIGN_IN", "RECOVERY.PASSKEY_ENROLLED"])
      expect(plain(operationLabel(operation)!), operation).toBe(true);
  });

  it("a recovery-code sign-in is named and shown with its real, low assurance", () => {
    expect(signInMethodKey({ method: "CUSTOM", assuranceProfile: RECOVERY_ASSURANCE_PROFILE })).toBe("RECOVERY_CODE");
    // Never guessed: another custom method, or a passkey, keeps its own key.
    expect(signInMethodKey({ method: "CUSTOM", assuranceProfile: null })).toBe("CUSTOM");
    expect(signInMethodKey({ method: "PASSKEY", assuranceProfile: RECOVERY_ASSURANCE_PROFILE })).toBe("PASSKEY");
    for (const label of [SIGN_IN_METHOD_LABELS.RECOVERY_CODE, ASSURANCE_LABELS.RECOVERY_CODE, REFUSAL_LABELS.RECOVERY_CODE_INVALID]) {
      expect(label).toBeTruthy();
      expect(plain(label), label).toBe(true);
    }
    expect(read("lib/auth/recovery.ts")).toContain("assuranceProfile: RECOVERY_ASSURANCE_PROFILE");
    const journal = read("lib/audit/security-journal.ts");
    expect(journal).toContain("method: signInMethodKey(e)");
    expect(journal).toContain(`e.assuranceProfile === RECOVERY_ASSURANCE_PROFILE ? "RECOVERY_CODE"`);
    expect(read("lib/dashboard/posture-queries.ts")).toContain("key: signInMethodKey(r)");
    // « Mes sessions »: a recovery session is never shown as a passkey session.
    expect(read("app/dashboard/settings/my-security.tsx")).toContain(`session.scope === "RECOVERY" ? RECOVERY_SESSION_LABEL`);
  });

  it("the overview asks for the checklist only when its API will accept the viewer (no denied reads for members)", () => {
    expect(read("lib/onboarding/checklist.ts")).toContain(`operation(auth, changeId, "ONBOARDING.CHECKLIST.READ", ONBOARDING_CHECKLIST_PERMISSION,`);
    expect(read("lib/dashboard/posture.ts")).toContain("onboardingChecklist: held.has(ONBOARDING_CHECKLIST_PERMISSION)");
    const page = read("app/dashboard/page.tsx");
    expect(page).toContain("{data.viewer.onboardingChecklist && <OnboardingChecklist />}");
    expect(page.match(/<OnboardingChecklist \/>/g)).toHaveLength(1);
  });
});
