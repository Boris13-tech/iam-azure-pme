// Minimum application monitoring, slice 2 (MINIMUM-APPLICATION-MONITORING-DESIGN.md, M-C and SLI-03).
// A minimal client of the Sentry envelope protocol, without an SDK: LUXIA builds every event itself, so no
// request, user, header, cookie, query string or body can leave (I5, E15). Any Sentry-protocol backend works
// (Sentry, GlitchTip, Bugsink): the DSN is the only coupling. Without a DSN, nothing is sent.

export type ErrorComponent = "session" | "request";
export const REPORT_TIMEOUT_MS = 1_500;
const MAX_MESSAGE = 300;
const MAX_FRAMES = 20;

type Target = { url: string };

/** The envelope endpoint of a DSN `https://<key>@<host>/<project>`; null when missing or malformed. */
export function envelopeTarget(dsn = process.env.LUXIA_ERROR_DSN): Target | null {
  if (!dsn) return null;
  let parsed: URL;
  try { parsed = new URL(dsn); } catch { return null; }
  const project = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (parsed.protocol !== "https:" || !parsed.username || parsed.password || !/^\d{1,20}$/.test(project)) return null;
  const key = parsed.username;
  if (!/^[0-9a-f]{16,64}$/i.test(key)) return null;
  return { url: `https://${parsed.host}/api/${project}/envelope/?sentry_key=${key}&sentry_version=7` };
}

/** Removes anything that could identify a person or carry a secret from free text. */
export function scrub(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi, "<url>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, "<ip>")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "<token>")
    .slice(0, MAX_MESSAGE);
}

/** The project-relative part of a stack path; any other path says nothing about the machine or a person. */
function projectPath(raw: string) {
  const path = raw.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const relative = /(?:^|\/)((?:app|lib|node_modules|\.next)\/.+)$/.exec(path)?.[1];
  if (!relative) return "<external>";
  const parts = relative.split("/"), file = parts.pop()!;
  // Folders hold no dot except .next, and only a package scope may hold @: a name or an address fails here.
  const safe = parts.every((part) => /^(\.next|@?[\w()[\]-]+)$/.test(part)) && /^[\w()[\]-]+(\.[\w-]+)*$/.test(file);
  return safe ? scrub(relative) : "<external>";
}

/** Free text can hold anything, so only a plain error code leaves; the type and the stack frames locate the rest. */
const safeMessage = (message: string) => (/^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "<withheld>");

function frames(stack: string | undefined) {
  if (!stack) return [];
  return stack.split("\n").slice(1).map((line) => /at (?:(.+?) \()?(.+?):(\d+):\d+\)?$/.exec(line.trim())).filter(Boolean)
    .slice(0, MAX_FRAMES).reverse().map((m) => ({
      function: scrub(m![1] ?? "?").slice(0, 80),
      // Paths are reduced to the project-relative part; machine prefixes never leave.
      filename: projectPath(m![2]).slice(0, 160),
      lineno: Number(m![3]),
    }));
}

/** The event LUXIA sends: an allow-list of fields, nothing about the request or the person. */
export function buildEvent(error: unknown, component: ErrorComponent, routePath?: string) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error thrown");
  const release = process.env.VERCEL_GIT_COMMIT_SHA;
  const route = routePath && /^[\w/[\].-]{1,120}$/.test(routePath) ? routePath : undefined;
  return {
    event_id: Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: (process.env.APP_ENV || process.env.VERCEL_ENV || "unknown").replace(/[^\w-]/g, "").slice(0, 32),
    ...(release && /^[0-9a-f]{40}$/.test(release) ? { release } : {}),
    tags: { component, ...(route ? { route } : {}) },
    exception: { values: [{
      type: (err.name || "Error").replace(/[^\w]/g, "").slice(0, 60) || "Error",
      value: safeMessage(err.message || ""),
      stacktrace: { frames: frames(err.stack) },
    }] },
  };
}

/** Sends one error event. Never throws, never waits longer than the timeout, no-op without a DSN. */
export async function reportError(error: unknown, component: ErrorComponent, routePath?: string): Promise<boolean> {
  try {
    const target = envelopeTarget();
    if (!target) return false;
    const event = buildEvent(error, component, routePath);
    const body = `${JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REPORT_TIMEOUT_MS);
    try {
      const response = await fetch(target.url, { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body, signal: abort.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
