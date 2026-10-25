import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Production canary (incident of 2026-10-24) reads public pages only: no secret, no token, no checkout.
const workflow = readFileSync(".github/workflows/production-canary.yml", "utf8").replace(/\r\n/g, "\n");

describe("Production canary", () => {
  it("runs on a schedule or by hand, with no token permission, no secret and no repository access", () => {
    expect(workflow).toMatch(/^on:\n  schedule:\n    - cron: '[^']+'\n  workflow_dispatch:\n\npermissions: \{\}\n/m);
    expect(workflow).not.toMatch(/pull_request|push:|secrets\.|github\.token|uses: |environment:/);
    const run = workflow.slice(workflow.indexOf("run: |"));
    expect(run).not.toContain("${{");
  });

  it("checks that the domain serves LUXIA: the login page, the redirect to it, and a refused API call", () => {
    expect(workflow).toContain("BASE: https://iam-azure-pme.vercel.app");
    expect(workflow).toContain(`grep -q '<title>LUXIA' login.html`); // "LUXIA" or "LUXIA Identity" (#134)
    expect(workflow).toContain(`[ "$root" = "307 $BASE/login" ]`);
    expect(workflow).toContain(`[ "$api" = "401" ] && grep -q '"error":"Unauthorized"' api.json`);
    expect(workflow).toMatch(/exit 1\n$/);
  });
});
