import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every API route that records a change answers 400 X_LUXIA_CHANGE_ID_REQUIRED without the x-luxia-change-id header
// (lib/admin/http.ts mutationChangeId). A page that forgets it shows a generic refusal and the action never happens:
// that is how suspending an identity from /dashboard/users failed in Production (Test 6, 2026-11-21).

const routeNeedsHeader = (file: string) => readFileSync(file, "utf8").includes("mutationChangeId(");

function files(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, keep) : keep(path) ? [path] : [];
  });
}

// "/api/canonical/subjects/${subject.id}" -> app/api/canonical/subjects/[id]/route.ts, whatever the dynamic segment's name.
function routeFor(url: string): string | null {
  const parts = url.replace(/^\/api\//, "").split("?")[0].split("/").filter(Boolean);
  let dir = join("app", "api");
  for (const part of parts) {
    const dynamic = part.includes("${");
    const next = readdirSync(dir).find((entry) => dynamic ? /^\[[^.\]]+\]$/.test(entry) : entry === part);
    if (!next) return null;
    dir = join(dir, next);
  }
  const route = join(dir, "route.ts");
  try { statSync(route); return route; } catch { return null; }
}

// The fetch call's own options object, from its "{" to the matching "}": a fixed window would read into the next
// statement (a plain GET followed by a POST elsewhere was flagged, depending on line endings).
function optionsObject(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

const pages = files("app", (path) => path.endsWith(".tsx") && !path.split(/[\\/]/).includes("api"));

describe("UI mutations send the change header the API requires", () => {
  it("every POST/PATCH/PUT/DELETE fetch from a page to a change-recording route carries x-luxia-change-id", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const page of pages) {
      const source = readFileSync(page, "utf8");
      for (const match of source.matchAll(/fetch\(\s*([`"])(\/api\/[^`"]+)\1\s*,\s*\{/g)) {
        const options = optionsObject(source, match.index! + match[0].length - 1);
        if (!/method:\s*"(POST|PATCH|PUT|DELETE)"/.test(options)) continue;
        const route = routeFor(match[2]);
        if (!route || !routeNeedsHeader(route)) continue;
        checked++;
        if (!/["']?x-luxia-change-id["']?\s*:/i.test(options)) missing.push(`${page} -> ${match[2]}`);
      }
    }
    expect(missing).toEqual([]);
    // The users page alone has two such calls: the scan must see them, or it proves nothing.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it("the identities page sends the header on creation and on every status change", () => {
    const page = readFileSync("app/dashboard/users/page.tsx", "utf8");
    expect(page.match(/"x-luxia-change-id": `users-ui:subject-(create|lifecycle):\$\{crypto\.randomUUID\(\)\}`/g)).toHaveLength(2);
    expect(page).not.toContain("Idempotency-Key");
  });
});
