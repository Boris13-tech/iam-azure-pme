import { describe, expect, it } from "vitest";
import type { CustodySecretLease, SecretCustody, SecretCustodyScope, VersionedSecretReference } from "../../lib/identity";

class MemoryCustody implements SecretCustody {
  private readonly bytes = new Map<string, Uint8Array>();
  private version = 0;
  async generate(_scope: SecretCustodyScope, request: { purpose: VersionedSecretReference["purpose"]; algorithmId: string; algorithmVersion: number }): Promise<VersionedSecretReference> {
    const version = String(++this.version); const handle = `custody://opaque/${version}`;
    this.bytes.set(`${handle}@${version}`, new Uint8Array([1, 2, 3]));
    return { custodyProvider: "memory-test", handle, version, state: "ACTIVE", purpose: request.purpose,
      algorithmId: request.algorithmId, algorithmVersion: request.algorithmVersion };
  }
  async rotate(scope: SecretCustodyScope, current: VersionedSecretReference) {
    const next = await this.generate(scope, current);
    return { previous: { ...current, state: "VERIFY_ONLY" as const }, next };
  }
  async revoke(_scope: SecretCustodyScope, reference: VersionedSecretReference, _reason: "REVOKED" | "COMPROMISED") { this.bytes.delete(`${reference.handle}@${reference.version}`); }
  async withSecret<T>(_scope: SecretCustodyScope, reference: VersionedSecretReference, consumer: (lease: CustodySecretLease) => Promise<T>): Promise<T> {
    const value = this.bytes.get(`${reference.handle}@${reference.version}`); if (!value) throw new Error("SECRET_UNAVAILABLE");
    const lease: CustodySecretLease = { use: async (fn) => fn(value), toString: () => "[REDACTED]", toJSON: () => "[REDACTED]" };
    return consumer(lease);
  }
}

describe("Phase 6E secret custody contract", () => {
  const scope = { organizationId: "org", tenantId: "tenant" };
  it("returns opaque versioned references and redacts leases", async () => {
    const custody = new MemoryCustody();
    const reference = await custody.generate(scope, { purpose: "TOTP_SEED", algorithmId: "TOTP_HMAC_SHA1", algorithmVersion: 1 });
    expect(reference).toMatchObject({ handle: "custody://opaque/1", version: "1", state: "ACTIVE" });
    await custody.withSecret(scope, reference, async (lease) => {
      expect(String(lease)).toBe("[REDACTED]"); expect(JSON.stringify(lease)).toBe('"[REDACTED]"');
      expect(await lease.use((secret) => secret.byteLength)).toBe(3);
    });
    expect(JSON.stringify(reference)).not.toMatch(/1,2,3|privateKey|plaintext/i);
  });

  it("rotates by version and makes revoked material unavailable", async () => {
    const custody = new MemoryCustody(); const current = await custody.generate(scope, { purpose: "PRIVATE_KEY", algorithmId: "EVIDENCE_ES256", algorithmVersion: 1 });
    const rotated = await custody.rotate(scope, current);
    expect(rotated.previous.state).toBe("VERIFY_ONLY"); expect(rotated.next.version).not.toBe(current.version);
    await custody.revoke(scope, rotated.next, "COMPROMISED");
    await expect(custody.withSecret(scope, rotated.next, async () => true)).rejects.toThrow("SECRET_UNAVAILABLE");
  });
});
