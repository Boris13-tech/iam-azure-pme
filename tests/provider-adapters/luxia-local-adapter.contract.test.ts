import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LuxiaLocalAdapter } from "../../lib/provider-adapters/implementations/luxia-local";
import { context, defineProviderAdapterContract } from "./provider-adapter-contract-kit";
import { MemoryLocalStore, MemorySecrets } from "./luxia-local-test-kit";

const make = (now = () => new Date("2026-09-21T12:00:00.000Z")) => {
  const store = new MemoryLocalStore(); const secrets = new MemorySecrets();
  return { store, secrets, adapter: new LuxiaLocalAdapter(store, secrets, now) };
};
defineProviderAdapterContract("LuxiaLocalAdapter", {
  createAdapter: () => make().adapter,
  expectedCapabilities: ["AUTHENTICATION", "IDENTITY_LIFECYCLE", "OFFLINE_OPERATION"],
});

describe("LUXIA_LOCAL authentication security", () => {
  it("links a local account to the supplied canonical Subject and isolates tenant scope", async () => {
    const { adapter } = make(); const created = await adapter.createIdentity(context("create"), { subjectId: "subject-canonical", displayName: "Alice", principalName: "Alice@Local" });
    await expect(adapter.getUser({ ...context("lookup"), tenantId: "other" }, created.identity!)).resolves.toBeNull();
    await expect(adapter.getUser(context("lookup"), created.identity!)).resolves.toMatchObject({ attributes: { subjectId: "subject-canonical" } });
  });

  it("verifies a WebAuthn assertion, origin, RP and monotonic counter; rejects replay", async () => {
    const { adapter, store } = make(); const created = await adapter.createIdentity(context("create-passkey"), { subjectId: "subject-1", displayName: "Alice", principalName: "alice" });
    const identity = await adapter.getUser(context("lookup-passkey"), created.identity!); const account = identity!.attributes.identityAccountId as string;
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" }); const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const enrollment = await adapter.beginEnrollment(context("begin-enroll-passkey"), account);
    const authenticatorId = await adapter.enrollPasskey(context("enroll-passkey"), { identityAccountId: account, enrollmentTransactionId: enrollment.transactionId, enrollmentChallenge: String(enrollment.publicChallenge!.challenge), credentialId: "credential-1", publicKey, relyingPartyId: "local.luxia", allowedOrigin: "https://local.luxia" });
    expect([...store.authenticators.values()][0]).toMatchObject({ credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1, keyVersion: 1 });
    const start = await adapter.beginAuthentication({ context: context("begin-passkey"), loginHint: "alice" });
    const challenge = String(start.publicChallenge!.challenge); const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://local.luxia" })).toString("base64url");
    const authData = Buffer.alloc(37); createHash("sha256").update("local.luxia").digest().copy(authData); authData[32] = 1; authData.writeUInt32BE(1, 33);
    const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest()]);
    const response = { externalObjectId: created.identity!.externalObjectId, challenge, authenticatorId, credentialId: "credential-1", clientDataJSON, authenticatorData: authData.toString("base64url"), signature: sign("sha256", signed, pair.privateKey).toString("base64url"), credentialType: "PASSKEY" };
    await expect(adapter.completeAuthentication({ context: context("complete-passkey"), transactionId: start.transactionId, response })).resolves.toMatchObject({ assuranceLevel: "LOCAL_PASSKEY", evidence: { method: "PASSKEY", outcome: "VERIFIED", assurance: { phishingResistant: true }, provenance: { source: "LOCAL_VERIFIER", offline: true, algorithmId: "WEBAUTHN_ES256", algorithmVersion: 1, keyId: authenticatorId, keyVersion: "1" } } });
    await expect(adapter.completeAuthentication({ context: context("replay-passkey"), transactionId: start.transactionId, response })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("accepts local TOTP once per time step and never persists the secret value", async () => {
    const { adapter, store, secrets } = make(); const secret = Buffer.from("12345678901234567890"); secrets.set("vault://totp/alice", secret);
    const created = await adapter.createIdentity(context("create-totp"), { subjectId: "subject-1", displayName: "Alice", principalName: "alice" });
    const identity = await adapter.getUser(context("lookup-totp"), created.identity!); const account = identity!.attributes.identityAccountId as string;
    const enrollment = await adapter.beginEnrollment(context("begin-enroll-totp"), account);
    const authId = await adapter.enrollTotp(context("enroll-totp"), { identityAccountId: account, enrollmentTransactionId: enrollment.transactionId, enrollmentChallenge: String(enrollment.publicChallenge!.challenge), secretRef: { key: "vault://totp/alice" } });
    const challenge = await adapter.beginAuthentication({ context: context("begin-totp"), loginHint: "alice" });
    const totp = totpAt(secret, Date.parse("2026-09-21T12:00:00.000Z"));
    const response = { externalObjectId: created.identity!.externalObjectId, challenge: String(challenge.publicChallenge!.challenge), authenticatorId: authId, credentialType: "TOTP", totp };
    await expect(adapter.completeAuthentication({ context: context("complete-totp"), transactionId: challenge.transactionId, response })).resolves.toMatchObject({ assuranceLevel: "LOCAL_TOTP" });
    expect(JSON.stringify([...store.authenticators.values()])).not.toContain(secret.toString());
    const second = await adapter.beginAuthentication({ context: context("begin-totp-2"), loginHint: "alice" });
    await expect(adapter.completeAuthentication({ context: context("complete-totp-2"), transactionId: second.transactionId, response: { ...response, challenge: String(second.publicChallenge!.challenge) } })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("consumes recovery codes once and revocation removes an authenticator", async () => {
    const { adapter } = make(); const created = await adapter.createIdentity(context("create-recovery"), { subjectId: "subject-1", displayName: "Alice", principalName: "alice" });
    const identity = await adapter.getUser(context("lookup-recovery"), created.identity!); const account = identity!.attributes.identityAccountId as string;
    const enrollment = await adapter.beginEnrollment(context("begin-enroll-recovery"), account);
    const authId = await adapter.enrollTotp(context("enroll-recovery"), { identityAccountId: account, enrollmentTransactionId: enrollment.transactionId, enrollmentChallenge: String(enrollment.publicChallenge!.challenge), secretRef: { key: "vault://x" } });
    const [code] = await adapter.issueRecoveryCodes(context("issue-recovery"), account, 1); const first = await adapter.beginAuthentication({ context: context("begin-recovery"), loginHint: "alice" });
    const response = { externalObjectId: created.identity!.externalObjectId, challenge: String(first.publicChallenge!.challenge), credentialType: "RECOVERY_CODE", recoveryCode: code };
    await expect(adapter.completeAuthentication({ context: context("complete-recovery"), transactionId: first.transactionId, response })).resolves.toMatchObject({ assuranceLevel: "LOCAL_RECOVERY" });
    const second = await adapter.beginAuthentication({ context: context("begin-recovery-2"), loginHint: "alice" });
    await expect(adapter.completeAuthentication({ context: context("complete-recovery-2"), transactionId: second.transactionId, response: { ...response, challenge: String(second.publicChallenge!.challenge) } })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await adapter.revokeAuthenticator(context("revoke"), authId);
  });

  it("authenticates offline without fetch or network dependencies", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const secret = Buffer.from("12345678901234567890"); const { adapter, secrets } = make(); secrets.set("vault://offline", secret);
    const created = await adapter.createIdentity(context("offline-create"), { subjectId: "subject-offline", displayName: "Offline", principalName: "offline" });
    const identity = await adapter.getUser(context("offline-get"), created.identity!); const account = identity!.attributes.identityAccountId as string; const enrollment = await adapter.beginEnrollment(context("offline-enroll-begin"), account); const authId = await adapter.enrollTotp(context("offline-enroll"), { identityAccountId: account, enrollmentTransactionId: enrollment.transactionId, enrollmentChallenge: String(enrollment.publicChallenge!.challenge), secretRef: { key: "vault://offline" } });
    const challenge = await adapter.beginAuthentication({ context: context("offline-begin"), loginHint: "offline" });
    await expect(adapter.completeAuthentication({ context: context("offline-complete"), transactionId: challenge.transactionId, response: { externalObjectId: created.identity!.externalObjectId, challenge: String(challenge.publicChallenge!.challenge), authenticatorId: authId, credentialType: "TOTP", totp: totpAt(secret, Date.parse("2026-09-21T12:00:00.000Z")) } })).resolves.toMatchObject({ assuranceLevel: "LOCAL_TOTP" });
    expect(network).not.toHaveBeenCalled(); network.mockRestore();
  });

  it("makes enrollment challenges single-use", async () => {
    const { adapter } = make(); const created = await adapter.createIdentity(context("single-use-create"), { subjectId: "subject-1", displayName: "Alice", principalName: "alice" });
    const identity = await adapter.getUser(context("single-use-get"), created.identity!); const account = identity!.attributes.identityAccountId as string;
    const enrollment = await adapter.beginEnrollment(context("single-use-begin"), account); const input = { identityAccountId: account, enrollmentTransactionId: enrollment.transactionId, enrollmentChallenge: String(enrollment.publicChallenge!.challenge), secretRef: { key: "vault://first" } };
    await adapter.enrollTotp(context("single-use-first"), input);
    await expect(adapter.enrollTotp(context("single-use-replay"), { ...input, secretRef: { key: "vault://second" } })).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });
});

function totpAt(secret: Buffer, nowMs: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30000)));
  const mac = createHmac("sha1", secret).update(counter).digest(); const offset = mac[19] & 15;
  const binary = ((mac[offset] & 127) << 24) | ((mac[offset + 1] & 255) << 16) | ((mac[offset + 2] & 255) << 8) | (mac[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, "0");
}
