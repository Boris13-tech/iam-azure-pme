import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registrationChallenge, verifyPasskeyRegistration } from "../../lib/provider-adapters/implementations/luxia-local/webauthn-registration";
import { signupCodeHash } from "../../lib/onboarding/signup";
import { generateSignupCode } from "../../scripts/operators/signup-codes";
import { softwarePasskey } from "../helpers/software-passkey";

const challenge = "Q2hhbGxlbmdlRm9yUmVnaXN0cmF0aW9uVGVzdDEyMzQ";
const expected = { expectedChallenge: challenge, expectedOrigin: "http://localhost:3000", rpId: "localhost" };
const reason = (run: () => unknown) => { try { run(); return "ACCEPTED"; } catch (error) { return (error as { safeDetails?: { reason?: string } }).safeDetails?.reason; } };

describe("Passkey registration checks (no session: signup and invitations)", () => {
  it("accepts a well-formed ES256 registration and returns the bound key", () => {
    const passkey = softwarePasskey();
    const registration = passkey.register(challenge);
    expect(registrationChallenge(registration.clientDataJSON)).toBe(challenge);
    const result = verifyPasskeyRegistration({ ...registration, ...expected });
    expect(result.credentialId).toBe(passkey.credentialId);
    expect(result.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
  });

  it("refuses every mismatch", () => {
    const passkey = softwarePasskey();
    const other = softwarePasskey();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const cases: Array<[string, Parameters<typeof passkey.register>[1], string?]> = [
      ["REGISTRATION_CLIENT_DATA_MISMATCH", { type: "webauthn.get" }],
      ["REGISTRATION_CLIENT_DATA_MISMATCH", { origin: "https://evil.example" }],
      ["REGISTRATION_RP_MISMATCH", { rpId: "evil.example" }],
      ["REGISTRATION_USER_VERIFICATION_REQUIRED", { flags: 0x41 }],
      ["REGISTRATION_USER_PRESENCE_REQUIRED", { flags: 0x44 }],
      ["REGISTRATION_CREDENTIAL_DATA_MISSING", { flags: 0x05 }],
      ["REGISTRATION_CREDENTIAL_MISMATCH", { credentialId: other.credentialId }],
      ["REGISTRATION_PUBLIC_KEY_MISMATCH", { publicKey: other.register(challenge).publicKey }],
      ["REGISTRATION_ALGORITHM_UNSUPPORTED", { publicKey: rsa }],
    ];
    for (const [code, overrides] of cases) expect(reason(() => verifyPasskeyRegistration({ ...passkey.register(challenge, overrides), ...expected })), code).toBe(code);
    expect(reason(() => verifyPasskeyRegistration({ ...passkey.register("another-challenge-value-123"), ...expected }))).toBe("REGISTRATION_CLIENT_DATA_MISMATCH");
    expect(reason(() => verifyPasskeyRegistration({ ...passkey.register(challenge), clientDataJSON: "not json!", ...expected }))).toBe("REGISTRATION_CLIENT_DATA_INVALID");
  });

  it("beta codes: ~98-bit random, canonical comparison, only the hash is ever stored", () => {
    const codes = new Set(Array.from({ length: 200 }, generateSignupCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^LUXIA(-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{5}){4}$/);
    const code = [...codes][0];
    expect(signupCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
    expect(signupCodeHash(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(signupCodeHash(code));
    expect(signupCodeHash("short")).toBeNull();
    const cli = readFileSync("scripts/operators/signup-codes.ts", "utf8");
    expect(cli).toContain("codeHash: signupCodeHash(code)!");
    expect(cli).not.toMatch(/console\.log\([^)]*codeHash/);
  });

  it("signup never takes authority, tenant or organization from the browser", () => {
    const signup = readFileSync("lib/onboarding/signup.ts", "utf8");
    expect(signup).toContain("grant(LUXIA_ORG_ADMIN_V1.entitlements");
    expect(signup).toContain("grant(GOVERNANCE_ADMIN_V2");
    expect(signup).not.toMatch(/input\.(role|entitlements|tenantId|organizationId|slug)\b/);
    const complete = readFileSync("app/api/auth/signup/complete/route.ts", "utf8");
    expect(complete).not.toMatch(/body\.(organization|slug|tenantId|role)/);
  });
});
