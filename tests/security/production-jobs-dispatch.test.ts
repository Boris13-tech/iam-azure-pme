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
    // Every string of the parsed value (keys too), as parsed: no JSON escaping between the text and the check.
    const strings = (value: unknown): string[] => typeof value === "string" ? [value]
      : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...strings(inner)]) : [];
    // The expressions of a string, read as GitHub does: a "}}" inside a quoted literal ('...', '' escapes a quote)
    // does not close the expression. An expression left open runs to the end of the string (fail closed).
    const expressions = (text: string): string[] => {
      const found: string[] = [];
      for (let start = text.indexOf("${{"); start >= 0; start = text.indexOf("${{", start + 3)) {
        let at = start + 3, quoted = false;
        for (; at < text.length; at++) {
          if (text[at] === "'") { if (quoted && text[at + 1] === "'") at++; else quoted = !quoted; }
          else if (!quoted && text.startsWith("}}", at)) break;
        }
        found.push(text.slice(start + 3, at));
        start = at - 1;
      }
      return found;
    };
    // Context names are case-insensitive in GitHub expressions.
    const namesSecrets = (value: unknown) => strings(value).flatMap(expressions).some((expression) => /(^|[^\w.])secrets\b/i.test(expression));
    // The job token under its other names (Codex, third pass of #179): github.token, github['token'], or the whole github
    // context (toJSON(github) carries the token). A job may use it itself; it may not hand it to a reusable workflow.
    const namesToken = (value: unknown) => strings(value).flatMap(expressions).some((expression) =>
      /(^|[^\w.])github\b/i.test(expression) && (/\btoken\b/i.test(expression) || /(^|[^\w.])github\b(?!\s*[.[])/i.test(expression)));
    /** Every violation in a parsed workflow; `checked` counts the secret-touching jobs seen. */
    const inspect = (doc: Workflow, label: string, load: (path: string) => Workflow, out: { checked: number; bad: string[] }) => {
      const { jobs = {}, ...rest } = doc;
      const workflowLevel = namesSecrets(rest);
      for (const [id, body] of Object.entries(jobs)) {
        const where = `${label} ${id}`;
        if (typeof body.uses === "string") {
          // A secret reaches a reusable workflow only through its secrets mapping, where the callee still reads it as
          // secrets.X (and is checked below). Anywhere else (with: inputs, if:, name) the callee would see a plain value.
          const { secrets: _passed, ...others } = body;
          if (namesSecrets(others)) { out.checked += 1; out.bad.push(`${where}: a secret passed outside the secrets mapping`); continue; }
          if (namesToken(body)) { out.checked += 1; out.bad.push(`${where}: the job token passed to a reusable workflow`); continue; }
          if (body.secrets === undefined && !workflowLevel) continue;
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
    for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/i.test(name)))
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
      // Correction pass of #179: a "}}" inside a quoted literal, a line break before the context, another case.
      lines("jobs:", "  x:", "    env:", "      TOKEN: ${{ format('}}{0}', secrets.TOKEN) }}", "    steps:", '      - run: echo "$TOKEN"'),
      lines("jobs:", "  x:", "    env:", "      TOKEN: ${{ format('it''s }}{0}', secrets.TOKEN) }}"),
      lines("jobs:", "  x:", "    env:", '      TOKEN: "${{\\nsecrets.TOKEN }}"'),
      lines("env:", '  TOKEN: "${{\\nsecrets.TOKEN }}"', "jobs:", "  x:", "    steps:", '      - run: echo "$TOKEN"'),
      lines("jobs:", "  x:", "    env:", "      TOKEN: ${{ Secrets.TOKEN }}"),
      lines("jobs:", "  x:", "    env:", "      TOKEN: ${{ SECRETS['TOKEN'] }}"),
      lines("jobs:", "  x:", "    env:", "      TOKEN: ${{ format('{0}', secrets.TOKEN"),
      // Antigravity's correction pass of #179: a secret passed as an input to a local reusable workflow.
      lines("jobs:", "  x:", "    uses: ./called.yml", "    with: { token: \"${{ secrets.T }}\" }"),
      lines("jobs:", "  x:", "    uses: ./called.yml", "    with:", "      token: ${{ toJSON(secrets) }}"),
      // Codex's third pass of #179: the job token under its other names, to a remote or a local reusable workflow.
      lines("jobs:", "  send:", "    uses: someone/repo/.github/workflows/w.yml@main", "    with:", "      token: ${{ github.token }}"),
      lines("jobs:", "  send:", "    uses: someone/repo/.github/workflows/w.yml@main", "    with:", "      token: ${{ secrets.GITHUB_TOKEN }}"),
      lines("jobs:", "  send:", "    uses: ./called.yml", "    with:", "      token: ${{ GitHub['token'] }}"),
      lines("jobs:", "  send:", "    uses: ./called.yml", "    with:", "      context: ${{ toJSON(github) }}"),
    ];
    for (const text of forms) expect(flagged(text), text).not.toEqual([]);
    // And no false alarm: the word "secrets" outside an expression, and protected jobs, are fine.
    const fine = [
      lines("jobs:", "  scan:", "    name: Scan for secrets", "    steps:", "      - run: gitleaks detect # finds secrets"),
      lines("jobs:", "  x:", "    env:", "      MODE: ${{ inputs.secrets }} and }} secrets outside"),
      // A job may use its own token; and a reusable workflow may receive other github values.
      lines("jobs:", "  x:", "    env:", "      GH_TOKEN: ${{ github.token }}", "    steps:", '      - run: gh api "repos/$GITHUB_REPOSITORY"'),
      lines("jobs:", "  x:", "    uses: ./called.yml", "    with:", "      sha: ${{ github.sha }}"),
      lines("jobs:", "  x:", "    environment: Production", "    steps:", '      - env: { ALL: "${{ toJSON(secrets) }}" }'),
      lines("env:", "  TOKEN: ${{ secrets.TOKEN }}", "jobs:", "  x:", "    environment: { name: staging }", "    steps:", '      - run: echo "$TOKEN"'),
    ];
    for (const text of fine) expect(flagged(text), text).toEqual([]);
  });
});
