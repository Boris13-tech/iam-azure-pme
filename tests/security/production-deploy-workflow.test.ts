import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// GOV-001: the only path to change Production code waits for the operator's approval in the GitHub environment
// Production, deploys the exact commit, checks from outside, rolls back on failure, and records the change.
const workflow = readFileSync(".github/workflows/production-deploy.yml", "utf8").replace(/\r\n/g, "\n");
const deployJob = workflow.slice(workflow.indexOf("\n  deploy:\n"));
const verifyJob = workflow.slice(workflow.indexOf("\n  verify:\n"), workflow.indexOf("\n  deploy:\n"));

describe("Production deploy workflow (GOV-001)", () => {
  it("starts only by hand, with the exact commit and a reason", () => {
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:\n    inputs:\n      sha:\n/m);
    expect(workflow).not.toMatch(/\n  (push|pull_request|schedule|workflow_run|pull_request_target):/);
    expect(workflow).toMatch(/reason:\n        description: [^\n]+\n        required: true/);
    expect(workflow).toMatch(/^permissions:\n  contents: read\n/m);
  });

  it("verifies the commit is a full SHA on main with a green CI run, before any approval is asked", () => {
    expect(verifyJob).not.toMatch(/environment:|secrets\./);
    expect(verifyJob).toContain('[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(verifyJob).toContain('compare/$SHA...main');
    expect(verifyJob).toContain("actions/workflows/ci.yml/runs?head_sha=$SHA&status=success");
  });

  it("deploys only after the operator's approval in the protected environment, with the token kept there", () => {
    expect(deployJob).toMatch(/^\n  deploy:\n    needs: verify\n/);
    expect(deployJob).toMatch(/\n    environment: Production\n/);
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])).toEqual(["VERCEL_DEPLOY_TOKEN"]);
    expect(deployJob).toContain('gitSource: {type: "github", repoId: $repo, ref: "main", sha: $sha}');
    expect(deployJob).toContain('[[ "$current" == "$id" ]]');
  });

  it("checks Production from outside, promotes the previous deployment back on failure, and records the approval", () => {
    expect(deployJob).toContain(`grep -q '<title>LUXIA' login.html`);
    expect(deployJob).toContain("if: (failure() || cancelled()) && steps.deploy.outputs.previous != ''");
    expect(deployJob).toContain("/promote/$PREVIOUS");
    expect(deployJob).toContain("actions/runs/$RUN_ID/approvals");
    expect(deployJob).toContain("GITHUB_STEP_SUMMARY");
  });

  it("a deployment not ready in time is cancelled before the run fails", () => {
    const deploy = deployJob.slice(deployJob.indexOf("id: deploy"), deployJob.indexOf("id: checks"));
    expect(deploy.indexOf('/deployments/$id/cancel')).toBeGreaterThan(-1);
    expect(deploy.indexOf('/deployments/$id/cancel')).toBeLessThan(deploy.indexOf("not ready after 10 minutes"));
  });

  it("the rollback finishes the new deployment first, and succeeds only when Production serves the previous one", () => {
    const rollback = deployJob.slice(deployJob.indexOf("id: rollback"), deployJob.indexOf("Record the change"));
    const order = ["/deployments/$one/cancel", "ROLLBACK NOT CONFIRMED: deployment", "/promote/$PREVIOUS", ".targets.production.id", '[[ "$current" == "$PREVIOUS" ]]', "ROLLBACK NOT CONFIRMED: Production serves"];
    const at = order.map((text) => rollback.indexOf(text));
    expect(at.every((i) => i >= 0), order.filter((_, i) => at[i] < 0).join()).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(deployJob).toContain("ROLLBACK: ${{ steps.rollback.outcome }}");
  });

  // The steps' own scripts, run against a stand-in for the Vercel API: a removed control turns these red.
  const hasShell = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
  const script = (id: string) => {
    const from = workflow.indexOf(`id: ${id}\n`);
    const start = workflow.indexOf("run: |\n", from) + "run: |\n".length;
    return workflow.slice(start).split("\n").filter((_, i, all) => all.slice(0, i + 1).every((line) => line === "" || line.startsWith("          "))).map((line) => line.slice(10)).join("\n");
  };
  function run(id: string, api: string, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "deploy-"));
    try {
      writeFileSync(join(dir, "curl"), `#!/bin/bash\nurl="\${@: -1}"\nfor a in "$@"; do [[ "$a" == -d ]] && break; done\necho "$*" >> "${dir}/calls"\n${api}\n`);
      writeFileSync(join(dir, "sleep"), "#!/bin/bash\nexit 0\n");
      chmodSync(join(dir, "curl"), 0o755); chmodSync(join(dir, "sleep"), 0o755);
      writeFileSync(join(dir, "step.sh"), script(id));
      const result = spawnSync("bash", [join(dir, "step.sh")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, VERCEL_TOKEN: "t", TEAM: "team", PROJECT: "prj", REPO_ID: "1", SHA: "a".repeat(40),
        GITHUB_OUTPUT: join(dir, "out"), GITHUB_RUN_ID: "77", PREVIOUS: "dpl_old", DEPLOYMENT: "", ...env } });
      let calls = ""; try { calls = readFileSync(join(dir, "calls"), "utf8"); } catch { /* no call */ }
      return { status: result.status, output: result.stdout + result.stderr, calls };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const project = (id: string) => `*"/v9/projects/"*) echo '{"targets":{"production":{"id":"${id}"}}}' ;;`;

  it.runIf(hasShell)("deploy: a build that never finishes is cancelled, and the run fails", () => {
    const { status, calls, output } = run("deploy", `case "$url" in ${project("dpl_old")}
      *"/v13/deployments?"*) echo '{"id":"dpl_new","projectId":"prj"}' ;;
      *"/cancel"*) echo '{}' ;;
      *) echo '{"readyState":"BUILDING"}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("not ready after 10 minutes");
    expect(calls).toContain("/deployments/dpl_new/cancel");
    expect(calls).toMatch(/--max-time 30/);
  });

  it.runIf(hasShell)("deploy: a deployment created in another project stops the run", () => {
    const { status, output } = run("deploy", `case "$url" in ${project("dpl_old")}
      *) echo '{"id":"dpl_new","projectId":"other"}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("not in the configured project");
  });

  it.runIf(hasShell)("rollback: finds a deployment whose creation answer was lost, stops it, then confirms Production", () => {
    const { status, calls } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_lost"}]}' ;;
      *"/cancel"*) echo '{}' ;;
      *"/promote/"*) echo '{}' ;;
      *) if grep -q cancel "$(dirname "$0")/calls"; then echo '{"readyState":"CANCELED"}'; else echo '{"readyState":"BUILDING"}'; fi ;; esac`);
    expect(status).toBe(0);
    expect(calls).toContain("meta-luxiaRun=77");
    expect(calls.indexOf("/deployments/dpl_lost/cancel")).toBeGreaterThan(-1);
    expect(calls.indexOf("/deployments/dpl_lost/cancel")).toBeLessThan(calls.indexOf("/promote/dpl_old"));
  });

  it.runIf(hasShell)("rollback: an accepted promotion that never takes effect is reported as not confirmed", () => {
    const { status, output } = run("rollback", `case "$url" in ${project("dpl_new")}
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"READY"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK NOT CONFIRMED: Production serves dpl_new");
  });

  it("the rollback also runs when the workflow is cancelled", () => {
    expect(workflow).toContain("if: (failure() || cancelled()) && steps.deploy.outputs.previous != ''");
  });

  it("no expression is interpolated inside a shell script: inputs reach shells through env only", () => {
    for (const block of workflow.matchAll(/run: \|\n((?: {10}.*\n?)+)/g)) expect(block[1]).not.toContain("${{");
  });
});
