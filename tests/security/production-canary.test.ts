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
  function run(answers: { login: string; title: string; root: string; api: string; body: string }, env: Record<string, string> = {}) {
    return runWithOutput(answers, env).status;
  }
  function runWithOutput(answers: { login: string; title: string; root: string; api: string; body: string }, env: Record<string, string> = {}) {
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
      const result = spawnSync("bash", [join(dir, "step.sh")], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BASE: "https://example.test", DRILL_UNTIL: "", ...env } });
      return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const healthy = { login: "200", title: "<title>LUXIA Identity</title>", root: "307 https://example.test/login", api: "401", body: '{"error":"Unauthorized"}' };

  // CI runs on Linux; this stand-in relies on Linux PATH and file modes.
  it.skipIf(process.platform === "win32")("succeeds only when all three checks hold", () => {
    expect(run(healthy)).toBe(0);
    for (const broken of [{ login: "404" }, { title: "<title>Another site</title>" }, { root: "200 -" }, { api: "200" }, { body: "{}" }])
      expect(run({ ...healthy, ...broken }), JSON.stringify(broken)).toBe(1);
  });

  // G6 alert drill: a synthetic failure while Production is healthy, bounded in time, never masking a real one.
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  it("the drill reads a repository variable through env only, and no secret", () => {
    expect(workflow).toContain("DRILL_UNTIL: ${{ vars.CANARY_ALERT_DRILL_UNTIL }}");
    expect(workflow).not.toMatch(/secrets\./);
  });
  it.skipIf(process.platform === "win32")("drill: a healthy Production fails on purpose while the end time holds, with a message that says so", () => {
    const drilled = runWithOutput(healthy, { DRILL_UNTIL: at(60) });
    expect(drilled.status).toBe(1);
    expect(drilled.output).toContain("ALERT DRILL (synthetic, not an outage)");
    expect(drilled.output).not.toContain("Production does not serve LUXIA");
  });
  it.skipIf(process.platform === "win32")("drill: a real failure during a drill is reported as real, never as the drill", () => {
    const real = runWithOutput({ ...healthy, login: "404" }, { DRILL_UNTIL: at(60) });
    expect(real.status).toBe(1);
    expect(real.output).toContain("Production does not serve LUXIA");
    expect(real.output).not.toContain("ALERT DRILL");
  });
  it.skipIf(process.platform === "win32")("drill: past, too far ahead or invalid end times are ignored; no variable changes nothing", () => {
    // Relative expressions ("+1 hour", "next hour") would move the end time on every run (Antigravity, review of #185).
    for (const value of [at(-1), at(121), "tomorrow-ish", "2026-13-45T99:00:00Z", "+1 hour", "next hour", "1 hour", "now + 30 minutes"]) {
      const result = runWithOutput(healthy, { DRILL_UNTIL: value });
      expect(result.status, value).toBe(0);
      expect(result.output, value).toContain("CANARY_ALERT_DRILL_UNTIL ignored");
    }
    expect(runWithOutput(healthy, {}).status).toBe(0);
    expect(runWithOutput(healthy, {}).output).not.toContain("ignored");
  });
});
