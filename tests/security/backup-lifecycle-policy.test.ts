import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// R8: the backup lifecycle rule deletes only after the locked 30-day immutability, only under the backup
// prefixes, and the runbook applies exactly this file.
const policy = JSON.parse(readFileSync("docs/operations/BACKUP-LIFECYCLE-POLICY.json", "utf8"));
const runbook = readFileSync("docs/operations/BACKUP-RUNBOOK.md", "utf8");

describe("R8 backup lifecycle policy", () => {
  it("one rule, block blobs under the backup prefixes only, after the immutability period", () => {
    expect(policy.rules).toHaveLength(1);
    const [rule] = policy.rules;
    expect(rule).toMatchObject({ enabled: true, name: "luxia-backup-expiry", type: "Lifecycle" });
    expect(rule.definition.filters).toEqual({ blobTypes: ["blockBlob"], prefixMatch: ["prod-backups/prod/", "prod-backups/drill/"] });
    expect(Object.keys(rule.definition.actions).sort()).toEqual(["baseBlob", "version"]);
    for (const action of Object.values(rule.definition.actions) as Array<Record<string, unknown>>) {
      expect(Object.keys(action)).toEqual(["delete"]);
      expect((action.delete as { daysAfterCreationGreaterThan: number }).daysAfterCreationGreaterThan).toBe(31);
    }
  });

  it("the runbook applies this very file, and verifies by reading back", () => {
    expect(runbook).toContain("--policy @docs/operations/BACKUP-LIFECYCLE-POLICY.json");
    expect(runbook).toContain("az storage account management-policy show");
    // Proof of expiry counts soft-deleted versions too; the rollback disables the rule before deleting it.
    expect(runbook).toContain("--include vd");
    expect(runbook.indexOf("policy.rules[0].enabled=false")).toBeGreaterThan(-1);
    expect(runbook.indexOf("policy.rules[0].enabled=false")).toBeLessThan(runbook.indexOf("az storage account management-policy delete"));
  });
});
