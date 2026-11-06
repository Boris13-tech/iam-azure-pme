import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The access reviews link follows the page's own rule: read or read_all (an auditor holding only read_all sees it).
describe("dashboard navigation", () => {
  it("the access reviews item uses the review read rights, and items with several rights show on any one of them", () => {
    const layout = readFileSync("app/dashboard/layout.tsx", "utf8").replace(/\r\n/g, "\n");
    expect(layout).toMatch(/"\/dashboard\/governance\/access-reviews"[^\n]*entitlement: REVIEW_READ_RIGHTS/);
    expect(layout).toContain(".some(key => platform.entitlements.includes(key))");
  });
});
