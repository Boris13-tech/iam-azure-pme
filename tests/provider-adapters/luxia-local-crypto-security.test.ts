import { describe, expect, it } from "vitest";
import { verifyPasskeyAssertion } from "../../lib/provider-adapters/implementations/luxia-local/webauthn";
import { verifyTotp } from "../../lib/provider-adapters/implementations/luxia-local/totp";
import type { LocalAuthenticatorRecord } from "../../lib/provider-adapters/implementations/luxia-local";
import { softwarePasskey } from "../helpers/software-passkey";

const reason = (run: () => unknown) => { try { run(); return "ACCEPTED"; } catch (error) { return (error as { safeDetails?: { reason?: string } }).safeDetails?.reason; } };

const authenticator: LocalAuthenticatorRecord = {
  id: "auth", identityAccountId: "account", type: "PASSKEY", status: "ACTIVE",
  credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", credentialFormatVersion: 1,
  algorithmId: "WEBAUTHN_ES256", algorithmVersion: 999, keyVersion: 1, verifierPolicyVersion: 1,
  hardwareBound: false, userVerificationRequired: false, credentialId: "credential",
  publicKey: "not-consulted", relyingPartyId: "local.luxia", allowedOrigin: "https://local.luxia", signCount: 0,
};

describe("LUXIA_LOCAL crypto fail-closed behavior", () => {
  it("rejects an unknown WebAuthn crypto version before parsing attacker-controlled fields", () => {
    expect(() => verifyPasskeyAssertion({ expectedChallenge: "challenge", authenticator,
      assertion: { credentialId: "credential", clientDataJSON: "x", authenticatorData: "x", signature: "x" } }))
      .toThrowError(expect.objectContaining({ code: "AUTHENTICATION_FAILED", safeDetails: { reason: "PASSKEY_UNSUPPORTED_CRYPTO_VERSION" } }));
  });

  it("refuses a signature counter that falls back, to zero included, and a cross-origin assertion", () => {
    const passkey = softwarePasskey();
    const record = { ...authenticator, algorithmVersion: 1, userVerificationRequired: true, credentialId: passkey.credentialId,
      publicKey: passkey.publicKeyPem, relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000" };
    const verify = (signCount: number, assertion: ReturnType<typeof passkey.assert>) =>
      reason(() => verifyPasskeyAssertion({ expectedChallenge: "challenge", authenticator: { ...record, signCount }, assertion }));
    expect(verify(0, passkey.assert("challenge", { counter: 0 }))).toBe("ACCEPTED"); // synced passkeys: always zero
    expect(verify(4, passkey.assert("challenge", { counter: 5 }))).toBe("ACCEPTED");
    expect(verify(5, passkey.assert("challenge", { counter: 5 }))).toBe("PASSKEY_REPLAY_DETECTED");
    expect(verify(5, passkey.assert("challenge", { counter: 0 }))).toBe("PASSKEY_REPLAY_DETECTED");
    expect(verify(0, passkey.assert("challenge", { counter: 0, crossOrigin: true }))).toBe("PASSKEY_CLIENT_DATA_MISMATCH");
  });

  it("rejects unknown TOTP algorithms and versions", () => {
    expect(verifyTotp(new Uint8Array([1, 2, 3]), "123456", Date.now(), undefined,
      { algorithmId: "UNKNOWN", algorithmVersion: 1 })).toBeNull();
    expect(verifyTotp(new Uint8Array([1, 2, 3]), "123456", Date.now(), undefined,
      { algorithmId: "TOTP_HMAC_SHA1", algorithmVersion: 999 })).toBeNull();
  });
});
