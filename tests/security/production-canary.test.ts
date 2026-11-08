import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  // The step's own script, against a stand-in for curl: an empty or early-exit script turns these red.
  const script = workflow.slice(workflow.indexOf("run: |\n") + "run: |\n".length).split("\n").map((line) => line.slice(10)).join("\n");
  const NL = String.fromCharCode(10);
  function run(answers: { login: string; title: string; root: string; api: string; body: string }) {
    const dir = mkdtempSync(join(tmpdir(), "canary-"));
    try {
      writeFileSync(join(dir, "sleep"), ["#!/bin/bash", "exit 0"].join(NL));
      writeFileSync(join(dir, "curl"), ["#!/bin/bash", 'for a in "$@"; do [[ "$a" == https://* ]] && url="$a"; done',
        'case "$url" in',
        `  */login) printf '%s' '${answers.title}' > login.html; printf '%s' '${answers.login}' ;;`,
        `  */api/*) printf '%s' '${answers.body}' > api.json; printf '%s' '${answers.api}' ;;`,
        `  *) printf '%s' '${answers.root}' ;;`, "esac"].join(NL));
      chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "sleep"), 0o755);
      writeFileSync(join(dir, "step.sh"), script);
      return spawnSync("bash", [join(dir, "step.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BASE: "https://example.test" } }).status;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const healthy = { login: "200", title: "<title>LUXIA Identity</title>", root: "307 https://example.test/login", api: "401", body: '{"error":"Unauthorized"}' };

  // CI runs on Linux; this stand-in relies on Linux PATH and file modes.
  it.skipIf(process.platform === "win32")("succeeds only when all three checks hold", () => {
    expect(run(healthy)).toBe(0);
    for (const broken of [{ login: "404" }, { title: "<title>Another site</title>" }, { root: "200 -" }, { api: "200" }, { body: "{}" }])
      expect(run({ ...healthy, ...broken }), JSON.stringify(broken)).toBe(1);
  });
});
