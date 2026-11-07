import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { visibleNavigation } from "../../lib/navigation/dashboard";

// The access reviews link shows on the review service read gate: read or read_all (an auditor holding only read_all
// sees it). Hiding a link is not the access control; the service gate is.
// Review follow-up of #178: the navigation the server builds is checked on its output for each set of rights, so an
// ineffective filter cannot pass on its source text alone.
const shown = (entitlements: string[]) => {
  const items = visibleNavigation(entitlements);
  for (const item of items) expect(item).not.toHaveProperty("entitlement"); // rights never reach the client frame
  return items.map((item) => item.href);
};
const REVIEWS = "/dashboard/governance/access-reviews";

describe("dashboard navigation", () => {
  it("the access reviews item shows on read or read_all, and on nothing else", () => {
    expect(shown(["access_reviews.read"])).toContain(REVIEWS);
    expect(shown(["access_reviews.read_all"])).toContain(REVIEWS);
    expect(shown(["access_reviews.read", "access_reviews.read_all"])).toContain(REVIEWS);
    for (const rights of [[], ["access_reviews.manage"], ["access_reviews.decide"], ["access_reviews.manage", "access_reviews.decide"], ["audit.read"]])
      expect(shown(rights), rights.join(",") || "no rights").not.toContain(REVIEWS);
  });

  it("each item needs its own right; without any right only the overview shows", () => {
    expect(shown([])).toEqual(["/dashboard"]);
    expect(shown(["subjects.read"])).toEqual(["/dashboard", "/dashboard/users", "/dashboard/organization"]);
    expect(shown(["audit.read", "sod.read"])).toEqual(["/dashboard", "/dashboard/governance/sod", "/dashboard/audit"]);
    expect(shown(["providers.read", "resources.read"])).toEqual(["/dashboard", "/dashboard/settings", "/dashboard/resources"]);
  });

  it("the item uses the shared review read rights, and the layout shows only what the filter returns", () => {
    const source = readFileSync("lib/navigation/dashboard.ts", "utf8").replace(/\r\n/g, "\n");
    expect(source).toMatch(/"\/dashboard\/governance\/access-reviews"[^\n]*entitlement: REVIEW_READ_RIGHTS/);
    expect(readFileSync("app/dashboard/layout.tsx", "utf8")).toContain("<AppShell items={visibleNavigation(platform.entitlements)}");
  });
});
