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
  MONITORING_TOKEN_HEADER, READINESS_CACHE_MS, READINESS_TIMEOUT_MS, databaseReady, monitoringTokenAccepted, resetReadinessCache,
} from "../../lib/monitoring/readiness";

const TOKEN = "t".repeat(48);
const saved = process.env.LUXIA_MONITORING_TOKEN;
const call = (headers: Record<string, string> = {}) => readiness(new Request("http://localhost:3000/api/internal/readiness", { headers }));
const withToken = () => call({ [MONITORING_TOKEN_HEADER]: TOKEN });
const unauthenticated = (path: string) => middleware(new NextRequest(`http://localhost:3000${path}`));

beforeEach(() => { query.mockReset(); query.mockResolvedValue([{ "?column?": 1 }]); resetReadinessCache(); process.env.LUXIA_MONITORING_TOKEN = TOKEN; });
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

  it("with the token: 200 ready when the database answers, 503 when it fails; the body is only {ready}", async () => {
    let response = await withToken();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    resetReadinessCache();
    query.mockRejectedValue(new Error("connection refused to db.internal:5432 as app_user"));
    response = await withToken();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ready: false });
    expect(text).not.toMatch(/refused|internal|5432|app_user/);
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
    answer([1]);
    await vi.advanceTimersByTimeAsync(0);
    query.mockResolvedValue([1]);
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
    query.mockReturnValue(new Promise((resolve) => { release = () => resolve([1]); }));
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
