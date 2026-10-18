import { randomUUID } from "crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPermission, resolveAuthorizationMode } from "../../lib/auth/authorization-gateway";
import { authorize } from "../../lib/auth/authorization-engine";
import { hasLegacyPermission } from "../../lib/auth/legacy-auth-adapter";

vi.mock("../../lib/auth/legacy-auth-adapter");
vi.mock("../../lib/auth/authorization-engine");
vi.mock("../../lib/db/scoped-client", () => ({
  withTenantDb: vi.fn(async (_opts, cb) => cb({ authorizationShadowObservation: { create: vi.fn() } })),
}));

// P5 (standard I3, fail closed): in Production a missing or unknown AUTHZ_MODE must refuse every authorization,
// never fall back silently to legacy. Outside Production the legacy fallback is kept for development and CI.
const PRODUCTION_MARKS: Array<Record<string, string>> = [{ VERCEL_ENV: "production" }, { APP_ENV: "production" }];
const INVALID_MODES = [undefined, "", "Native", "NATIVE", " native", "native ", "legacy\n", "nativ", "native-shadow", "off"];
const VALID_MODES = ["legacy", "shadow", "native-shadow-legacy", "native"] as const;

const req = { action: "read", resource: "users" };
const auth = { organizationId: randomUUID(), tenantId: randomUUID(), subjectId: "sub-1", type: "HUMAN" } as any;
const saved = { AUTHZ_MODE: process.env.AUTHZ_MODE, VERCEL_ENV: process.env.VERCEL_ENV, APP_ENV: process.env.APP_ENV };

function setEnv(values: Record<string, string | undefined>) {
  for (const key of ["AUTHZ_MODE", "VERCEL_ENV", "APP_ENV"]) delete process.env[key];
  for (const [key, value] of Object.entries(values)) if (value !== undefined) process.env[key] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Both evaluators would allow: a refusal can only come from the mode check.
  vi.mocked(hasLegacyPermission).mockResolvedValue(true);
  vi.mocked(authorize).mockResolvedValue({
    allowed: true, reasonCode: "ALLOW_ACTIVE_ASSIGNMENT", matchedAssignmentIds: ["a"], matchedEntitlementIds: ["e"], evaluatedAt: new Date(),
  } as any);
});
afterEach(() => { setEnv(saved); vi.restoreAllMocks(); });

describe("P5: the authorization mode fails closed in Production", () => {
  it("resolves every valid mode as is, in Production and elsewhere", () => {
    for (const mark of [{}, ...PRODUCTION_MARKS]) {
      for (const mode of VALID_MODES) expect(resolveAuthorizationMode({ ...mark, AUTHZ_MODE: mode }), `${JSON.stringify(mark)} ${mode}`).toBe(mode);
    }
  });

  it("in Production, a missing or unknown mode resolves to null", () => {
    for (const mark of PRODUCTION_MARKS) {
      for (const mode of INVALID_MODES) {
        expect(resolveAuthorizationMode({ ...mark, AUTHZ_MODE: mode }), `${JSON.stringify(mark)} ${JSON.stringify(mode)}`).toBeNull();
      }
    }
  });

  it("in Production, a missing or unknown mode refuses, consults no evaluator, and never logs the value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const mark of PRODUCTION_MARKS) {
      for (const mode of INVALID_MODES) {
        setEnv({ ...mark, AUTHZ_MODE: mode });
        expect(await checkPermission(auth, req), `${JSON.stringify(mark)} ${JSON.stringify(mode)}`).toBe(false);
      }
    }
    expect(hasLegacyPermission).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("[AUTHZ] AUTHZ_MODE_INVALID: missing or unknown in Production, authorization refused");
    expect(warn).not.toHaveBeenCalled();
    const logged = [...error.mock.calls, ...warn.mock.calls].flat().join("\n");
    for (const mode of INVALID_MODES) if (mode && mode.trim()) expect(logged).not.toContain(mode.trim());
  });

  it("in Production, native still decides normally (no change for the configured value)", async () => {
    setEnv({ VERCEL_ENV: "production", AUTHZ_MODE: "native" });
    expect(await checkPermission(auth, req)).toBe(true);
    vi.mocked(authorize).mockResolvedValueOnce({ allowed: false, reasonCode: "DENY_NO_ASSIGNMENT", matchedAssignmentIds: [], matchedEntitlementIds: [], evaluatedAt: new Date() } as any);
    expect(await checkPermission(auth, req)).toBe(false);
  });

  it("outside Production, the legacy fallback is unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const mark of [{}, { VERCEL_ENV: "preview" }, { APP_ENV: "staging" }]) {
      expect(resolveAuthorizationMode({ ...mark })).toBe("legacy");
      expect(resolveAuthorizationMode({ ...mark, AUTHZ_MODE: "unknown" })).toBe("legacy");
    }
    setEnv({ AUTHZ_MODE: "unknown" });
    expect(await checkPermission(auth, req)).toBe(true);
    expect(hasLegacyPermission).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("the runtime-info route reports the mode the gateway applies, not a default", () => {
    const route = readFileSync("app/api/internal/runtime-info/route.ts", "utf8");
    expect(route).toContain(`authzMode: resolveAuthorizationMode() ?? "refused"`);
    expect(route).not.toMatch(/process\.env\.AUTHZ_MODE/);
  });

  it("CI runs the test jobs in native mode, as Production does", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
    for (const job of ["test-and-build", "backup-restore-roundtrip"]) {
      const start = ci.indexOf(`\n  ${job}:\n`);
      expect(start, job).toBeGreaterThan(0);
      const next = ci.slice(start + 1).search(/\n  [a-z][a-z0-9-]*:\n/);
      const body = next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
      expect(body, job).toMatch(/\n {6}AUTHZ_MODE: native\n/);
    }
  });
});
