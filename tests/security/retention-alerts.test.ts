// D8.3 (Private Beta scope, section 4.1): the three alerts of the daily retention run, and the hold-review alert,
// through the error reporter. What leaves is checked byte for byte against closed lists: constants only.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/db/raw-prisma", () => ({ rawPrisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) } }));

const { CHECK_IN_MONITORS, KNOWN_ERROR_CODES, buildCheckIn, reportCheckIn } = await import("../../lib/monitoring/error-reporter");
const { RETENTION_ALERT_DRILLS, reportRetentionFailure, reportRetentionOutcome } = await import("../../lib/retention/alerts");
const { GET } = await import("../../app/api/internal/retention/route");

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.de.example.invalid/4501234";
const SECRET = "s".repeat(40);
const saved = { ...process.env };
const fetchMock = vi.fn();
const STATUS = { R3: { eligible: 0, overdue: 0, oldestHours: 0 }, R4: { eligible: 0, overdue: 0, oldestHours: 0, held: 0 },
  R6: { eligible: 0, overdue: 0, oldestHours: 0, held: 0 }, holds: { active: 0, overdueReview: 0 } };
const fn = (args: unknown[]) => /luxia_retention_(\w+)\(/.exec((args[0] as string[]).join("?"))?.[1] ?? "?";
function database(status: unknown = STATUS) {
  queryRaw.mockImplementation((...args: unknown[]) => {
    switch (fn(args)) {
      case "purge_transactions": return Promise.resolve([{ counts: { localAuthChallenges: 0, authTransactions: 0, retentionRuns: 0, enforced: args[2] } }]);
      case "purge_invitations": return Promise.resolve([{ counts: { invitations: 0, enforced: false } }]);
      case "pseudonymize_retired": return Promise.resolve([{ counts: { subjects: 0, displayNames: 0, principalNames: 0, enforced: false } }]);
      case "status": return Promise.resolve([{ status }]);
      default: return Promise.reject(new Error("unexpected query"));
    }
  });
}
/** Every envelope sent: its item type and its payload. */
const sent = () => fetchMock.mock.calls.map(([, init]) => {
  const [header, item, payload] = String((init as { body: string }).body).trim().split("\n").map((line) => JSON.parse(line));
  return { header, type: item.type as string, payload };
});
const call = (query = "") => GET(new Request(`https://example.test/api/internal/retention${query}`, { headers: { authorization: `Bearer ${SECRET}` } }));

beforeEach(() => {
  fetchMock.mockReset(); fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  queryRaw.mockReset();
  process.env.LUXIA_ERROR_DSN = DSN; process.env.CRON_SECRET = SECRET; process.env.APP_ENV = "production";
  delete process.env.LUXIA_RETENTION_ENFORCE;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); process.env = { ...saved }; });

describe("D8.3: retention alerts", () => {
  it("a run that finishes sends the daily check-in, and nothing else when nothing is late", async () => {
    database();
    expect((await call()).status).toBe(200);
    const envelopes = sent();
    expect(envelopes.map((e) => e.type)).toEqual(["check_in"]);
    expect(Object.keys(envelopes[0].header)).toEqual(["sent_at"]);
    const { check_in_id: id, ...rest } = envelopes[0].payload;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(rest).toEqual({ monitor_slug: "retention-daily", status: "ok", environment: "production",
      monitor_config: { schedule: { type: "crontab", value: "7 3 * * *" }, checkin_margin: 180, max_runtime: 5, timezone: "UTC", failure_issue_threshold: 3, recovery_threshold: 1 } });
  });

  it("silence alert: the watcher expects the schedule the platform cron really has, and alerts after 3 missed days", () => {
    const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> }).crons;
    expect(crons).toEqual([{ path: "/api/internal/retention", schedule: CHECK_IN_MONITORS["retention-daily"].schedule }]);
    expect(CHECK_IN_MONITORS["retention-daily"].missesBeforeAlert).toBe(3);
    expect(buildCheckIn("retention-daily", "ok").monitor_config.failure_issue_threshold).toBe(3);
  });

  it("backlog alert: a record past its period plus 3 days sends RETENTION_BACKLOG, counts never leave", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    database({ ...STATUS, R4: { eligible: 9, overdue: 4, oldestHours: 1234, held: 7 } });
    expect((await call()).status).toBe(200);
    const envelopes = sent();
    expect(envelopes.map((e) => e.type)).toEqual(["check_in", "event"]);
    const event = envelopes[1].payload;
    expect(event.exception).toEqual({ values: [{ type: "Error", value: "RETENTION_BACKLOG" }] });
    expect(event.tags).toEqual({ component: "retention", route: "/api/internal/retention" });
    expect(Object.keys(event).sort()).toEqual(["environment", "event_id", "exception", "level", "platform", "tags", "timestamp"]);
    expect(JSON.stringify(envelopes)).not.toMatch(/1234|"overdue"|"held"|"eligible"/);
  });

  it("a hold past its review date sends RETENTION_HOLD_REVIEW_OVERDUE; a backlog and an overdue hold send both", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    database({ ...STATUS, holds: { active: 2, overdueReview: 1 } });
    await call();
    expect(sent().filter((e) => e.type === "event").map((e) => e.payload.exception.values[0].value)).toEqual(["RETENTION_HOLD_REVIEW_OVERDUE"]);
    fetchMock.mockClear();
    database({ ...STATUS, R6: { eligible: 1, overdue: 1, oldestHours: 900, held: 0 }, holds: { active: 2, overdueReview: 1 } });
    await call();
    expect(sent().filter((e) => e.type === "event").map((e) => e.payload.exception.values[0].value)).toEqual(["RETENTION_BACKLOG", "RETENTION_HOLD_REVIEW_OVERDUE"]);
  });

  it("failed-run alert: the error leaves with its code when it is a listed one, RETENTION_FAILED otherwise, and a failed check-in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryRaw.mockRejectedValue(new Error('ERROR: RETENTION_ALREADY_RUNNING detail "secret-ish"'));
    expect((await call()).status).toBe(500);
    let envelopes = sent();
    expect(envelopes.map((e) => e.type)).toEqual(["event", "check_in"]);
    expect(envelopes[0].payload.exception.values).toEqual([{ type: "Error", value: "RETENTION_ALREADY_RUNNING" }]);
    expect(envelopes[1].payload).toMatchObject({ monitor_slug: "retention-daily", status: "error" });
    expect(JSON.stringify(envelopes)).not.toContain("secret-ish");
    fetchMock.mockClear();
    queryRaw.mockRejectedValue(new Error("connection refused to db.internal:5432 RETENTION_NOT_A_LISTED_CODE"));
    await call();
    envelopes = sent();
    expect(envelopes[0].payload.exception.values).toEqual([{ type: "Error", value: "RETENTION_FAILED" }]);
    expect(JSON.stringify(envelopes)).not.toMatch(/db\.internal|NOT_A_LISTED/);
  });

  it("the alerts never break the job: with the backend down or no DSN, the run still answers", async () => {
    database();
    fetchMock.mockRejectedValue(new Error("network down"));
    expect((await call()).status).toBe(200);
    expect(await reportRetentionOutcome({ overdue: true, holdReviewOverdue: true })).toEqual({ checkIn: false, backlog: false, holdReview: false });
    delete process.env.LUXIA_ERROR_DSN; fetchMock.mockReset();
    expect((await call()).status).toBe(200);
    expect(await reportRetentionFailure("RETENTION_FAILED")).toEqual({ error: false, checkIn: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Codex, review of #193: building a signal reads the clock and the random source. A failure there used to escape and
  // turn a finished run, whose data work was already committed, into a 500 - even with monitoring disabled.
  it("a signal that cannot even be built never fails the run, with or without a DSN", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { getRandomValues: () => { throw new Error("no entropy"); }, randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto), subtle: globalThis.crypto.subtle };
    vi.stubGlobal("crypto", broken);
    for (const dsn of [DSN, undefined]) {
      if (dsn) process.env.LUXIA_ERROR_DSN = dsn; else delete process.env.LUXIA_ERROR_DSN;
      database({ ...STATUS, R4: { eligible: 1, overdue: 1, oldestHours: 99, held: 0 }, holds: { active: 1, overdueReview: 1 } });
      const finished = await call();
      expect(finished.status, `finished, dsn=${!!dsn}`).toBe(200);
      expect((await finished.json()).overdue).toBe(true);
      expect(await reportRetentionOutcome({ overdue: true, holdReviewOverdue: true })).toEqual({ checkIn: false, backlog: false, holdReview: false });
      queryRaw.mockRejectedValue(new Error("RETENTION_ALREADY_RUNNING"));
      const failed = await call();
      expect(failed.status, `failed, dsn=${!!dsn}`).toBe(500);
      expect(await failed.json()).toEqual({ error: "RETENTION_FAILED" });
      expect(await reportRetentionFailure("RETENTION_ALREADY_RUNNING")).toEqual({ error: false, checkIn: false });
      database();
      for (const drill of RETENTION_ALERT_DRILLS) {
        const response = await call(`?drill=${drill}`);
        expect(response.status, `drill ${drill}, dsn=${!!dsn}`).toBe(200);
        expect(await response.json()).toEqual({ drill, sent: false });
      }
    }
    log.mockRestore();
  });

  it("drills (G7): each alert can be tested once without running a purge, only with the cron secret", async () => {
    database();
    expect(RETENTION_ALERT_DRILLS).toEqual(["failed-run", "backlog", "silence"]);
    for (const [drill, type, value] of [["failed-run", "event", "RETENTION_ALERT_DRILL_FAILED_RUN"], ["backlog", "event", "RETENTION_ALERT_DRILL_BACKLOG"], ["silence", "check_in", "retention-daily-drill"]] as const) {
      fetchMock.mockClear();
      const response = await call(`?drill=${drill}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ drill, sent: true });
      const [envelope, ...others] = sent();
      expect(others).toEqual([]);
      expect(envelope.type).toBe(type);
      expect(type === "event" ? envelope.payload.exception.values[0].value : envelope.payload.monitor_slug).toBe(value);
    }
    // The drill monitor expects a check-in every minute: one check-in, then nothing, raises the silence alert in minutes.
    expect(buildCheckIn("retention-daily-drill", "ok").monitor_config).toMatchObject({ schedule: { type: "crontab", value: "* * * * *" }, checkin_margin: 1, failure_issue_threshold: 3 });
    expect(queryRaw).not.toHaveBeenCalled(); // no purge, no status: a drill touches no data
    fetchMock.mockClear();
    expect((await call("?drill=everything")).status).toBe(400);
    const unauthenticated = await GET(new Request("https://example.test/api/internal/retention?drill=backlog"));
    expect(unauthenticated.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only listed monitors and statuses are sent, and every code the alerts use is on the reporter's list", async () => {
    expect(await reportCheckIn("anything" as never, "ok")).toBe(false);
    expect(await reportCheckIn("retention-daily", "in_progress" as never)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const source = readFileSync("lib/retention/alerts.ts", "utf8");
    const codes = [...source.matchAll(/new Error\("([A-Z0-9_]+)"\)/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual(["RETENTION_ALERT_DRILL_BACKLOG", "RETENTION_ALERT_DRILL_FAILED_RUN", "RETENTION_BACKLOG", "RETENTION_HOLD_REVIEW_OVERDUE"]);
    for (const code of [...codes, "RETENTION_FAILED"]) expect(KNOWN_ERROR_CODES.has(code), code).toBe(true);
    // Every refusal the retention migrations can raise is listed, so a failed run names it instead of the generic code.
    const migrations = ["20261023130000_retention_purge_transactions", "20261025120000_retention_invitations_pseudonymization", "20261112100000_retention_status", "20261112130000_retention_hold_register"]
      .map((dir) => readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8")).join("\n");
    const raised = [...new Set([...migrations.matchAll(/RAISE EXCEPTION '(RETENTION_[A-Z0-9_]+)'/g)].map((m) => m[1]))]
      .filter((code) => !code.startsWith("RETENTION_HOLD_") || code === "RETENTION_HOLD_REQUIRES_BYPASSRLS"); // operator-only hold functions are not the job's
    expect(raised.length).toBeGreaterThan(4);
    for (const code of raised) expect(KNOWN_ERROR_CODES.has(code), code).toBe(true);
  });
});
