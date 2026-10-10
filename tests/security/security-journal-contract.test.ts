import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { entraSignInEvidence } from "../../lib/auth/sign-in-evidence";
import { compareEntries, decodeCursor, encodeCursor } from "../../lib/audit/security-journal";
import { ASSURANCE_LABELS, OPERATION_LABELS, SIGN_IN_METHOD_LABELS } from "../../lib/ui/activity-labels";

const identity = { organizationId: "o", tenantId: "t", subjectId: "s", identityAccountId: "a", providerConnectionId: "p" };

describe("Security Journal v1 contract", () => {
  it("S1: Entra evidence is provider-attested only, never MFA or phishing-resistant, and carries no token material", () => {
    const e = entraSignInEvidence(identity, "VERIFIED", "ENTRA_OIDC_VERIFIED");
    expect(e).toMatchObject({ method: "FEDERATED_OIDC", source: "EXTERNAL_PROVIDER", assuranceLevel: "LOW",
      userVerification: "PROVIDER_ASSERTED", phishingResistant: false, hardwareBound: false, outcome: "VERIFIED" });
    expect(Object.keys(e).join()).not.toMatch(/token|claim|ip|userAgent|digest/i);
    expect(String(e.sourceRef)).toMatch(/^oidc-callback:[0-9a-f-]{36}$/);
    expect(entraSignInEvidence(identity, "VERIFIED", "X").id).not.toBe(e.id);
    expect(ASSURANCE_LABELS.PROVIDER_ATTESTED).toBe("Connexion attestée par Microsoft");
    // Pages and labels describing sign-ins never mention MFA. (The dashboard's separate
    // "MFA et accès conditionnel Entra" widget is explicitly "Pas encore disponible".)
    for (const source of ["app/dashboard/audit/page.tsx", "app/dashboard/settings/my-security.tsx"])
      expect(readFileSync(source, "utf8")).not.toMatch(/\bMFA\b|multifacteur/i);
    for (const label of [...Object.values(ASSURANCE_LABELS), ...Object.values(SIGN_IN_METHOD_LABELS)])
      expect(label).not.toMatch(/\bMFA\b|multifacteur/i);
    expect(ASSURANCE_LABELS.PROVIDER_ATTESTED).not.toMatch(/hameçonnage/);
  });

  it("journal cursor round-trips, rejects garbage, and the order is total (time desc, sign-in first, id desc)", () => {
    const entry = { occurredAt: "2026-10-10T12:00:00.000Z", kind: "SIGN_IN" as const, id: "0f0e-1" };
    expect(decodeCursor(encodeCursor(entry))).toEqual({ t: new Date(entry.occurredAt), kind: "SIGN_IN", id: "0f0e-1" });
    expect(() => decodeCursor(Buffer.from("x|ADMIN|1").toString("base64url"))).toThrow("INVALID_CURSOR");
    expect(() => decodeCursor(Buffer.from("2026-10-10T12:00:00Z|OTHER|1").toString("base64url"))).toThrow("INVALID_CURSOR");
    const rows = [
      { occurredAt: "2026-10-10T12:00:00.000Z", kind: "ADMIN" as const, id: "b" },
      { occurredAt: "2026-10-10T12:00:00.000Z", kind: "SIGN_IN" as const, id: "a" },
      { occurredAt: "2026-10-10T13:00:00.000Z", kind: "ADMIN" as const, id: "a" },
      { occurredAt: "2026-10-10T12:00:00.000Z", kind: "ADMIN" as const, id: "c" },
    ];
    expect([...rows].sort(compareEntries).map(r => `${r.kind}:${r.id}`)).toEqual(["ADMIN:a", "SIGN_IN:a", "ADMIN:c", "ADMIN:b"]);
  });

  it("writes are wired where sign-in, sign-out and enrolment happen", () => {
    const callback = readFileSync("app/auth/callback/route.ts", "utf8");
    expect(callback).toMatch(/createSession\([\s\S]*\{ evidence: entraSignInEvidence\(signInIdentity, "VERIFIED"/);
    expect(callback).toContain('recordRejectedSignIn(entraSignInEvidence(signInIdentity, "REJECTED", error.reason))');
    const local = readFileSync("app/api/auth/local/complete/route.ts", "utf8");
    expect(local).not.toContain("tx.authenticationEvidence.create");
    expect(local).toMatch(/\{ evidence: evidence\("VERIFIED"/);
    expect(local).toContain('recordRejectedSignIn(evidence("REJECTED", "SUBJECT_NOT_ACTIVE"))');
    expect(readFileSync("app/auth/logout/route.ts", "utf8")).toContain("revokeByToken(rawToken, { signOutAudit: true })");
    expect(readFileSync("app/api/auth/local/enrollment/complete/route.ts", "utf8")).toContain("enrolledBySubjectId: auth.subjectId");
    expect(OPERATION_LABELS["SESSION.SIGN_OUT"]).toBe("Déconnexion");
    expect(OPERATION_LABELS["LOCAL_AUTHENTICATOR.ENROLL"]).toBe("Clé d’accès ajoutée");
  });

  it("self-service endpoints are own-data only and the revoke endpoint requires a change id", () => {
    for (const route of ["app/api/me/sessions/route.ts", "app/api/me/authenticators/route.ts", "app/api/me/sessions/[ref]/revoke/route.ts"])
      expect(readFileSync(route, "utf8")).toContain("requireAuth()");
    expect(readFileSync("app/api/me/sessions/[ref]/revoke/route.ts", "utf8")).toContain("mutationChangeId(request)");
    const service = readFileSync("lib/auth/self-service.ts", "utf8");
    expect(service).toMatch(/subjectId: auth\.subjectId/);
    expect(service).not.toMatch(/ipHash|userAgentHash|credentialId|publicKey|signCount/);
    expect(service).not.toContain("revokeAuthenticator"); // passkey revocation is out of v1 (S2)
  });
});
