import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getRecoveryContext: vi.fn(),
  sessionFindFirst: vi.fn(),
  evidenceFindFirst: vi.fn(),
  subjectFindUniqueOrThrow: vi.fn(),
  assignmentFindMany: vi.fn(),
  connectionFindFirst: vi.fn(),
  identityAccountFindFirst: vi.fn(),
  localIdentityFindFirst: vi.fn(),
  localIdentityUpdate: vi.fn(),
  localAuthenticatorUpdateMany: vi.fn(),
  auditEventCreate: vi.fn(),
  discoverUsers: vi.fn(),
  beginEnrollment: vi.fn(),
  enrollPasskey: vi.fn(),
  beginRecoveryEnrollment: vi.fn(),
  completeRecoveryEnrollment: vi.fn(),
}));

vi.mock("@/lib/auth/require-auth", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("../../lib/auth/recovery-session", () => ({ getRecoveryContext: mocks.getRecoveryContext }));
vi.mock("../../lib/auth/recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth/recovery")>();
  return {
    ...actual,
    beginRecoveryEnrollment: mocks.beginRecoveryEnrollment,
    completeRecoveryEnrollment: mocks.completeRecoveryEnrollment,
  };
});
vi.mock("@/lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      session: { findFirst: mocks.sessionFindFirst },
      authenticationEvidence: { findFirst: mocks.evidenceFindFirst },
      subject: { findUniqueOrThrow: mocks.subjectFindUniqueOrThrow },
      assignment: { findMany: mocks.assignmentFindMany },
      providerConnection: { findFirst: mocks.connectionFindFirst },
      identityAccount: { findFirst: mocks.identityAccountFindFirst },
      localIdentity: {
        findFirst: mocks.localIdentityFindFirst,
        update: mocks.localIdentityUpdate,
      },
      localAuthenticator: { updateMany: mocks.localAuthenticatorUpdateMany },
      canonicalAdminAuditEvent: { create: mocks.auditEventCreate },
    }),
  ),
}));
vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      session: { findFirst: mocks.sessionFindFirst },
      authenticationEvidence: { findFirst: mocks.evidenceFindFirst },
      subject: { findUniqueOrThrow: mocks.subjectFindUniqueOrThrow },
      assignment: { findMany: mocks.assignmentFindMany },
      providerConnection: { findFirst: mocks.connectionFindFirst },
      identityAccount: { findFirst: mocks.identityAccountFindFirst },
      localIdentity: {
        findFirst: mocks.localIdentityFindFirst,
        update: mocks.localIdentityUpdate,
      },
      localAuthenticator: { updateMany: mocks.localAuthenticatorUpdateMany },
      canonicalAdminAuditEvent: { create: mocks.auditEventCreate },
    }),
  ),
}));
vi.mock("@/lib/auth/providers/luxia-local", () => ({
  localProviderContext: (input: Record<string, string>) => ({ ...input, operationId: "op-enroll" }),
  getLuxiaLocalAdapter: () => ({
    discoverUsers: mocks.discoverUsers,
    beginEnrollment: mocks.beginEnrollment,
    enrollPasskey: mocks.enrollPasskey,
  }),
}));

import { POST as localEnrollBegin } from "../../app/api/auth/local/enrollment/begin/route";
import { POST as localEnrollComplete } from "../../app/api/auth/local/enrollment/complete/route";
import { POST as recoveryEnrollBegin } from "../../app/api/auth/recovery/enrollment/begin/route";
import { POST as recoveryEnrollComplete } from "../../app/api/auth/recovery/enrollment/complete/route";
import { POST as logoutPost } from "../../app/auth/logout/route";
import { mutationChangeId } from "../../lib/admin/http";
import { verifyMutationOrigin } from "../../lib/security/csrf-origin";
import { PrismaLocalIdentityStore } from "../../lib/provider-adapters/implementations/luxia-local/prisma-local-identity-store";
import { verifyPasskeyAssertion } from "../../lib/provider-adapters/implementations/luxia-local/webauthn";
import { verifyPasskeyRegistration } from "../../lib/provider-adapters/implementations/luxia-local/webauthn-registration";
import type { LocalAuthenticatorRecord } from "../../lib/provider-adapters/implementations/luxia-local";

const AUTH_CTX = {
  sessionId: "sess-1",
  organizationId: "org-1",
  tenantId: "tenant-1",
  subjectId: "subj-1",
  identityAccountId: "acc-1",
};

function buildCustomPasskey(rpId = "iam-azure-pme.vercel.app", origin = "https://iam-azure-pme.vercel.app") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rawId = randomBytes(32);
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const rpHash = createHash("sha256").update(rpId).digest();

  return {
    credentialId: rawId.toString("base64url"),
    register(challenge: string, flags: number, initialSignCount: number) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(initialSignCount);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(rawId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), count, Buffer.alloc(16), idLen, rawId, cose]);
      return {
        credentialId: rawId.toString("base64url"),
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url"),
      };
    },
    assert(challenge: string, flags: number, signCount: number) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
      );
      const count = Buffer.alloc(4);
      count.writeUInt32BE(signCount);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), count]);
      const sig = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
        privateKey,
      );
      return {
        credentialId: rawId.toString("base64url"),
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: sig.toString("base64url"),
      };
    },
  };
}

describe("G2-R04 (F-04): Passkey enrollment CSRF, step-up authentication, counters, and FULL/RECOVERY isolation", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...savedEnv,
      VERCEL_ENV: "production",
      NEXT_PUBLIC_APP_URL: "https://iam-azure-pme.vercel.app",
    };

    const now = new Date();
    mocks.requireAuth.mockResolvedValue(AUTH_CTX);
    mocks.sessionFindFirst.mockResolvedValue({ createdAt: new Date(now.getTime() - 60_000) });
    mocks.evidenceFindFirst.mockResolvedValue({ method: "FEDERATED_OIDC" });
    mocks.subjectFindUniqueOrThrow.mockResolvedValue({ id: "subj-1", name: "Admin" });
    mocks.assignmentFindMany.mockResolvedValue([{ entitlement: { key: "providers.manage" } }]);
    mocks.connectionFindFirst.mockResolvedValue({ id: "conn-local-1" });
    mocks.identityAccountFindFirst.mockResolvedValue({ id: "acc-1" });
    mocks.localIdentityFindFirst.mockResolvedValue(null);
    mocks.discoverUsers.mockImplementation(async function* () {
      yield {
        identity: {
          principalName: "admin@luxia.test",
          attributes: { subjectId: "subj-1", identityAccountId: "acc-1" },
        },
      };
    });
    mocks.beginEnrollment.mockResolvedValue({
      transactionId: "tx-1",
      publicChallenge: { challenge: "chal-1234567890abcdef" },
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    });
    mocks.enrollPasskey.mockResolvedValue("authn-1");
  });

  it("enforces explicit Origin & Fetch-Metadata CSRF policy even when x-luxia-change-id is supplied", async () => {
    // Missing Origin in Production -> 403 even WITH x-luxia-change-id
    const missingOriginReq = new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-luxia-change-id": "change-present-does-not-bypass-csrf",
      },
      body: JSON.stringify({ principalName: "admin@luxia.test" }),
    });
    const resMissing = await localEnrollBegin(missingOriginReq);
    expect(resMissing.status).toBe(403);
    expect(await resMissing.json()).toEqual({ error: "CSRF_ORIGIN_INVALID" });

    // Cross-origin Origin -> 403 on local enrollment, recovery enrollment, logout, and canonical mutationChangeId
    const crossOriginHeaders = {
      "content-type": "application/json",
      origin: "https://evil.example",
      "x-luxia-change-id": "change-123",
    };
    expect(
      (
        await localEnrollBegin(
          new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
            method: "POST",
            headers: crossOriginHeaders,
            body: JSON.stringify({ principalName: "admin@luxia.test" }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await localEnrollComplete(
          new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/complete", {
            method: "POST",
            headers: crossOriginHeaders,
            body: JSON.stringify({}),
          }),
        )
      ).status,
    ).toBe(403);

    mocks.getRecoveryContext.mockResolvedValue({ recovery: { ...AUTH_CTX } });
    expect(
      (
        await recoveryEnrollBegin(
          new Request("https://iam-azure-pme.vercel.app/api/auth/recovery/enrollment/begin", {
            method: "POST",
            headers: { origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await recoveryEnrollComplete(
          new Request("https://iam-azure-pme.vercel.app/api/auth/recovery/enrollment/complete", {
            method: "POST",
            headers: crossOriginHeaders,
            body: JSON.stringify({}),
          }),
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await logoutPost(
          new NextRequest("https://iam-azure-pme.vercel.app/auth/logout", {
            method: "POST",
            headers: { origin: "null" },
          }),
        )
      ).status,
    ).toBe(403);

    expect(() =>
      mutationChangeId(
        new Request("https://iam-azure-pme.vercel.app/api/canonical/subjects", {
          method: "POST",
          headers: crossOriginHeaders,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "CSRF_ORIGIN_INVALID", httpStatus: 403 }));

    // Sec-Fetch-Site: cross-site is refused even if Origin were absent in non-Production
    expect(
      verifyMutationOrigin(
        new Request("http://localhost:3000/api/canonical/subjects", {
          method: "POST",
          headers: { "sec-fetch-site": "cross-site" },
        }),
        { NODE_ENV: "development", NEXT_PUBLIC_APP_URL: "http://localhost:3000" },
      ),
    ).toEqual({ ok: false, reason: "CSRF_FETCH_SITE_FORBIDDEN" });
  });

  it("preserves strict FULL vs RECOVERY separation (401 before CSRF/step-up when session scope mismatches)", async () => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    const res1 = await localEnrollBegin(
      new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
        method: "POST",
        body: JSON.stringify({ principalName: "admin@luxia.test" }),
      }),
    );
    expect(res1.status).toBe(401);

    mocks.getRecoveryContext.mockResolvedValueOnce(null);
    const res2 = await recoveryEnrollBegin(
      new Request("https://iam-azure-pme.vercel.app/api/auth/recovery/enrollment/begin", { method: "POST" }),
    );
    expect(res2.status).toBe(401);
  });

  it("enforces <= 15m step-up authentication for enrollment and requires FEDERATED_OIDC to unlock a LOCKED identity", async () => {
    const validHeaders = {
      "content-type": "application/json",
      origin: "https://iam-azure-pme.vercel.app",
      "sec-fetch-site": "same-origin",
      "x-luxia-change-id": "self:passkey-enroll-begin:11111111",
    };

    // Stale session (no recent session/evidence match) -> 403 RECENT_AUTHENTICATION_REQUIRED
    mocks.sessionFindFirst.mockResolvedValueOnce(null);
    const staleRes = await localEnrollBegin(
      new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
        method: "POST",
        headers: validHeaders,
        body: JSON.stringify({ principalName: "admin@luxia.test" }),
      }),
    );
    expect(staleRes.status).toBe(403);
    expect(await staleRes.json()).toEqual({ error: "RECENT_AUTHENTICATION_REQUIRED" });

    // LOCKED LocalIdentity with a PASSKEY session -> 403 FEDERATED_STEP_UP_REQUIRED (cannot clear lock without IdP step-up)
    mocks.evidenceFindFirst.mockResolvedValueOnce({ method: "PASSKEY" });
    mocks.localIdentityFindFirst.mockResolvedValueOnce({ id: "local-locked-1" });
    const nonFederatedUnlock = await localEnrollBegin(
      new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
        method: "POST",
        headers: validHeaders,
        body: JSON.stringify({ principalName: "admin@luxia.test" }),
      }),
    );
    expect(nonFederatedUnlock.status).toBe(403);
    expect(await nonFederatedUnlock.json()).toEqual({ error: "FEDERATED_STEP_UP_REQUIRED" });
    expect(mocks.localIdentityUpdate).not.toHaveBeenCalled();

    // Fresh FEDERATED_OIDC session unlocks LOCKED LocalIdentity and issues enrollment challenge
    mocks.evidenceFindFirst.mockResolvedValueOnce({ method: "FEDERATED_OIDC" });
    mocks.localIdentityFindFirst.mockResolvedValueOnce({ id: "local-locked-1" });
    const federatedUnlock = await localEnrollBegin(
      new Request("https://iam-azure-pme.vercel.app/api/auth/local/enrollment/begin", {
        method: "POST",
        headers: validHeaders,
        body: JSON.stringify({ principalName: "admin@luxia.test" }),
      }),
    );
    expect(federatedUnlock.status).toBe(200);
    expect(mocks.localIdentityUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.auditEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operation: "LOCAL_IDENTITY.RECOVERY_UNLOCK",
          changeId: "self:passkey-enroll-begin:11111111:unlock",
        }),
      }),
    );
  });

  it("supports synced & zero-counter passkeys, anchors initial registration signCount, rejects invalid BE/BS flags, and guards DB races", async () => {
    const pk = buildCustomPasskey();
    const challenge = "Q2hhbGxlbmdlRm9yU3luY2VkUGFzc2tleVRlc3QxMjM";

    // 1. Multi-device synced passkey (BE=1, BS=1 => 0x40|0x10|0x08|0x04|0x01 = 0x5d) with counter=0
    const syncedReg = verifyPasskeyRegistration({
      ...pk.register(challenge, 0x5d, 0),
      expectedChallenge: challenge,
      expectedOrigin: "https://iam-azure-pme.vercel.app",
      rpId: "iam-azure-pme.vercel.app",
    });
    expect(syncedReg.signCount).toBe(0);
    expect(syncedReg.backupEligible).toBe(true);

    const baseRecord: LocalAuthenticatorRecord = {
      id: "authn-synced",
      identityAccountId: "acc-1",
      type: "PASSKEY",
      status: "ACTIVE",
      credentialSchemaVersion: 2,
      credentialFormat: "WEBAUTHN_PUBLIC_KEY",
      credentialFormatVersion: 1,
      algorithmId: "WEBAUTHN_ES256",
      algorithmVersion: 1,
      keyVersion: 1,
      verifierPolicyVersion: 1,
      hardwareBound: false,
      userVerificationRequired: true,
      credentialId: syncedReg.credentialId,
      publicKey: syncedReg.publicKeyPem,
      relyingPartyId: "iam-azure-pme.vercel.app",
      allowedOrigin: "https://iam-azure-pme.vercel.app",
      signCount: 0,
    };

    // Repeated assertions with counter=0 on synced passkeys (0x1d => BE=1, BS=1, UV=1, UP=1) succeed cleanly
    for (let i = 0; i < 3; i++) {
      expect(
        verifyPasskeyAssertion({
          assertion: pk.assert(challenge, 0x1d, 0),
          authenticator: baseRecord,
          expectedChallenge: challenge,
        }),
      ).toBe(0);
    }

    // 2. Hardware security key reporting initial signCount=42 at registration anchors at 42
    const hwReg = verifyPasskeyRegistration({
      ...pk.register(challenge, 0x45, 42),
      expectedChallenge: challenge,
      expectedOrigin: "https://iam-azure-pme.vercel.app",
      rpId: "iam-azure-pme.vercel.app",
    });
    expect(hwReg.signCount).toBe(42);
    expect(hwReg.backupEligible).toBe(false);

    // Cloned assertion presenting counter=10 (< 42) is immediately rejected
    expect(() =>
      verifyPasskeyAssertion({
        assertion: pk.assert(challenge, 0x05, 10),
        authenticator: { ...baseRecord, signCount: hwReg.signCount },
        expectedChallenge: challenge,
      }),
    ).toThrowError(expect.objectContaining({ safeDetails: { reason: "PASSKEY_REPLAY_DETECTED" } }));

    // 3. Invalid W3C WebAuthn §6.1 flags (BE=0, BS=1 => 0x55 on reg, 0x15 on assert) are rejected
    expect(() =>
      verifyPasskeyRegistration({
        ...pk.register(challenge, 0x55, 0),
        expectedChallenge: challenge,
        expectedOrigin: "https://iam-azure-pme.vercel.app",
        rpId: "iam-azure-pme.vercel.app",
      }),
    ).toThrowError(expect.objectContaining({ safeDetails: { reason: "REGISTRATION_BACKUP_FLAGS_INVALID" } }));

    expect(() =>
      verifyPasskeyAssertion({
        assertion: pk.assert(challenge, 0x15, 0),
        authenticator: baseRecord,
        expectedChallenge: challenge,
      }),
    ).toThrowError(expect.objectContaining({ safeDetails: { reason: "PASSKEY_BACKUP_FLAGS_INVALID" } }));

    // 4. DB store race guard: signCount=0 update requires WHERE signCount = 0 so it can never overwrite >0
    const store = new PrismaLocalIdentityStore();
    mocks.localAuthenticatorUpdateMany.mockResolvedValue({ count: 1 });
    await store.advanceAuthenticator(
      { organizationId: "org-1", tenantId: "tenant-1", providerConnectionId: "conn-1", operationId: "op-1" },
      "authn-synced",
      { signCount: 0 },
    );
    expect(mocks.localAuthenticatorUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "authn-synced", signCount: 0 }),
      }),
    );

    await store.advanceAuthenticator(
      { organizationId: "org-1", tenantId: "tenant-1", providerConnectionId: "conn-1", operationId: "op-2" },
      "authn-synced",
      { signCount: 43 },
    );
    expect(mocks.localAuthenticatorUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "authn-synced", signCount: { lt: 43 } }),
      }),
    );
  });
});
