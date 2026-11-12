import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R3: the daily retention job. The endpoint accepts only the platform cron secret; the middleware lets
// that exact path through; the database function has fixed predicates and bounded batches.
const queryRaw = vi.fn();
vi.mock("@/lib/db/raw-prisma", () => ({ rawPrisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

const { cronAuthorized, retentionEnforced, RETENTION_BATCH, RETENTION_MAX_ROUNDS, purgeExpiredTransactions, runRetention, R4_R6_ENFORCE_AVAILABLE } = await import("../../lib/retention/purge");

// The database functions of the daily run, told apart by their SQL text.
const R4_COUNTS = { invitations: 4, enforced: false };
const R6_COUNTS = { subjects: 1, displayNames: 1, principalNames: 1, enforced: false };
const STATUS = { R3: { eligible: 3, overdue: 0, oldestHours: 0 }, R4: { eligible: 4, overdue: 0, oldestHours: 0, held: 0 },
  R6: { eligible: 1, overdue: 0, oldestHours: 0, held: 0 }, holds: { active: 0, overdueReview: 0 } };
const fn = (args: unknown[]) => /luxia_retention_(\w+)\(/.exec((args[0] as string[]).join("?"))?.[1] ?? "?";
function stubDatabase(status = STATUS) {
  queryRaw.mockImplementation((...args: unknown[]) => {
    switch (fn(args)) {
      case "purge_transactions": return Promise.resolve([{ counts: { localAuthChallenges: 2, authTransactions: 1, retentionRuns: 0, enforced: args[2] } }]);
      case "purge_invitations": return Promise.resolve([{ counts: { ...R4_COUNTS, enforced: args[2] } }]);
      case "pseudonymize_retired": return Promise.resolve([{ counts: { ...R6_COUNTS, enforced: args[2] } }]);
      case "status": return Promise.resolve([{ status }]);
      default: return Promise.reject(new Error("unexpected query"));
    }
  });
}
const calls = () => queryRaw.mock.calls.map((args) => [fn(args), ...args.slice(1)]);
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

  it("with the secret, runs R3, R4, R6 and the status (dry runs by default) and returns counts and ages only", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    stubDatabase();
    const response = await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      r3: { localAuthChallenges: 2, authTransactions: 1, retentionRuns: 0, enforced: false, rounds: 1, backlog: false },
      r4: R4_COUNTS, r6: R6_COUNTS, status: STATUS, overdue: false, holdReviewOverdue: false });
    expect(calls()).toEqual([["purge_transactions", RETENTION_BATCH, false], ["purge_invitations", RETENTION_BATCH, false],
      ["pseudonymize_retired", RETENTION_BATCH, false], ["status"]]);
  });

  it("enforcement enabled: R3 enforces; R4 and R6 stay dry runs until a reviewed change lifts it (Beta scope 4.3)", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("LUXIA_RETENTION_ENFORCE", "true");
    expect(R4_R6_ENFORCE_AVAILABLE).toBe(false);
    stubDatabase();
    const response = await GET(new Request("https://example.test/api/internal/retention", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(response.status).toBe(200);
    const made = calls();
    expect(made[0]).toEqual(["purge_transactions", RETENTION_BATCH, true]);
    const r4r6 = made.filter(([name]) => name === "purge_invitations" || name === "pseudonymize_retired");
    expect(r4r6).toHaveLength(2);
    expect(r4r6.every((call) => call[2] === false)).toBe(true);
  });

  it("a record past its period plus 3 days is reported as the backlog alert, with counts and ages only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubDatabase({ ...STATUS, R4: { eligible: 3, overdue: 2, oldestHours: 900, held: 0 } });
    const report = await runRetention(false);
    expect(report.overdue).toBe(true);
    expect(error).toHaveBeenCalledWith("retention: records past their period plus 3 days",
      JSON.stringify({ R3: { overdue: 0, oldestHours: 0 }, R4: { overdue: 2, oldestHours: 900 }, R6: { overdue: 0, oldestHours: 0 } }));
    error.mockRestore();
  });

  it("a hold past its review date stays in effect and raises the overdue-review alert, counts only (D8.2)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubDatabase({ ...STATUS, R4: { ...STATUS.R4, held: 5 }, holds: { active: 2, overdueReview: 1 } });
    const report = await runRetention(false);
    expect(report.holdReviewOverdue).toBe(true);
    expect(report.overdue).toBe(false); // what a hold keeps is not a backlog
    expect(error).toHaveBeenCalledWith("retention: holds past their review date", JSON.stringify({ active: 2, overdueReview: 1 }));
    error.mockRestore();
  });

  it("a day with more than one batch is drained: calls repeat while full, counts add up, and a remainder is a backlog", async () => {
    const counts = (n: number, enforced = true) => [{ counts: { localAuthChallenges: n, authTransactions: Math.min(n, 5), retentionRuns: 0, enforced } }];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    queryRaw.mockResolvedValueOnce(counts(RETENTION_BATCH)).mockResolvedValueOnce(counts(RETENTION_BATCH)).mockResolvedValueOnce(counts(RETENTION_BATCH)).mockResolvedValueOnce(counts(7))
      .mockResolvedValueOnce(counts(0, false)); // the final dry check: nothing left
    expect(await purgeExpiredTransactions(true)).toEqual({ localAuthChallenges: 3 * RETENTION_BATCH + 7, authTransactions: 20, retentionRuns: 0, enforced: true, rounds: 4, backlog: false });
    expect(queryRaw).toHaveBeenCalledTimes(5);
    expect(queryRaw.mock.calls[4].slice(1)).toEqual([RETENTION_BATCH, false]);
    expect(error).not.toHaveBeenCalled();
    // A short count while eligible rows remain (rows locked by another transaction are skipped): the dry check sees them.
    queryRaw.mockReset(); queryRaw.mockResolvedValueOnce(counts(0)).mockResolvedValueOnce(counts(3, false));
    expect(await purgeExpiredTransactions(true)).toMatchObject({ rounds: 1, backlog: true });
    // Always full: it stops at the round limit and reports a backlog (counts only).
    queryRaw.mockReset(); queryRaw.mockResolvedValue(counts(RETENTION_BATCH));
    expect(await purgeExpiredTransactions(true)).toMatchObject({ rounds: RETENTION_MAX_ROUNDS, backlog: true });
    expect(queryRaw).toHaveBeenCalledTimes(RETENTION_MAX_ROUNDS);
    expect(error.mock.calls.flat().join(" ")).toContain("backlog");
    // The time budget stops it too.
    queryRaw.mockReset(); queryRaw.mockResolvedValue(counts(RETENTION_BATCH));
    expect(await purgeExpiredTransactions(true, undefined, { rounds: RETENTION_MAX_ROUNDS, budgetMs: 0 })).toMatchObject({ rounds: 1, backlog: true });
    // A dry run deletes nothing: one call, and a full count is a backlog.
    queryRaw.mockReset(); queryRaw.mockResolvedValue(counts(RETENTION_BATCH, false));
    expect(await purgeExpiredTransactions(false)).toMatchObject({ rounds: 1, backlog: true, enforced: false });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    error.mockRestore();
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
    // The gate's broad grant comes after the migrations: it must take these back too, like the CI bootstrap.
    const gate = readFileSync(".github/workflows/production-activation-gate.yml", "utf8"), bootstrap = readFileSync("scripts/ci/bootstrap-app-user.sql", "utf8");
    for (const line of ['REVOKE ALL ON "RetentionRun" FROM app_user;', 'REVOKE ALL ON SEQUENCE "RetentionRun_id_seq" FROM app_user;', 'REVOKE DELETE, TRUNCATE ON "AuthTransaction", "LocalAuthChallenge" FROM app_user;']) {
      expect(gate, line).toContain(line);
      expect(bootstrap, line).toContain(line);
      expect(gate.indexOf(line), line).toBeGreaterThan(gate.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;"));
    }
    expect(migration).toContain('REVOKE DELETE, TRUNCATE ON "AuthTransaction", "LocalAuthChallenge" FROM app_user;');
    expect(rollback).toContain('GRANT DELETE ON "AuthTransaction", "LocalAuthChallenge" TO app_user;');
    expect(migration).toContain('ALTER TABLE "RetentionRun" FORCE ROW LEVEL SECURITY;');
    expect(rollback).toContain("DROP FUNCTION luxia_retention_purge_transactions(integer, boolean);");
    expect(rollback).toContain('DROP TABLE "RetentionRun";');
    expect(rollback).toContain("'20261023130000_retention_purge_transactions'");
  });
});
