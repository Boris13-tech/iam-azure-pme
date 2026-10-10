import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENTITLEMENT_CATALOG_V1 } from "../../lib/auth/entitlements-catalog";
import { WIDGETS, WIDGET_IDS, attentionCount, breakdownTotal, isPermitted, type Widget, type WidgetId } from "../../lib/dashboard/posture-contract";
import { POSTURE_QUERIES } from "../../lib/dashboard/posture-queries";

describe("Identity Security Posture v1 contract", () => {
  it("uses only existing catalog entitlements (no catalog change in this slice)", () => {
    for (const id of WIDGET_IDS) for (const key of WIDGETS[id].permissions)
      expect(ENTITLEMENT_CATALOG_V1 as readonly string[]).toContain(key);
  });

  it("governance widgets require sod.read / access_reviews.read(.decide) and nothing else grants them", () => {
    for (const id of WIDGET_IDS.filter(id => WIDGETS[id].section === "governance")) {
      const perms = WIDGETS[id].permissions as readonly string[];
      expect(perms.some(p => p.startsWith("sod.") || p.startsWith("access_reviews."))).toBe(true);
      expect(isPermitted(id, new Set(ENTITLEMENT_CATALOG_V1.filter(k => !k.startsWith("sod.") && !k.startsWith("access_reviews."))))).toBe(false);
    }
  });

  it("requires ALL listed permissions; empty set restricts every widget", () => {
    expect(isPermitted("identity.activeSubjectsWithoutActiveAccount", new Set(["subjects.read"]))).toBe(false);
    expect(isPermitted("identity.activeSubjectsWithoutActiveAccount", new Set(["subjects.read", "identity_accounts.read"]))).toBe(true);
    expect(WIDGET_IDS.every(id => !isPermitted(id, new Set()))).toBe(true);
  });

  it("has exactly one query per query-kind widget and none for static widgets", () => {
    const queryIds = WIDGET_IDS.filter(id => WIDGETS[id].kind === "query").sort();
    expect(Object.keys(POSTURE_QUERIES).sort()).toEqual(queryIds);
    expect(WIDGETS["auth.entraSignInEvidence"].kind).toBe("query"); // real once recorded (Security Journal v1)
    expect(WIDGETS["governance.sodExistingViolations"].kind).toBe("not_implemented");
  });

  it("attention counts only ok numeric attention widgets — never unavailable, restricted or 0-coerced", () => {
    const id: WidgetId = "access.expiringWithin7d";
    expect(attentionCount({ id, state: "ok", value: 3 })).toBe(3);
    expect(attentionCount({ id, state: "ok", value: 0 })).toBe(0);
    for (const w of [{ id, state: "unavailable", reason: "QUERY_FAILED" }, { id, state: "restricted" }, { id, state: "not_implemented", reason: "X" }] as Widget[])
      expect(attentionCount(w)).toBeNull();
    expect(attentionCount({ id: "sessions.active", state: "ok", value: 5 })).toBeNull(); // not an attention rule
  });

  it("source never selects session hashes, credential material or external identifiers", () => {
    for (const file of ["lib/dashboard/posture-queries.ts", "lib/dashboard/posture.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/ipHash|userAgentHash|publicKey|credentialId|secretRef|externalObjectId|evidenceDigest/);
    }
  });

  it("endpoint reads no request input, is no-store, and the UI never coerces missing values to 0", () => {
    const route = readFileSync("app/api/canonical/posture/route.ts", "utf8");
    expect(route).toMatch(/export async function GET\(\)/);
    expect(route).toContain("no-store, private");
    expect(route).not.toMatch(/searchParams|request\.json|headers\(\)\.get/);
    const page = readFileSync("app/dashboard/page.tsx", "utf8");
    expect(page).not.toMatch(/\?\?\s*0|\|\|\s*0/);
    expect(page).toContain("Indisponible");
    expect(page).toContain("Pas encore disponible");
    // No computed score anywhere (wording such as "sans score" is allowed).
    for (const source of [page, readFileSync("lib/dashboard/posture.ts", "utf8"), readFileSync("lib/dashboard/posture-queries.ts", "utf8")])
      expect(source).not.toMatch(/\bscore\w*\s*[=:(]/i);
  });

  it("never sums overlapping breakdowns (Production finding 2026-10-10: 13 sign-ins shown as 26, 1 admin as 12)", () => {
    expect(breakdownTotal("auth.localSignInEvidence7d", { VERIFIED: 13, REJECTED: 0, VERIFIED_PHISHING_RESISTANT: 13 })).toBeNull();
    expect(breakdownTotal("access.administrativeEntitlementHolders", { "assignments.manage": 1, "sessions.revoke": 1 })).toBeNull();
    expect(breakdownTotal("sessions.activeByProvider", { MICROSOFT_ENTRA: 4, LUXIA_LOCAL: 1 })).toBe(5);
    expect(breakdownTotal("identity.subjectsByLifecycle", { ACTIVE: 0, SUSPENDED: 0 })).toBe(0);
    const page = readFileSync("app/dashboard/page.tsx", "utf8");
    expect(page).toContain("breakdownTotal(id, value)");
    expect(page).not.toMatch(/entries\.reduce/);
  });
});
