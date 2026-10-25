import { readFileSync } from "node:fs";
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
    expect(deployJob).toMatch(/if: failure\(\) && steps\.deploy\.outputs\.previous != ''/);
    expect(deployJob).toContain("/promote/$PREVIOUS");
    expect(deployJob).toContain("actions/runs/$RUN_ID/approvals");
    expect(deployJob).toContain("GITHUB_STEP_SUMMARY");
  });

  it("no expression is interpolated inside a shell script: inputs reach shells through env only", () => {
    for (const block of workflow.matchAll(/run: \|\n((?: {10}.*\n?)+)/g)) expect(block[1]).not.toContain("${{");
  });
});
