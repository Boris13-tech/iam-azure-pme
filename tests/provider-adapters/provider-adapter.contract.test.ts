import { describe, expect, it } from "vitest";
import {
  ProviderAdapterRegistry,
  SecretLease,
  type AuthenticationProvider,
  type ProviderAdapter,
  type ProviderCapability,
} from "../../lib/provider-adapters";
import { FakeProviderAdapter } from "./fake-provider-adapter";
import {
  context,
  defineProviderAdapterContract,
} from "./provider-adapter-contract-kit";

defineProviderAdapterContract(
  "FakeProviderAdapter",
  (capabilities) => new FakeProviderAdapter(capabilities),
);

describe("Phase 6A provider framework", () => {
  it("registers adapters once and resolves required capabilities", () => {
    const registry = new ProviderAdapterRegistry();
    const adapter = new FakeProviderAdapter(["IDENTITY_LIFECYCLE"]);
    registry.register(adapter);

    expect(registry.resolve("FAKE")).toBe(adapter);
    expect(
      registry.resolveWithCapability("FAKE", "IDENTITY_LIFECYCLE"),
    ).toBe(adapter);
    expect(() => registry.resolveWithCapability("FAKE", "AUTHENTICATION"))
      .toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CAPABILITY" }));
    expect(() => registry.register(adapter)).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(() => registry.resolve("MISSING")).toThrowError(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("redacts secret leases in strings, JSON, and inspection", async () => {
    const raw = "not-for-logs";
    const lease = new SecretLease(new TextEncoder().encode(raw));
    expect(String(lease)).toBe("[REDACTED]");
    expect(JSON.stringify({ lease })).toBe('{"lease":"[REDACTED]"}');
    expect(lease.read((bytes) => new TextDecoder().decode(bytes))).toBe(raw);
    lease.dispose();
    expect(() => lease.read(() => null)).toThrow("disposed");
  });

  it("keeps authentication optional and capability guarded", async () => {
    const capabilities: ProviderCapability[] = ["AUTHENTICATION"];
    const adapter = new FakeProviderAdapter(capabilities);
    const auth = adapter as ProviderAdapter & AuthenticationProvider;
    const operationContext = context("auth-start");
    const challenge = await auth.beginAuthentication({
      context: operationContext,
      returnTo: "/dashboard",
    });
    const verified = await auth.completeAuthentication({
      context: { ...operationContext, operationId: "auth-complete" },
      transactionId: challenge.transactionId,
      response: { externalObjectId: "fake:alice" },
    });

    expect(verified.identity.externalObjectId).toBe("fake:alice");
    expect(verified.assuranceLevel).toBe("FAKE_TEST_ONLY");
  });
});
