import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// P1 step 1: Production operations start only by hand, through one gate that first checks the commit and its CI run.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const ci = read(".github/workflows/ci.yml");
const gate = read(".github/workflows/production-activation-gate.yml");
const identity = read(".github/workflows/production-identity-bootstrap.yml");
/** The text of a workflow's `on:` block. */
const triggers = (workflow: string) => workflow.slice(workflow.search(/^on:\n/m), workflow.search(/^(permissions|concurrency|jobs|env):/m));
/** The text of one job, up to the next job. */
const job = (workflow: string, name: string) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

describe("Production jobs by workflow_dispatch only", () => {
  it("a push to main starts no Production job: the commit-message triggers are gone from CI", () => {
    expect(ci).not.toMatch(/head_commit\.message/);
    expect(ci).not.toMatch(/environment: Production/);
    expect(ci).not.toMatch(/production-activation-gate\.yml|production-identity-bootstrap\.yml/);
  });

  it("the gate starts only by hand", () => {
    expect(triggers(gate)).toMatch(/^on:\n {2}workflow_dispatch:\n/);
    expect(triggers(gate)).not.toMatch(/\n {2}(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/);
  });

  it("the identity workflow is reached only through the gate: it has no trigger of its own", () => {
    expect(triggers(identity)).toMatch(/^on:\n {2}workflow_call:\n/);
    expect(triggers(identity)).not.toMatch(/\n {2}(workflow_dispatch|push|pull_request|pull_request_target|schedule|workflow_run):/);
  });

  it("the gate's first job checks the branch and the commit's CI run, and both Production jobs need it", () => {
    const verified = job(gate, "ci-verified");
    expect(verified).not.toMatch(/environment:|secrets\./);
    expect(verified).toMatch(/permissions:\n\s+contents: read\n\s+actions: read/);
    expect(verified).toContain("Dispatched from main, on a commit whose CI passed");
    for (const name of ["database-activation", "canonical-identity-bootstrap"]) expect(job(gate, name), name).toMatch(/\n {4}needs: ci-verified\n/);
    expect(job(gate, "database-activation")).toMatch(/\n {4}environment: Production\n/);
  });
});
