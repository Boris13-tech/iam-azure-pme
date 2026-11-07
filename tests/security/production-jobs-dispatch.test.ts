import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
    for (const refusal of ['if [ "$GITHUB_REF" != "refs/heads/main" ]; then echo "REFUSED:', 'if [ "$conclusion" != "success" ]; then echo "REFUSED:', 'if [ "$run_sha" != "$GITHUB_SHA" ]; then echo "REFUSED:'])
      expect(verified, refusal).toMatch(new RegExp(`${refusal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*; exit 1; fi\\n`));
    for (const name of ["database-activation", "canonical-identity-bootstrap"]) expect(job(gate, name), name).toMatch(/\n {4}needs: ci-verified\n/);
    expect(job(gate, "database-activation")).toMatch(/\n {4}environment: Production\n/);
  });

  it("in every workflow, a job that touches any secret is bound to a protected environment (parsed, any syntax)", () => {
    // Review follow-ups of #86 and #179: read with a YAML parser (quoted job ids, bracket syntax, inherit), all workflows.
    expect(job(identity, "canonical-identity-bootstrap")).toMatch(/\n {4}environment: Production\n/);
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
    type Job = { environment?: string | { name?: string }; uses?: string; secrets?: unknown };
    const PROTECTED = ["Production", "production-backup", "staging"];
    const parsed = (path: string) => (yaml.load(read(path)) as { jobs?: Record<string, Job> }).jobs ?? {};
    const environment = (job: Job) => (typeof job.environment === "string" ? job.environment : job.environment?.name);
    const touchesSecrets = (job: Job) => /secrets\s*(\.|\[)/.test(JSON.stringify(job));
    let checked = 0;
    for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name))) {
      for (const [id, body] of Object.entries(parsed(`.github/workflows/${file}`))) {
        if (body.uses?.startsWith("./") && body.secrets !== undefined) {
          // A local reusable workflow that receives secrets: each of its jobs that uses them must be protected itself.
          for (const [calledId, called] of Object.entries(parsed(body.uses.slice(2))))
            if (touchesSecrets(called)) { checked += 1; expect(PROTECTED, `${file} ${id} -> ${calledId}`).toContain(environment(called)); }
        } else if (touchesSecrets(body)) { checked += 1; expect(PROTECTED, `${file} ${id}`).toContain(environment(body)); }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    // The check itself: bracket syntax and a quoted job id both count, and neither job is protected.
    const forms = ["jobs:\n  x:\n    steps:\n      - env: { A: \"${{ secrets['DATABASE_URL'] }}\" }\n", "jobs:\n  \"x\":\n    env:\n      A: ${{ secrets.DATABASE_URL }}\n"];
    for (const text of forms) {
      const [only] = Object.values((yaml.load(text) as { jobs: Record<string, Job> }).jobs);
      expect(touchesSecrets(only), text).toBe(true);
      expect(PROTECTED).not.toContain(environment(only));
    }
  });
});
