import { describe, expect, it } from "vitest";
import { ProviderAdapterError, type ProviderOperationContext } from "../../lib/provider-adapters";
import { escapeLdapFilterValue, linkDirectoryProjection, normalizeDirectoryIdentity,
  type DirectoryAccountProjectionStore, type DirectoryLinkCollisionStore,
} from "../../lib/provider-adapters/implementations/enterprise-directory";
import { createDirectoryAdapter, directoryContext, seededGateway, TestDirectoryGateway, TestDirectorySecrets, TestQuarantine, user } from "./enterprise-directory-test-kit";

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of source) result.push(item); return result; }

describe("Phase 6H enterprise directory discovery", () => {
  for (const type of ["LDAP", "ACTIVE_DIRECTORY", "SAMBA_AD"] as const) {
    it(`${type} discovers normalized provider projections with safe pagination`, async () => {
      const { adapter, gateway } = createDirectoryAdapter(type); const identities = await collect(adapter.discoverUsers(directoryContext("discover")));
      expect(identities.map((item) => item.identity.ref.externalObjectId)).toEqual(["immutable-alice", "immutable-bob", "immutable-carol"]);
      expect(identities[0].identity).toMatchObject({ principalName: "alice@example.internal", status: "ACTIVE" });
      expect(gateway.calls.filter((call) => call.method === "listUsers")).toHaveLength(2);
      const groups = await collect(adapter.listGroups(directoryContext("groups")));
      expect(groups[0]).toMatchObject({ displayName: "Admins" }); expect(groups[0].members).toHaveLength(2);
    });
  }

  it("normalizes immutable IDs deterministically and ignores mutable names as identity keys", () => {
    const first = normalizeDirectoryIdentity("ACTIVE_DIRECTORY", user("ACTIVE_DIRECTORY", "alice", "Alice"));
    const renamed = normalizeDirectoryIdentity("ACTIVE_DIRECTORY", user("ACTIVE_DIRECTORY", "alice", "Alice Renamed"));
    expect(first.externalObjectId).toBe(renamed.externalObjectId); expect(first.displayName).not.toBe(renamed.displayName);
  });

  it("rejects insecure transport, disabled certificate checks, and plaintext-like missing secret references", async () => {
    const insecure = createDirectoryAdapter("LDAP", { config: { transport: "LDAP" as never } }).adapter;
    await expect(collect(insecure.discoverUsers(directoryContext()))).rejects.toMatchObject({ code: "MISCONFIGURED" });
    const invalidPin = createDirectoryAdapter("LDAP", { config: { certificateValidation: "PINNED", pinnedCertificateSha256: "bad" } }).adapter;
    await expect(invalidPin.healthCheck(directoryContext())).resolves.toMatchObject({ status: "MISCONFIGURED" });
    const missingRef = createDirectoryAdapter("LDAP", { config: { bindSecret: { key: "" } } }).adapter;
    await expect(collect(missingRef.discoverUsers(directoryContext()))).rejects.toMatchObject({ code: "MISCONFIGURED" });
  });

  it("escapes LDAP filter input and keeps bind secrets inside connection-scoped leases", async () => {
    expect(escapeLdapFilterValue("*)(uid=*)")).toBe("\\2a\\29\\28uid=\\2a\\29");
    const gateway = seededGateway("LDAP"), secrets = new TestDirectorySecrets(); const { adapter } = createDirectoryAdapter("LDAP", { gateway, secrets });
    await adapter.getUser(directoryContext("lookup"), { externalObjectId: "*)(uid=*)" });
    expect(gateway.calls.at(-1)?.request.escapedExternalId).toBe("\\2a\\29\\28uid=\\2a\\29");
    expect(secrets.calls[0]).toMatchObject({ context: directoryContext("lookup"), reference: { key: "directory-bind", version: "1" } });
    expect(JSON.stringify(gateway.calls)).not.toContain("bind-password-not-for-logs");
  });

  it("quarantines duplicate immutable IDs and fails closed", async () => {
    const gateway = seededGateway("SAMBA_AD"); gateway.users.push({ ...user("SAMBA_AD", "alice", "Impostor"),
      dn: "cn=Impostor,ou=people,dc=example,dc=internal" }); const quarantine = new TestQuarantine();
    const { adapter } = createDirectoryAdapter("SAMBA_AD", { gateway, quarantine });
    await expect(collect(adapter.discoverUsers(directoryContext("collision")))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(quarantine.collisions).toEqual([expect.objectContaining({ externalObjectId: "immutable-alice", reasonCode: "DUPLICATE_EXTERNAL_ID" })]);
  });

  it("bounds retries, reports outages safely, and resumes from a cursor", async () => {
    const gateway = seededGateway("LDAP"); gateway.failuresRemaining = 2; const { adapter } = createDirectoryAdapter("LDAP", { gateway });
    await expect(collect(adapter.discoverUsers(directoryContext("retry")))).resolves.toHaveLength(3);
    const outage = new TestDirectoryGateway(); outage.failuresRemaining = 10; const unavailable = createDirectoryAdapter("LDAP", { gateway: outage }).adapter;
    await expect(unavailable.healthCheck(directoryContext("outage"))).resolves.toMatchObject({ status: "UNAVAILABLE",
      safeMessage: "Enterprise directory health check failed" });
    expect(outage.calls).toHaveLength(3);
  });

  it("makes read-only sync idempotent and rejects operation-id semantic conflicts", async () => {
    const { adapter, gateway } = createDirectoryAdapter("ACTIVE_DIRECTORY"); const context = directoryContext("sync-once");
    const first = await adapter.sync(context, { mode: "FULL", maximumItems: 3 }); const calls = gateway.calls.length;
    await expect(adapter.sync(context, { mode: "FULL", maximumItems: 3 })).resolves.toEqual(first);
    expect(gateway.calls).toHaveLength(calls);
    await expect(adapter.sync(context, { mode: "INCREMENTAL", maximumItems: 3 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects write-back capabilities explicitly", async () => {
    const { adapter } = createDirectoryAdapter("LDAP");
    await expect(adapter.createIdentity(directoryContext(), { subjectId: "s", displayName: "Alice" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(adapter.grantAccess(directoryContext(), { identity: { externalObjectId: "id" }, resource: { externalResourceId: "r" }, entitlementKey: "read" }))
      .rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});

describe("Phase 6H canonical Subject linking", () => {
  it("links exactly one canonical Subject and preserves its ID", async () => {
    const store = new MemoryProjectionStore(), collisions = new MemoryLinkCollisions();
    const linked = await linkDirectoryProjection({ context: directoryContext("link"), providerType: "LDAP",
      identity: { externalObjectId: "IMMUTABLE-ALICE" }, candidateSubjectIds: ["subject-canonical"] }, store, collisions);
    expect(linked).toMatchObject({ subjectId: "subject-canonical", externalObjectId: "immutable-alice", created: true });
    expect(await linkDirectoryProjection({ context: directoryContext("link-replay"), providerType: "LDAP",
      identity: { externalObjectId: "IMMUTABLE-ALICE" }, candidateSubjectIds: ["subject-canonical"] }, store, collisions))
      .toMatchObject({ subjectId: "subject-canonical", created: false });
  });
  it("quarantines zero/multiple candidates and forbids cross-tenant projection reuse", async () => {
    const store = new MemoryProjectionStore(), collisions = new MemoryLinkCollisions();
    await expect(linkDirectoryProjection({ context: directoryContext(), providerType: "LDAP", identity: { externalObjectId: "id" },
      candidateSubjectIds: ["subject-a", "subject-b"] }, store, collisions)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(collisions.items).toHaveLength(1);
    await linkDirectoryProjection({ context: directoryContext("one"), providerType: "LDAP", identity: { externalObjectId: "shared" },
      candidateSubjectIds: ["subject-a"] }, store, collisions);
    await expect(linkDirectoryProjection({ context: { ...directoryContext("two"), tenantId: "tenant-b" }, providerType: "LDAP",
      identity: { externalObjectId: "shared" }, candidateSubjectIds: ["subject-b"] }, store, collisions)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

class MemoryProjectionStore implements DirectoryAccountProjectionStore {
  private values = new Map<string, { tenantId: string; subjectId: string; identityAccountId: string }>();
  async link(context: ProviderOperationContext, input: Parameters<DirectoryAccountProjectionStore["link"]>[1]) {
    const key = `${context.organizationId}:${context.providerConnectionId}:${input.externalObjectId}`; const prior = this.values.get(key);
    if (prior && (prior.tenantId !== context.tenantId || prior.subjectId !== input.subjectId))
      throw new ProviderAdapterError({ code: "CONFLICT", message: "cross-tenant collision" });
    const value = prior ?? { tenantId: context.tenantId, subjectId: input.subjectId, identityAccountId: `account:${input.externalObjectId}` };
    this.values.set(key, value); return { identityAccountId: value.identityAccountId, subjectId: value.subjectId,
      externalObjectId: input.externalObjectId, providerConnectionId: context.providerConnectionId, created: !prior };
  }
}
class MemoryLinkCollisions implements DirectoryLinkCollisionStore {
  items: unknown[] = []; async quarantine(_context: ProviderOperationContext, input: unknown) { this.items.push(input); }
}
