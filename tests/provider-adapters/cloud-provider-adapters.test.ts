import { describe, expect, it } from "vitest";
import { ProviderAdapterError, type ProviderIdentity, type ProviderOperationContext } from "../../lib/provider-adapters";
import { linkCloudProjection, normalizeCloudIdentity, type CloudAccountProjectionStore, type CloudLinkCollisionStore } from "../../lib/provider-adapters/implementations/cloud-providers";
import { cloudContext, createCloudAdapter, InstantBackoff, seededCloudGateway, TestCloudGateway, TestCloudQuarantine, TestCloudSecrets } from "./cloud-provider-test-kit";
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of source) result.push(item); return result; }

describe("Phase 6I cloud provider discovery", () => {
  for (const type of ["GOOGLE_WORKSPACE", "AWS", "GITHUB"] as const) {
    it(`${type} discovers normalized identities, groups and resources with evidence`, async () => {
      const { adapter, gateway } = createCloudAdapter(type); const identities = await collect(adapter.discoverUsers(cloudContext("discover")));
      expect(identities).toHaveLength(3); expect(identities[0].evidence).toMatchObject({ eventType: "DISCOVERED", providerType: type,
        organizationId: "organization-a", tenantId: "tenant-a", normalizationVersion: 1 });
      expect(identities[0].evidence?.externalObjectIdDigest).toMatch(/^sha256:/);
      expect(gateway.calls.filter((call) => call.method === "listIdentities")).toHaveLength(2);
      expect(await collect(adapter.listGroups(cloudContext("groups")))).toHaveLength(1);
      expect(await collect(adapter.listResources(cloudContext("resources")))).toHaveLength(1);
    });
  }

  it("preserves AWS human, workload and service distinctions without changing canonical semantics", () => {
    const human = normalizeCloudIdentity("AWS", { principalId: "human", kind: "USER", name: "Alice", accountId: "123456789012" }, "123456789012");
    const workload = normalizeCloudIdentity("AWS", { principalId: "role", kind: "ROLE", name: "Runtime", accountId: "123456789012" }, "123456789012");
    const service = normalizeCloudIdentity("AWS", { principalId: "service", kind: "SERVICE", name: "Build", accountId: "123456789012" }, "123456789012");
    expect([human.suggestedSubjectKind, workload.suggestedSubjectKind, service.suggestedSubjectKind]).toEqual(["HUMAN", "WORKLOAD", "SERVICE"]);
  });

  it("rejects malformed responses, wrong cloud scope, insecure endpoints and embedded URL credentials", async () => {
    expect(() => normalizeCloudIdentity("AWS", { principalId: "id", kind: "USER", name: "Alice", accountId: "000000000000" }, "123456789012"))
      .toThrow("Cloud provider response validation failed");
    expect(() => normalizeCloudIdentity("GITHUB", { databaseId: 1, login: "alice", organizationId: 100 }, "99")).toThrow();
    for (const apiBaseUrl of ["http://api.github.com", "https://token@api.github.com"]) {
      const adapter = createCloudAdapter("GITHUB", { config: { apiBaseUrl } }).adapter;
      await expect(collect(adapter.discoverUsers(cloudContext()))).rejects.toMatchObject({ code: "MISCONFIGURED" });
    }
  });

  it("uses connection-scoped secret leases without exposing tokens", async () => {
    const secrets = new TestCloudSecrets(); const { adapter, gateway } = createCloudAdapter("GOOGLE_WORKSPACE", { secrets });
    await collect(adapter.discoverUsers(cloudContext("secret-scope")));
    expect(secrets.calls[0]).toMatchObject({ context: cloudContext("secret-scope"), reference: { key: "google_workspace-credential", version: "1" } });
    expect(JSON.stringify(gateway.calls)).not.toContain("provider-token-never-log");
  });

  it("quarantines duplicate external identities and fails closed", async () => {
    const gateway = seededCloudGateway("GITHUB"); gateway.identities.push({ databaseId: 501, login: "impostor", organizationId: 99 });
    const quarantine = new TestCloudQuarantine(); const { adapter } = createCloudAdapter("GITHUB", { gateway, quarantine });
    await expect(collect(adapter.discoverUsers(cloudContext("collision")))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(quarantine.items).toEqual([expect.objectContaining({ externalObjectId: "github:identity:501", reasonCode: "DUPLICATE_EXTERNAL_ID" })]);
  });

  it("performs bounded exponential backoff and reports sustained outage without touching canonical state", async () => {
    const gateway = seededCloudGateway("AWS"), backoff = new InstantBackoff(); gateway.failuresRemaining = 2;
    const { adapter } = createCloudAdapter("AWS", { gateway, backoff }); await expect(collect(adapter.discoverUsers(cloudContext("retry")))).resolves.toHaveLength(3);
    expect(backoff.waits).toEqual([10, 20]);
    const outage = new TestCloudGateway(); outage.failuresRemaining = 20; const unavailable = createCloudAdapter("AWS", { gateway: outage, backoff: new InstantBackoff() }).adapter;
    const canonical = Object.freeze({ subjectId: "subject-canonical", lifecycleState: "ACTIVE" });
    await expect(unavailable.healthCheck(cloudContext("outage"))).resolves.toMatchObject({ status: "UNAVAILABLE", safeMessage: "Cloud provider health check failed" });
    expect(canonical).toEqual({ subjectId: "subject-canonical", lifecycleState: "ACTIVE" }); expect(outage.calls).toHaveLength(3);
  });

  it("makes read-only synchronization idempotent and rejects write-back", async () => {
    const { adapter, gateway } = createCloudAdapter("GOOGLE_WORKSPACE"); const context = cloudContext("sync");
    const first = await adapter.sync(context, { mode: "FULL", maximumItems: 3 }); const calls = gateway.calls.length;
    await expect(adapter.sync(context, { mode: "FULL", maximumItems: 3 })).resolves.toEqual(first); expect(gateway.calls).toHaveLength(calls);
    await expect(adapter.sync(context, { mode: "INCREMENTAL", maximumItems: 3 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(adapter.createIdentity(cloudContext(), { subjectId: "subject", displayName: "No write" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});

describe("Phase 6I canonical linking and provider replacement", () => {
  it("links cloud projections to one canonical Subject and emits linking provenance", async () => {
    const store = new MemoryCloudProjectionStore(), collisions = new MemoryCloudCollisions();
    const google = (await collect(createCloudAdapter("GOOGLE_WORKSPACE").adapter.discoverUsers(cloudContext("google"))))[0].identity;
    const linked = await linkCloudProjection({ context: cloudContext("link-google"), providerType: "GOOGLE_WORKSPACE", identity: google,
      candidateSubjectIds: ["subject-canonical"] }, store, collisions);
    expect(linked).toMatchObject({ subjectId: "subject-canonical", created: true,
      evidence: { eventType: "LINKED", subjectId: "subject-canonical", providerType: "GOOGLE_WORKSPACE" } });
  });
  it("replaces a provider projection without replacing the Subject", async () => {
    const store = new MemoryCloudProjectionStore(), collisions = new MemoryCloudCollisions();
    const google = (await collect(createCloudAdapter("GOOGLE_WORKSPACE").adapter.discoverUsers(cloudContext("g"))))[0].identity;
    const githubContext = { ...cloudContext("gh"), providerConnectionId: "github-connection" };
    const github = (await collect(createCloudAdapter("GITHUB").adapter.discoverUsers(githubContext)))[0].identity;
    const oldLink = await linkCloudProjection({ context: cloudContext("old"), providerType: "GOOGLE_WORKSPACE", identity: google,
      candidateSubjectIds: ["subject-canonical"] }, store, collisions);
    const newLink = await linkCloudProjection({ context: githubContext, providerType: "GITHUB", identity: github,
      candidateSubjectIds: ["subject-canonical"] }, store, collisions);
    expect(oldLink.subjectId).toBe(newLink.subjectId); expect(oldLink.identityAccountId).not.toBe(newLink.identityAccountId);
  });
  it("quarantines ambiguous mapping and forbids cross-tenant reuse", async () => {
    const store = new MemoryCloudProjectionStore(), collisions = new MemoryCloudCollisions(); const identity = identityFixture();
    await expect(linkCloudProjection({ context: cloudContext(), providerType: "GITHUB", identity,
      candidateSubjectIds: ["subject-a", "subject-b"] }, store, collisions)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(collisions.items).toHaveLength(1);
    await linkCloudProjection({ context: cloudContext("a"), providerType: "GITHUB", identity, candidateSubjectIds: ["subject-a"] }, store, collisions);
    await expect(linkCloudProjection({ context: { ...cloudContext("b"), tenantId: "tenant-b" }, providerType: "GITHUB", identity,
      candidateSubjectIds: ["subject-b"] }, store, collisions)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

class MemoryCloudProjectionStore implements CloudAccountProjectionStore {
  private values = new Map<string, { tenantId: string; subjectId: string; id: string }>();
  async link(context: ProviderOperationContext, input: Parameters<CloudAccountProjectionStore["link"]>[1]) {
    const key = `${context.organizationId}:${context.providerConnectionId}:${input.externalObjectId}`; const prior = this.values.get(key);
    if (prior && (prior.tenantId !== context.tenantId || prior.subjectId !== input.subjectId)) throw new ProviderAdapterError({ code: "CONFLICT", message: "collision" });
    const value = prior ?? { tenantId: context.tenantId, subjectId: input.subjectId, id: `account:${context.providerConnectionId}:${input.externalObjectId}` };
    this.values.set(key, value); return { identityAccountId: value.id, subjectId: value.subjectId, externalObjectId: input.externalObjectId,
      providerConnectionId: context.providerConnectionId, created: !prior };
  }
}
class MemoryCloudCollisions implements CloudLinkCollisionStore { items: unknown[] = []; async quarantine(_context: ProviderOperationContext, input: unknown) { this.items.push(input); } }
function identityFixture(): ProviderIdentity { return { ref: { externalObjectId: "github:identity:501" }, displayName: "Alice", status: "ACTIVE",
  attributes: {}, observedAt: "2026-09-23T00:00:00.000Z", suggestedSubjectKind: "HUMAN" }; }
