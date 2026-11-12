// scripts/ops/verify-no-other-operation.sh: a Production operation starts only when no other one is queued, waiting or in
// progress, so that no operation is ever left pending and silently replaced (Codex, review of #191). Run against a fake
// `gh` (no network): each case sets the runs GitHub would list per workflow and status.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "no-other-op-"));
const calls = join(dir, "calls.log");
// FAKE_RUNS lists "workflow status id name" lines; FAKE_FAIL=1 makes every call fail.
writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
echo "$2" >> "${calls.replace(/\\/g, "/")}"
[ "\${FAKE_FAIL:-}" = 1 ] && { echo "gh: HTTP 500" >&2; exit 1; }
wf="$(sed -E 's#.*/workflows/([^/]+)/runs.*#\\1#' <<< "$2")"; st="$(sed -E 's#.*status=([a-z_]+).*#\\1#' <<< "$2")"
printf '%b' "\${FAKE_RUNS:-}" | while read -r w s id name; do [ "$w" = "$wf" ] && [ "$s" = "$st" ] && echo "$id $name $s https://runs/$id"; done
exit 0
`);
chmodSync(join(dir, "gh"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(runs: string[], env: Record<string, string> = {}) {
  writeFileSync(calls, "");
  const result = spawnSync("bash", ["scripts/ops/verify-no-other-operation.sh"], { encoding: "utf8",
    env: { ...process.env, REPO: "owner/repo", RUN_ID: "100", FAKE_RUNS: runs.map((r) => `${r}\\n`).join(""), PATH: `${dir}${delimiter}${process.env.PATH}`, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, ""), calls: readFileSync(calls, "utf8") };
}

describe("verify-no-other-operation.sh: one Production operation at a time, never queued", () => {
  it("passes when this run is the only one, and asks about both workflows and every unfinished status", () => {
    const { code, out, calls: made } = check(["production-deploy.yml in_progress 100 Production deploy"]);
    expect(code).toBe(0);
    expect(out).toContain("No other Production operation");
    for (const wf of ["production-activation-gate.yml", "production-deploy.yml"])
      for (const status of ["queued", "waiting", "requested", "pending", "in_progress"])
        expect(made).toContain(`repos/owner/repo/actions/workflows/${wf}/runs?status=${status}&per_page=100`);
  });

  it("refuses while another deploy or activation is in progress, waiting for its approval, or queued", () => {
    for (const run of ["production-activation-gate.yml in_progress 7 Production Activation Gate", "production-deploy.yml waiting 8 Production deploy",
      "production-activation-gate.yml queued 9 Production Activation Gate", "production-deploy.yml pending 10 Production deploy"]) {
      const { code, out } = check([run]);
      expect(code, run).toBe(1);
      expect(out, run).toContain("REFUSED: another Production operation is queued, waiting or in progress");
      expect(out, run).toContain(`other Production operation: ${run.split(" ")[2]} `);
    }
  });

  it("fails closed: unreadable runs, or no run id", () => {
    expect(check([], { FAKE_FAIL: "1" }).out).toContain("REFUSED: the runs of production-activation-gate.yml cannot be read");
    expect(check([], { RUN_ID: "" }).out).toContain("REFUSED: RUN_ID is not set");
  });
});
