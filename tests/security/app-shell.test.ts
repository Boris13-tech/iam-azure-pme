import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Design v2: the signed-in frame. Navigation stays filtered by entitlements on the server; the client frame only
// renders what it is given, marks the current page, and signs out with a POST.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const layout = read("app/dashboard/layout.tsx");
const shell = read("components/app-shell/app-shell.tsx");

describe("Signed-in frame (app shell)", () => {
  it("the server filters navigation by entitlements before the client frame sees it", () => {
    expect(layout).toContain("navigation.filter(item => !item.entitlement || platform.entitlements.includes(item.entitlement))");
    expect(layout).toContain("<AppShell items={allowedNavigation.map(");
    expect(layout).toContain('if (!auth) redirect("/login")');
    // The client frame adds no navigation entry of its own: its only link is the logo to the overview.
    expect([...shell.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/dashboard"]);
    expect(shell.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(/entitlements|fetch\(/);
  });

  it("marks the current page for assistive technologies and signs out with a POST", () => {
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(shell).toContain('<form method="POST" action="/auth/logout">');
    expect(shell).toMatch(/aria-controls="luxia-navigation"\s+aria-expanded=\{open\}/);
  });

  it("the Identities page never shows an empty organization while loading or after a failure", () => {
    const page = read("app/dashboard/users/page.tsx");
    expect(page).toContain('status === "ready" && subjects.length === 0');
    expect(page).toContain('status === "loading"');
  });
});
