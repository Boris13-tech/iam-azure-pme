import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R3: the daily retention job. The endpoint accepts only the platform cron secret; the middleware lets
// that exact path through; the database function has fixed predicates and bounded batches.
const queryRaw = vi.fn();
vi.mock("@/lib/db/raw-prisma", () => ({ rawPrisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

const { cronAuthorized, retentionEnforced, RETENTION_BATCH } = await import("../../lib/retention/purge");
const { GET } = await import("../../app/api/internal/retention/route");
const { middleware } = await import("../../middleware");

const SECRET = "s".repeat(40);
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const migration = read("prisma/migrations/20261023130000_retention_purge_transactions/migration.sql");
const rollback = read("docs/operations/RETENTION-PURGE-TRANSACTIONS-ROLLBACK.sql");

afterEach(() => { vi.unstubAllEnvs(); queryRaw.mockReset(); });

describe("R3 retention job: authorization", () => {
  it("accepts only the configured cron secret of at least 32 characters, as a Bearer value", () => {
    expect(cronAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(cronAuthorized(null, SECRET)).toBe(false);
    expect(cronAuthorized(SECRET, SECRET)).toBe(false);
    expect(cronAuthorized(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(cronAuthorized(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(cronAuthorized("Bearer short", "short")).toBe(false);
    expect(cronAuthorized("Bearer undefined", undefined)).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
  });

  it("enforces only when explicitly enabled; otherwise a dry run", () => {
    expect(retentionEnforced("true")).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes"]) expect(retentionEnforced(value)).toBe(false);
  });

  it("without the secret, answers like any unauthenticated /api path and touches nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: SECRET }] as Array<Record<string, string>>) {
      const response = await GET(new Request("https://example.test/api/internal/retention", { headers }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: "Bearer " } }))).status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("with the secret, runs one bounded call (dry run by default) and returns counts only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    queryRaw.mockResolvedValue([{ counts: { localAuthChallenges: 2, authTransactions: 1, retentionRuns: 0, enforced: false } }]);
    const response = await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ localAuthChallenges: 2, authTransactions: 1, retentionRuns: 0, enforced: false });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0].slice(1)).toEqual([RETENTION_BATCH, false]);
    vi.stubEnv("LUXIA_RETENTION_ENFORCE", "true");
    await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(queryRaw.mock.calls[1].slice(1)).toEqual([RETENTION_BATCH, true]);
  });

  it("a database failure gives a generic error, never its message", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    queryRaw.mockRejectedValue(new Error('ERROR: RETENTION_ALREADY_RUNNING detail "secret-ish"'));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "RETENTION_FAILED" });
    expect(log).toHaveBeenCalledWith("retention: purge failed", "RETENTION_ALREADY_RUNNING");
    log.mockRestore();
  });
});

describe("R3 retention job: platform wiring", () => {
  it("the middleware lets exactly the job path through without a session; neighbours stay protected", () => {
    const pass = middleware(new NextRequest("https://example.test/api/internal/retention"));
    expect(pass.headers.get("x-middleware-next")).toBe("1");
    for (const path of ["/api/internal/retention/x", "/api/internal/retentionx", "/api/internal/other"])
      expect(middleware(new NextRequest(`https://example.test${path}`)).status, path).toBe(401);
  });

  it("one daily cron calls the job", () => {
    const config = JSON.parse(read("vercel.json"));
    expect(config.crons).toEqual([{ path: "/api/internal/retention", schedule: "7 3 * * *" }]);
    expect(config.git).toEqual({ deploymentEnabled: { main: false } });
  });
});

describe("R3 retention job: migration architecture", () => {
  it("fixed predicates and period, bounded batch, one run at a time, counts only", () => {
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("p_batch > 5000");
    expect(migration).toContain("pg_try_advisory_xact_lock");
    expect(migration).toContain("RETENTION_OWNER_REQUIRES_BYPASSRLS");
    expect(migration.match(/DELETE FROM "(\w+)"/g)).toEqual(['DELETE FROM "LocalAuthChallenge"', 'DELETE FROM "AuthTransaction"', 'DELETE FROM "RetentionRun"']);
    expect(migration).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS \$\$/);
    expect(migration).not.toMatch(/EXECUTE format|EXECUTE '|\|\| *p_/);
  });

  it("the runtime gets EXECUTE only; the run records stay owner-only; the rollback removes both", () => {
    // The activation gate recreates the runtime role's grants after the migrations: it must include this one.
    expect(readFileSync(".github/workflows/production-activation-gate.yml", "utf8")).toContain("GRANT EXECUTE ON FUNCTION public.luxia_retention_purge_transactions(INTEGER,BOOLEAN) TO app_user;");
    expect(migration.match(/GRANT [^;]+;/g)).toEqual(["GRANT EXECUTE ON FUNCTION luxia_retention_purge_transactions(integer, boolean) TO app_user;"]);
    expect(migration).toContain('REVOKE ALL ON "RetentionRun" FROM app_user;');
    expect(migration).toContain('ALTER TABLE "RetentionRun" FORCE ROW LEVEL SECURITY;');
    expect(rollback).toContain("DROP FUNCTION luxia_retention_purge_transactions(integer, boolean);");
    expect(rollback).toContain('DROP TABLE "RetentionRun";');
    expect(rollback).toContain("'20261023130000_retention_purge_transactions'");
  });
});
