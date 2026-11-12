import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Minimum application monitoring, slice 1 (MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-A and M-B).
// The database client is mocked: liveness must never reach it, readiness reaches it at most once per period.
const query = vi.fn();
vi.mock("../../lib/db/raw-prisma", () => ({ rawPrisma: { $queryRaw: (...args: unknown[]) => query(...args) } }));

import { GET as health } from "../../app/api/health/route";
import { GET as readiness, dynamic as readinessDynamic } from "../../app/api/internal/readiness/route";
import { dynamic as healthDynamic } from "../../app/api/health/route";
import { middleware } from "../../middleware";
import {
  MONITORING_TOKEN_HEADER, READINESS_CACHE_MS, READINESS_TIMEOUT_MS, authorizationReady, databaseReady, monitoringTokenAccepted,
  readiness as readinessOf, resetReadinessCache, sessionReady,
} from "../../lib/monitoring/readiness";

// The resolver's SQL goes through the same mocked client: tell the two queries apart by their text.
const isSessionQuery = (args: unknown[]) => Array.isArray(args[0]) && (args[0] as string[]).join("?").includes("luxia_session_resolve");
const ALL_TRUE = { authorization: true, database: true, session: true };
// The database check's answer for the restricted runtime role (not superuser, no BYPASSRLS, owns no table).
const RESTRICTED = [{ restricted: true }];

const TOKEN = "t".repeat(48);
const saved = process.env.LUXIA_MONITORING_TOKEN;
const call = (headers: Record<string, string> = {}) => readiness(new Request("http://localhost:3000/api/internal/readiness", { headers }));
const withToken = () => call({ [MONITORING_TOKEN_HEADER]: TOKEN });
const unauthenticated = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

beforeEach(() => { query.mockReset(); query.mockImplementation((...args: unknown[]) => Promise.resolve(isSessionQuery(args) ? [] : RESTRICTED)); resetReadinessCache(); process.env.LUXIA_MONITORING_TOKEN = TOKEN; });
afterEach(() => { vi.useRealTimers(); if (saved === undefined) delete process.env.LUXIA_MONITORING_TOKEN; else process.env.LUXIA_MONITORING_TOKEN = saved; });

describe("Monitoring slice 1: public liveness, protected readiness", () => {
  it("liveness answers a constant, uncached body and never touches the database", async () => {
    query.mockRejectedValue(new Error("database down"));
    const response = health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(query).not.toHaveBeenCalled();
    expect(healthDynamic).toBe("force-dynamic");
    expect(readinessDynamic).toBe("force-dynamic");
  });

  it("readiness without the right token answers exactly like any unauthenticated /api path, and checks nothing", async () => {
    const reference = await unauthenticated("/api/some-unknown-path");
    const expected = { status: reference.status, body: await reference.json() };
    expect(expected).toEqual({ status: 401, body: { error: "Unauthorized" } });
    const attempts: Array<Record<string, string>> = [{}, { [MONITORING_TOKEN_HEADER]: "" }, { [MONITORING_TOKEN_HEADER]: "wrong" }, { [MONITORING_TOKEN_HEADER]: TOKEN + "x" },
      { [MONITORING_TOKEN_HEADER]: TOKEN.toUpperCase() }, { authorization: `Bearer ${TOKEN}` }];
    for (const headers of attempts) {
      const response = await call(headers);
      expect({ status: response.status, body: await response.json() }, JSON.stringify(Object.keys(headers))).toEqual(expected);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("a missing or short configured token refuses every caller (fail closed)", async () => {
    delete process.env.LUXIA_MONITORING_TOKEN;
    expect(monitoringTokenAccepted(TOKEN)).toBe(false);
    expect((await withToken()).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(monitoringTokenAccepted("", "")).toBe(false);
    expect(monitoringTokenAccepted("short", "short")).toBe(false);
    expect(monitoringTokenAccepted("x".repeat(31), "x".repeat(31))).toBe(false);
    expect(monitoringTokenAccepted(TOKEN, TOKEN)).toBe(true);
  });

  it("with the token: 200 ready when all three checks hold, 503 when the database fails; the body is only booleans", async () => {
    let response = await withToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true, checks: ALL_TRUE });
    expect(response.headers.get("cache-control")).toBe("no-store");
    resetReadinessCache();
    query.mockImplementation((...args: unknown[]) => isSessionQuery(args) ? Promise.resolve([]) : Promise.reject(new Error("connection refused to db.internal:5432 as app_user")));
    response = await withToken();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ready: false, checks: { ...ALL_TRUE, database: false } });
    expect(text).not.toMatch(/refused|internal|5432|app_user/);
  });

  it("database reached through a role that is not the restricted runtime role (owner, superuser, BYPASSRLS): not ready", async () => {
    // The real query was run on PostgreSQL 17: app_user → true; the superuser owner → false; a non-superuser owner of one
    // table → false (Codex, review of #189). Here: what the check does with each answer.
    for (const rows of [[{ restricted: false }], [], [{ restricted: null }], [{ restricted: true }, { restricted: true }], [{}], "x"]) {
      resetReadinessCache();
      query.mockImplementation((...args: unknown[]) => Promise.resolve(isSessionQuery(args) ? [] : rows));
      const response = await withToken();
      expect(response.status, JSON.stringify(rows)).toBe(503);
      expect(await response.json(), JSON.stringify(rows)).toEqual({ ready: false, checks: { ...ALL_TRUE, database: false } });
    }
    const sql = (query.mock.calls.find((args) => !isSessionQuery(args))![0] as string[]).join("?");
    expect(sql).toMatch(/NOT r\.rolsuper AND NOT r\.rolbypassrls\s+AND NOT EXISTS/);
    // No relation and no schema owned outside the system schemas, in any schema, not only the current one (Antigravity).
    expect(sql).toMatch(/WHERE c\.relowner = r\.oid AND n\.nspname NOT IN \('pg_catalog', 'information_schema'\) AND left\(n\.nspname, 3\) <> 'pg_'\)/);
    expect(sql).toMatch(/WHERE n\.nspowner = r\.oid AND n\.nspname NOT IN \('pg_catalog', 'information_schema'\) AND left\(n\.nspname, 3\) <> 'pg_'\)/);
    expect(sql).not.toContain("current_schema()");
    expect(sql).toMatch(/WHERE r\.rolname = current_user/);
  });

  it("database unavailable everywhere (both queries fail): 503, and neither the database nor the session check passes", async () => {
    query.mockRejectedValue(new Error("ECONNREFUSED"));
    const response = await withToken();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ready: false, checks: { authorization: true, database: false, session: false } });
  });

  it("a database that does not answer in time counts as not ready", async () => {
    vi.useFakeTimers();
    query.mockReturnValue(new Promise(() => {}));
    const pending = databaseReady();
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 1);
    expect(await pending).toBe(false);
  });

  it("a stalled database holds one query: after the timeout and the cache, no second one starts until it settles", async () => {
    vi.useFakeTimers();
    let answer!: (value: unknown) => void;
    query.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const start = 1_000_000;
    const pending = databaseReady(undefined, start);
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 1);
    expect(await pending).toBe(false);
    expect(await databaseReady(undefined, start + READINESS_CACHE_MS)).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    answer(RESTRICTED);
    await vi.advanceTimersByTimeAsync(0);
    query.mockResolvedValue(RESTRICTED);
    expect(await databaseReady(undefined, start + READINESS_CACHE_MS)).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("a check that throws at once does not count as an unanswered query", async () => {
    const start = 1_000_000;
    expect(await databaseReady(() => { throw new Error("no connection"); }, start)).toBe(false);
    expect(await databaseReady(async () => [1], start + READINESS_CACHE_MS)).toBe(true);
  });

  it("the database sees one check per period, whatever the call rate (single flight, then cache)", async () => {
    let release!: () => void;
    query.mockReturnValue(new Promise((resolve) => { release = () => resolve(RESTRICTED); }));
    const start = 1_000_000;
    const burst = Array.from({ length: 25 }, () => databaseReady(undefined, start));
    release();
    expect(await Promise.all(burst)).toEqual(Array(25).fill(true));
    expect(query).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 25; i++) await databaseReady(undefined, start + READINESS_CACHE_MS - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await databaseReady(undefined, start + READINESS_CACHE_MS);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("the middleware lets exactly the two monitoring paths through without a session; others stay protected", async () => {
    for (const path of ["/api/health", "/api/internal/readiness"]) {
      expect((await unauthenticated(path)).headers.get("x-middleware-next"), path).toBe("1");
    }
    for (const path of ["/api/health/x", "/api/healthz", "/api/internal/readiness/x", "/api/internal/other", "/api/canonical/subjects"]) {
      expect((await unauthenticated(path)).status, path).toBe(401);
    }
  });
});

// Codex F2, consolidated review of the Release Candidate: readiness covers what a signed-in user needs.
describe("Readiness for the Production deploy: authorization configuration, database, session path", () => {
  it("authorization: in Production only native is ready; a missing, unknown or non-native mode is not", () => {
    for (const marker of [{ VERCEL_ENV: "production" }, { APP_ENV: "production" }]) {
      expect(authorizationReady({ ...marker, AUTHZ_MODE: "native" }), JSON.stringify(marker)).toBe(true);
      for (const mode of [undefined, "", "Native", "native ", "legacy", "shadow", "native-shadow-legacy", "anything"]) {
        expect(authorizationReady({ ...marker, AUTHZ_MODE: mode }), `${JSON.stringify(marker)} ${mode}`).toBe(false);
      }
    }
    // An unmarked production process counts as Production, with the same definition as the mode (isProductionProcess):
    // missing and every non-native mode are refused there too (Codex, review of #189).
    expect(authorizationReady({ NODE_ENV: "production" })).toBe(false);
    expect(authorizationReady({ NODE_ENV: "production", AUTHZ_MODE: "native" })).toBe(true);
    for (const mode of ["legacy", "shadow", "native-shadow-legacy"]) {
      expect(authorizationReady({ NODE_ENV: "production", AUTHZ_MODE: mode }), mode).toBe(false);
      expect(authorizationReady({ NODE_ENV: "production", VERCEL_ENV: "", APP_ENV: "", AUTHZ_MODE: mode }), mode).toBe(false);
    }
    expect(authorizationReady({ NODE_ENV: "production", VERCEL_ENV: "preview", AUTHZ_MODE: "legacy" })).toBe(true);
    // Outside Production any resolved mode is ready (development, CI, previews keep the legacy fallback).
    expect(authorizationReady({ VERCEL_ENV: "preview", AUTHZ_MODE: "legacy" })).toBe(true);
    expect(authorizationReady({ NODE_ENV: "test" })).toBe(true);
  });

  it("authorization misconfigured: not ready even when the database and the session path are fine", async () => {
    const report = await readinessOf({ VERCEL_ENV: "production", AUTHZ_MODE: "legacy" });
    expect(report).toEqual({ ready: false, checks: { authorization: false, database: true, session: true } });
    resetReadinessCache();
    expect(await readinessOf({ VERCEL_ENV: "production", AUTHZ_MODE: "native" })).toEqual({ ready: true, checks: ALL_TRUE });
  });

  it("the session check goes through the real resolver, with a fresh random token each time, and needs no session back", async () => {
    const hashes: unknown[] = [];
    query.mockImplementation((...args: unknown[]) => { if (isSessionQuery(args)) hashes.push(args[1]); return Promise.resolve(isSessionQuery(args) ? [] : RESTRICTED); });
    expect(await sessionReady(undefined, 1_000_000)).toBe(true);
    expect(await sessionReady(undefined, 1_000_000 + READINESS_CACHE_MS)).toBe(true);
    expect(hashes).toHaveLength(2);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("session path failing: a resolver that errors is not ready, and the whole answer is 503", async () => {
    query.mockImplementation((...args: unknown[]) => isSessionQuery(args)
      ? Promise.reject(new Error('function luxia_session_resolve(text) does not exist')) : Promise.resolve(RESTRICTED));
    const response = await withToken();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ready: false, checks: { ...ALL_TRUE, session: false } });
    expect(text).not.toMatch(/luxia_session_resolve|does not exist/);
  });

  it("session path failing: a resolver that returns a live session for a random token is not ready", async () => {
    const live = { id: "s", organizationId: "o", tenantId: "t", subjectId: "u", identityAccountId: "a", scope: "FULL", revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000), lastSeenAt: new Date() };
    query.mockImplementation((...args: unknown[]) => Promise.resolve(isSessionQuery(args) ? [live] : RESTRICTED));
    expect(await sessionReady(undefined, 1_000_000)).toBe(false);
  });

  it("session path that does not answer in time is not ready (timeout)", async () => {
    vi.useFakeTimers();
    query.mockImplementation((...args: unknown[]) => isSessionQuery(args) ? new Promise(() => {}) : Promise.resolve(RESTRICTED));
    const pending = readinessOf({ NODE_ENV: "test" }, 1_000_000);
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ready: false, checks: { ...ALL_TRUE, session: false } });
  });

  it("token absent or invalid: 401 like any unauthenticated path, and no check runs", async () => {
    for (const headers of [{}, { [MONITORING_TOKEN_HEADER]: "x".repeat(48) }] as Array<Record<string, string>>) {
      const response = await call(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    }
    delete process.env.LUXIA_MONITORING_TOKEN;
    expect((await withToken()).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
});
