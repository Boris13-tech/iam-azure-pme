import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "../../lib/auth/auth-context";
import { SessionStore } from "../../lib/auth/session-store";
import { getRecoveryContext } from "../../lib/auth/recovery-session";
import { recoverySignIn } from "../../lib/auth/recovery";
import { resolveLoginOrganization } from "../../lib/auth/organization-login";
import { requireNative } from "../../lib/resources/service";
import { grantAdministrator } from "../../lib/onboarding/provisioning";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "token" }) }) }));
vi.mock("../../lib/auth/session-store", () => ({ SessionStore: { getSession: vi.fn(), getRecoverySession: vi.fn() } }));
vi.mock("../../lib/auth/organization-login", async (original) => ({ ...(await original<object>()), resolveLoginOrganization: vi.fn(async () => null) }));

// P5, every path: resources, SoD, access reviews, onboarding and the dashboard authorize from the session without
// going through the gateway. So with no valid mode in Production, no session is honoured at all.
const saved = { AUTHZ_MODE: process.env.AUTHZ_MODE, VERCEL_ENV: process.env.VERCEL_ENV, APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["AUTHZ_MODE", "VERCEL_ENV", "APP_ENV", "NODE_ENV"]) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
}
const session = { id: "s", organizationId: "o", tenantId: "t", subjectId: "u", identityAccountId: "a" };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(SessionStore.getSession).mockResolvedValue(session as never);
  vi.mocked(SessionStore.getRecoverySession).mockResolvedValue({ ...session, expiresAt: new Date(Date.now() + 60_000) } as never); });
// A database client that records any use: a refusal must come before the first query.
const untouched = () => { const used: string[] = []; return { used, tx: new Proxy({}, { get: (_t, model) => { used.push(String(model)); return new Proxy({}, { get: () => async () => null }); } }) as never }; };
const PRODUCTION_WITHOUT_MODE = [{ VERCEL_ENV: "production" }, { APP_ENV: "production", AUTHZ_MODE: "off" }, { NODE_ENV: "production", APP_ENV: "prod" }];
afterEach(() => { setEnv(saved); vi.restoreAllMocks(); });

describe("P5: no session is honoured in Production without a valid authorization mode", () => {
  it("a valid session is refused, and never even looked up, when the mode is missing or unknown in Production", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of [{ VERCEL_ENV: "production" }, { APP_ENV: "production", AUTHZ_MODE: "off" }, { NODE_ENV: "production", APP_ENV: "prod" }]) {
      setEnv(env);
      expect(await getAuthContext(), JSON.stringify(env)).toBeNull();
    }
    expect(SessionStore.getSession).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).not.toContain("off");
  });

  it("the same session is honoured with a valid mode, and outside Production", async () => {
    for (const env of [{ VERCEL_ENV: "production", AUTHZ_MODE: "native" }, { VERCEL_ENV: "preview" }, {}]) {
      setEnv(env);
      expect(await getAuthContext(), JSON.stringify(env)).toEqual({ sessionId: "s", organizationId: "o", tenantId: "t", subjectId: "u", identityAccountId: "a" });
    }
  });

  it("paths without a full session refuse too: requireNative decides nothing, before any query", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of PRODUCTION_WITHOUT_MODE) {
      setEnv(env);
      const { used, tx } = untouched();
      await expect(requireNative(tx, { organizationId: "o", tenantId: "t", subjectId: "u" }, "assignments.manage"), JSON.stringify(env))
        .rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
      expect(used, JSON.stringify(env)).toEqual([]);
    }
    setEnv({ VERCEL_ENV: "production", AUTHZ_MODE: "native" });
    const { used, tx } = untouched();
    await expect(requireNative(tx, { organizationId: "o", tenantId: "t", subjectId: "u" }, "assignments.manage")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(used).toContain("subject"); // with a valid mode it does look the subject up
  });

  it("no administrator is granted (signup, invitation acceptance, break-glass invitation), before any query", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of PRODUCTION_WITHOUT_MODE) {
      setEnv(env);
      const { used, tx } = untouched();
      await expect(grantAdministrator(tx, { organizationId: "o", tenantId: "t" }, { subjectId: "u", actorSubjectId: "u", changePrefix: "x", metadata: {} }), JSON.stringify(env))
        .rejects.toMatchObject({ code: "AUTHZ_MODE_INVALID" });
      expect(used, JSON.stringify(env)).toEqual([]);
    }
    // Both grant paths go through it, and invitation acceptance checks the inviter through requireNative.
    expect(readFileSync("lib/onboarding/signup.ts", "utf8")).toContain("await grantAdministrator(tx, context,");
    const invitations = readFileSync("lib/onboarding/invitations.ts", "utf8");
    expect(invitations).toContain("await grantAdministrator(tx, scope,");
    expect(invitations).toContain('await requireNative(tx, { ...scope, subjectId: row.invitedBySubjectId }, "assignments.manage")');
  });

  it("a recovery session is not honoured either, and never looked up; with a valid mode it is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const env of PRODUCTION_WITHOUT_MODE) {
      setEnv(env);
      expect(await getRecoveryContext(), JSON.stringify(env)).toBeNull();
    }
    expect(SessionStore.getRecoverySession).not.toHaveBeenCalled();
    setEnv({ VERCEL_ENV: "production", AUTHZ_MODE: "native" });
    expect(await getRecoveryContext()).toMatchObject({ recovery: { sessionId: "s", subjectId: "u" } });
  });

  it("recovery sign-in refuses before any lookup, so no single-use code is consumed; with a valid mode it proceeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const input = { organization: "acme", principalName: "admin", code: "ABCDE-FGHJK-MNPQR-STVWX" };
    for (const env of PRODUCTION_WITHOUT_MODE) {
      setEnv(env);
      expect(await recoverySignIn(input), JSON.stringify(env)).toBeNull();
    }
    expect(resolveLoginOrganization).not.toHaveBeenCalled();
    setEnv({ VERCEL_ENV: "production", AUTHZ_MODE: "native" });
    expect(await recoverySignIn(input)).toBeNull(); // unknown organization here (mocked), but it was looked up
    expect(resolveLoginOrganization).toHaveBeenCalled();
  });

  it("the session paths that skip the gateway start from getAuthContext", () => {
    expect(readFileSync("lib/admin/http.ts", "utf8")).toMatch(/requireAuth|getAuthContext/);
    expect(readFileSync("lib/auth/require-auth.ts", "utf8")).toContain("getAuthContext");
    expect(readFileSync("app/api/platform/context/route.ts", "utf8")).toContain("getAuthContext");
  });
});
