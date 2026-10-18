import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Monitoring slice 2 (M-C, SLI-03): errors leave LUXIA only as events it builds itself, scrubbed, to a
// Sentry-protocol envelope endpoint, and only when a DSN is configured. The reporter never throws or hangs.
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "raw-session-token" }) })) }));
vi.mock("../../lib/auth/session-store", () => ({ SessionStore: { getSession: vi.fn() } }));

import { REPORT_TIMEOUT_MS, buildEvent, envelopeTarget, reportError } from "../../lib/monitoring/error-reporter";
import { SessionStore } from "../../lib/auth/session-store";
import { getAuthContext } from "../../lib/auth/auth-context";
import { onRequestError } from "../../instrumentation";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.de.example.invalid/4501234";
const saved = { ...process.env };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  process.env.LUXIA_ERROR_DSN = DSN;
  process.env.NEXT_RUNTIME = "nodejs";
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); process.env = { ...saved }; });

const sentBody = () => String(fetchMock.mock.calls[0][1].body);
const sentEvent = () => JSON.parse(sentBody().trim().split("\n")[2]);

describe("Monitoring slice 2: scrubbed error events, Sentry envelope protocol, no SDK", () => {
  it("parses only a well-formed https DSN with a public key and a numeric project", () => {
    expect(envelopeTarget(DSN)).toEqual({ url: "https://o1.ingest.de.example.invalid/api/4501234/envelope/?sentry_key=0123456789abcdef0123456789abcdef&sentry_version=7" });
    for (const bad of ["", "not a url", "http://0123456789abcdef0123456789abcdef@h/1", "https://h/1",
      "https://0123456789abcdef0123456789abcdef:secret@h/1", "https://0123456789abcdef0123456789abcdef@h/abc", "https://short@h/1"]) {
      expect(envelopeTarget(bad), String(bad)).toBeNull();
    }
  });

  it("without a DSN nothing is sent", async () => {
    delete process.env.LUXIA_ERROR_DSN;
    expect(await reportError(new Error("x"), "request")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one envelope with an allow-listed event: no request, user, headers, contexts, breadcrumbs or host", async () => {
    expect(await reportError(new Error("boom"), "request", "/api/canonical/subjects/[id]")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(envelopeTarget(DSN)!.url);
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/x-sentry-envelope" } });
    expect(sentBody().trim().split("\n")).toHaveLength(3);
    const event = sentEvent();
    expect(Object.keys(event).sort()).toEqual(["environment", "event_id", "exception", "level", "platform", "tags", "timestamp"]);
    expect(event.tags).toEqual({ component: "request", route: "/api/canonical/subjects/[id]" });
    for (const key of ["request", "user", "contexts", "breadcrumbs", "server_name", "extra"]) expect(event).not.toHaveProperty(key);
  });

  it("scrubs connection strings, e-mails, IP addresses and tokens from the message", async () => {
    const secrets = ["postgresql://app_user:s3cr3t@ep-x.eu-central-1.aws.neon.tech/neondb", "jane.doe@example.com", "203.0.113.42",
      "2001:db8::8a2e:370:7334", "luxia_session=9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928"];
    await reportError(new Error(`failed for ${secrets.join(" and ")}`), "session");
    const body = sentBody();
    for (const secret of ["s3cr3t", "app_user:", "jane.doe", "203.0.113.42", "8a2e:370", "9f8e7d6c5b4a39281706f5e4d3c2b1a0"]) expect(body).not.toContain(secret);
    expect(sentEvent().exception.values[0].value).toMatch(/<url>.*<email>.*<ip>.*<token>/);
  });

  it("drops a route value that is not a plain route pattern", () => {
    expect(buildEvent(new Error("x"), "request", "/api/x?token=abc").tags).toEqual({ component: "request" });
  });

  it("never throws when the backend fails, and never waits beyond the timeout", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await reportError(new Error("x"), "request")).toBe(false);
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = reportError(new Error("slow"), "request");
    await vi.advanceTimersByTimeAsync(REPORT_TIMEOUT_MS + 1);
    expect(await pending).toBe(false);
  });

  it("SLI-03: a session resolution failure is reported as component=session, then fails as before", async () => {
    const failure = new Error("connection terminated");
    vi.mocked(SessionStore.getSession).mockRejectedValueOnce(failure);
    await expect(getAuthContext()).rejects.toBe(failure);
    expect(sentEvent().tags).toEqual({ component: "session" });
    expect(sentBody()).not.toContain("raw-session-token");
  });

  it("an unresolved session is not an error: nothing is reported", async () => {
    vi.mocked(SessionStore.getSession).mockResolvedValueOnce(null);
    expect(await getAuthContext()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays buildable for the edge runtime: no Node-only import, and the reporter is loaded only on Node", () => {
    // instrumentation.ts is bundled for edge too; a "node:" import there failed the Next.js build (CI #371).
    const reporter = readFileSync("lib/monitoring/error-reporter.ts", "utf8");
    expect(reporter).not.toMatch(/from "node:|require\("node:/);
    const instrumentation = readFileSync("instrumentation.ts", "utf8").replace(/\r\n/g, "\n");
    expect(instrumentation).toMatch(/if \(process\.env\.NEXT_RUNTIME === "nodejs"\) \{\n\s+const \{ reportError \} = await import\("\.\/lib\/monitoring\/error-reporter"\);/);
  });

  it("instrumentation reports unhandled server errors with the route pattern only", async () => {
    await onRequestError(new Error("unhandled"), { path: "/api/me/sessions?x=1", headers: { cookie: "luxia_session=abc" } }, { routePath: "/api/me/sessions" });
    expect(sentEvent().tags).toEqual({ component: "request", route: "/api/me/sessions" });
    expect(sentBody()).not.toMatch(/luxia_session=abc|\?x=1/);
  });
});
