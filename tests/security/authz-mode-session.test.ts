import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthContext } from "../../lib/auth/auth-context";
import { SessionStore } from "../../lib/auth/session-store";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "token" }) }) }));
vi.mock("../../lib/auth/session-store", () => ({ SessionStore: { getSession: vi.fn() } }));

// P5, every path: resources, SoD, access reviews, onboarding and the dashboard authorize from the session without
// going through the gateway. So with no valid mode in Production, no session is honoured at all.
const saved = { AUTHZ_MODE: process.env.AUTHZ_MODE, VERCEL_ENV: process.env.VERCEL_ENV, APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["AUTHZ_MODE", "VERCEL_ENV", "APP_ENV", "NODE_ENV"]) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
}
const session = { id: "s", organizationId: "o", tenantId: "t", subjectId: "u", identityAccountId: "a" };

beforeEach(() => { vi.clearAllMocks(); vi.mocked(SessionStore.getSession).mockResolvedValue(session as never); });
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

  it("the paths that skip the gateway all start from this session", () => {
    expect(readFileSync("lib/admin/http.ts", "utf8")).toMatch(/requireAuth|getAuthContext/);
    expect(readFileSync("lib/auth/require-auth.ts", "utf8")).toContain("getAuthContext");
    expect(readFileSync("app/api/platform/context/route.ts", "utf8")).toContain("getAuthContext");
  });
});
