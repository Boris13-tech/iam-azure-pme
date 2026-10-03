import { describe, expect, it } from "vitest";
import { applyAttributeMapping, attributeMappingSchema, configurationSchema, providerManagementUpdateSchema, reconcileDryRun } from "../../lib/provider-management/contracts";

describe("Providers Management v1 reconciliation", () => {
  it("requires immutable IDs and rejects name/email as identity mapping", () => {
    expect(() => applyAttributeMapping({ email: "alice@example.test" }, {})).toThrow("INVALID_EXTERNAL_ID");
    expect(attributeMappingSchema.safeParse({ externalObjectId: "email" }).success).toBe(false);
    expect(attributeMappingSchema.safeParse({ subjectId: "displayName" }).success).toBe(false);
  });
  it("does not merge people sharing a name or email", () => {
    const result = reconcileDryRun([
      { externalObjectId: "id-a", displayName: "Alice", principalName: "alice@example.test" },
      { externalObjectId: "id-b", displayName: "Alice", principalName: "alice@example.test" },
    ], new Set());
    expect(result).toMatchObject({ unlinked: 2, collisions: [], created: 0, updated: 0, disabled: 0 });
  });
  it("quarantines duplicate stable identifiers deterministically", () => {
    const items = [{ externalObjectId: "a", displayName: "Alice" }, { externalObjectId: "a", displayName: "Other" }];
    expect(reconcileDryRun(items, new Set(["a"]))).toMatchObject({ collisions: ["a"], linked: 0, unlinked: 0 });
    expect(reconcileDryRun([...items].reverse(), new Set(["a"]))).toEqual(reconcileDryRun(items, new Set(["a"])));
  });
  it("accepts public attributes only and never inline secrets", () => {
    expect(configurationSchema.safeParse({ clientSecret: "secret" }).success).toBe(false);
    expect(providerManagementUpdateSchema.safeParse({ expectedMappingVersion: 1, credentialSecretRef: "GRAPH_CLIENT_SECRET" }).success).toBe(false);
    expect(providerManagementUpdateSchema.safeParse({ expectedMappingVersion: 1, credentialSecretRef: "LUXIA_PROVIDER_CONNECTION_A" }).success).toBe(true);
  });
  it("maps Google public attributes while preserving provider ID", () => {
    expect(applyAttributeMapping({ id: "google-123", name: { fullName: "Alice" }, primaryEmail: "alice@example.test" },
      { displayName: "name.fullName", principalName: "primaryEmail" })).toEqual({ externalObjectId: "google-123", displayName: "Alice", principalName: "alice@example.test" });
  });
});
