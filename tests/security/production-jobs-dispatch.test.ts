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
    // Review follow-ups of #86 and #179: read with a YAML parser, all workflows. A job touches secrets when any expression
    // in it names the secrets context (secrets.X, secrets['X'], toJSON(secrets)), when it passes secrets to a reusable
    // workflow, or when its workflow sets a secret at workflow level (env above jobs).
    expect(job(identity, "canonical-identity-bootstrap")).toMatch(/\n {4}environment: Production\n/);
    const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
    type Job = { environment?: string | { name?: string }; uses?: string; secrets?: unknown };
    type Workflow = { jobs?: Record<string, Job> } & Record<string, unknown>;
    const PROTECTED = ["Production", "production-backup", "staging"];
    const environment = (job: Job) => (typeof job.environment === "string" ? job.environment : job.environment?.name);
    const namesSecrets = (value: unknown) =>
      [...JSON.stringify(value ?? null).matchAll(/\$\{\{[\s\S]*?\}\}/g)].some(([expression]) => /\bsecrets\b/.test(expression));
    /** Every violation in a parsed workflow; `checked` counts the secret-touching jobs seen. */
    const inspect = (doc: Workflow, label: string, load: (path: string) => Workflow, out: { checked: number; bad: string[] }) => {
      const { jobs = {}, ...rest } = doc;
      const workflowLevel = namesSecrets(rest);
      for (const [id, body] of Object.entries(jobs)) {
        const where = `${label} ${id}`;
        if (typeof body.uses === "string") {
          if (body.secrets === undefined && !namesSecrets(body) && !workflowLevel) continue;
          // A job that calls a reusable workflow cannot carry an environment itself. Local: each of the called
          // workflow's secret-touching jobs must be protected. Remote: no secret may be passed at all.
          if (body.uses.startsWith("./")) inspect(load(body.uses.slice(2)), `${where} ->`, load, out);
          else { out.checked += 1; out.bad.push(`${where}: secrets passed to a remote reusable workflow`); }
        } else if (workflowLevel || namesSecrets(body)) {
          out.checked += 1;
          if (!PROTECTED.includes(environment(body) ?? "")) out.bad.push(`${where}: not bound to a protected environment`);
        }
      }
      return out;
    };
    const fromRepo = (path: string) => yaml.load(read(path)) as Workflow;
    const result = { checked: 0, bad: [] as string[] };
    for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name)))
      inspect(fromRepo(`.github/workflows/${file}`), file, fromRepo, result);
    expect(result.bad).toEqual([]);
    expect(result.checked).toBeGreaterThanOrEqual(4);

    // The check itself: each form below is an unprotected job that touches secrets, and must be reported.
    const lines = (...text: string[]) => `${text.join("\n")}\n`;
    const called = lines("on: workflow_call", "jobs:", "  inner:", "    steps:", '      - run: echo "$T"', '        env: { T: "${{ secrets.T }}" }');
    const fake = (path: string) => { expect(path).toBe("called.yml"); return yaml.load(called) as Workflow; };
    const flagged = (text: string) => inspect(yaml.load(text) as Workflow, "form", fake, { checked: 0, bad: [] }).bad;
    const forms = [
      lines("jobs:", "  x:", "    steps:", `      - env: { A: "\${{ secrets['DATABASE_URL'] }}" }`),
      lines("jobs:", '  "x":', "    env:", "      A: ${{ secrets.DATABASE_URL }}"),
      lines("jobs:", "  x:", "    steps:", '      - env: { ALL: "${{ toJSON(secrets) }}" }'),
      lines("jobs:", "  x:", "    steps:", '      - env: { ALL: "${{toJSON( secrets )}}" }'),
      lines("env:", "  TOKEN: ${{ secrets.TOKEN }}", "jobs:", "  x:", "    steps:", '      - run: echo "$TOKEN"'),
      lines("jobs:", "  x:", "    uses: someone/repo/.github/workflows/w.yml@0123456789abcdef0123456789abcdef01234567", "    secrets: inherit"),
      lines("jobs:", "  x:", "    uses: someone/repo/.github/workflows/w.yml@main", '    secrets: { T: "${{ secrets.T }}" }'),
      lines("jobs:", "  x:", "    uses: ./called.yml", "    secrets: inherit"),
      lines("env:", "  TOKEN: ${{ secrets.TOKEN }}", "jobs:", "  x:", "    uses: someone/repo/.github/workflows/w.yml@main"),
    ];
    for (const text of forms) expect(flagged(text), text).not.toEqual([]);
    // And no false alarm: the word "secrets" outside an expression, and protected jobs, are fine.
    const fine = [
      lines("jobs:", "  scan:", "    name: Scan for secrets", "    steps:", "      - run: gitleaks detect # finds secrets"),
      lines("jobs:", "  x:", "    environment: Production", "    steps:", '      - env: { ALL: "${{ toJSON(secrets) }}" }'),
      lines("env:", "  TOKEN: ${{ secrets.TOKEN }}", "jobs:", "  x:", "    environment: { name: staging }", "    steps:", '      - run: echo "$TOKEN"'),
    ];
    for (const text of fine) expect(flagged(text), text).toEqual([]);
  });
});
