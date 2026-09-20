import { describe, expect, it } from "vitest";
import {
  ProviderAdapterError,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderOperationContext,
} from "../../lib/provider-adapters";

export type ProviderAdapterContractFactory = (
  capabilities: Iterable<ProviderCapability>,
) => ProviderAdapter;

const allCapabilities: ProviderCapability[] = [
  "AUTHENTICATION",
  "IDENTITY_LIFECYCLE",
  "GROUP_DISCOVERY",
  "RESOURCE_DISCOVERY",
  "ACCESS_PROVISIONING",
  "INCREMENTAL_SYNC",
  "OFFLINE_OPERATION",
];

export function defineProviderAdapterContract(
  name: string,
  createAdapter: ProviderAdapterContractFactory,
): void {
  describe(`${name} provider contract`, () => {
    it("declares a stable type, contract version, and capabilities", () => {
      const adapter = createAdapter(allCapabilities);
      expect(adapter.type.trim()).not.toBe("");
      expect(adapter.contractVersion).toBe(1);
      expect(Array.from(adapter.capabilities()).sort()).toEqual(
        [...allCapabilities].sort(),
      );
    });

    it("rejects incomplete organization/tenant/connection/operation scope", async () => {
      const adapter = createAdapter(["IDENTITY_LIFECYCLE"]);
      const invalid = { ...context("invalid"), tenantId: "" };
      await expect(
        adapter.getUser(invalid, { externalObjectId: "fake:alice" }),
      ).rejects.toMatchObject({
        code: "INVALID_SCOPE",
        retryable: false,
      } satisfies Partial<ProviderAdapterError>);
    });

    it("fails unsupported capabilities explicitly", async () => {
      const adapter = createAdapter([]);
      await expect(
        adapter.createIdentity(context("unsupported"), {
          subjectId: "subject-1",
          displayName: "Alice",
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
      } satisfies Partial<ProviderAdapterError>);
    });

    it("isolates identities by organization, tenant, and provider connection", async () => {
      const adapter = createAdapter(["IDENTITY_LIFECYCLE"]);
      const source = context("create-alice");
      const created = await adapter.createIdentity(source, {
        subjectId: "subject-1",
        displayName: "Alice",
      });

      expect(created.identity).toBeDefined();
      await expect(
        adapter.getUser(
          { ...source, operationId: "lookup-source" },
          created.identity!,
        ),
      ).resolves.toMatchObject({ displayName: "Alice", status: "ACTIVE" });
      await expect(
        adapter.getUser(
          { ...source, tenantId: "tenant-b", operationId: "lookup-other" },
          created.identity!,
        ),
      ).resolves.toBeNull();
    });

    it("replays equivalent mutations and rejects operation-id conflicts", async () => {
      const adapter = createAdapter(["IDENTITY_LIFECYCLE"]);
      const operation = context("idempotent-create");
      const command = { subjectId: "subject-1", displayName: "Alice" };

      const first = await adapter.createIdentity(operation, command);
      const replay = await adapter.createIdentity(operation, command);
      expect(replay).toEqual(first);

      await expect(
        adapter.createIdentity(operation, {
          subjectId: "subject-2",
          displayName: "Mallory",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      } satisfies Partial<ProviderAdapterError>);
    });

    it("supports discovery and explicit disablement without crossing scope", async () => {
      const adapter = createAdapter(["IDENTITY_LIFECYCLE"]);
      const createContext = context("create-for-discovery");
      const created = await adapter.createIdentity(createContext, {
        subjectId: "subject-1",
        displayName: "Alice",
      });
      const discovered = await collect(
        adapter.discoverUsers({ ...createContext, operationId: "discover" }),
      );
      expect(discovered).toHaveLength(1);

      await adapter.disableIdentity(
        { ...createContext, operationId: "disable" },
        created.identity!,
      );
      await expect(
        adapter.getUser(
          { ...createContext, operationId: "lookup-disabled" },
          created.identity!,
        ),
      ).resolves.toMatchObject({ status: "DISABLED" });
    });

    it("returns bounded, secret-free health information", async () => {
      const adapter = createAdapter([]);
      const health = await adapter.healthCheck(context("health"));
      expect(health.status).toBe("HEALTHY");
      expect(JSON.stringify(health).toLowerCase()).not.toContain("secret");
      expect(JSON.stringify(health).toLowerCase()).not.toContain("token");
    });
  });
}

export function context(operationId: string): ProviderOperationContext {
  return {
    organizationId: "organization-a",
    tenantId: "tenant-a",
    providerConnectionId: "provider-connection-a",
    operationId,
  };
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of items) collected.push(item);
  return collected;
}
