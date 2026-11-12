import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// GOV-001: the only path to change Production code waits for the operator's approval in the GitHub environment
// Production, checks that approval is recorded, deploys the exact commit, checks from outside, rolls back on failure
// without ever taking a lost answer for success, records the change, and checks Production again in a separate job.
const workflow = readFileSync(".github/workflows/production-deploy.yml", "utf8").replace(/\r\n/g, "\n");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
type Step = { id?: string; name?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string; ["timeout-minutes"]?: number };
type Job = { needs?: string | string[]; if?: string; environment?: string; env?: Record<string, string>; permissions?: unknown; steps: Step[]; ["timeout-minutes"]?: number; outputs?: Record<string, string> };
const parsed = yaml.load(workflow) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };
const { verify, deploy, confirm } = parsed.jobs;
const step = (job: Job, id: string) => job.steps.find((s) => s.id === id)!;
const MONITORING = "m".repeat(40); // the readiness token of the tests' Production environment
const VERCEL = "vercel-test-token-0123456789abcdef"; // the deploy token of the tests: it must never reach a command line

describe("Production deploy workflow (GOV-001)", () => {
  it("starts only by hand, with the exact commit and a reason", () => {
    expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
    expect(workflow).toMatch(/reason:\n        description: [^\n]+\n        required: true/);
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(Object.keys(parsed.jobs)).toEqual(["verify", "deploy", "confirm"]);
  });

  it("verifies the commit is a full SHA on main with a green CI run, before any approval is asked", () => {
    const script = JSON.stringify(verify);
    expect(script).not.toMatch(/environment|secrets\./);
    expect(verify.steps[0].run).toContain('[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(verify.steps[0].run).toContain("compare/$SHA...main");
    expect(verify.steps[0].run).toContain("actions/workflows/ci.yml/runs?head_sha=$SHA&status=success");
  });

  it("deploys only after approval in the protected environment, and its first step checks that approval is recorded", () => {
    expect(deploy.needs).toBe("verify");
    expect(deploy.environment).toBe("Production");
    expect(deploy.steps[0].id).toBe("approval");
    expect(deploy.steps[1].id).toBe("deploy");
    expect(deploy.steps[1].run).toContain('gitSource: {type: "github", repoId: $repo, ref: "main", sha: $sha}');
    expect(deploy.steps[1].run).toContain('[[ "$current" == "$id" ]]');
  });

  it("the Vercel token reaches only the two steps that call Vercel (Antigravity, review of #136)", () => {
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))
      .toEqual(["VERCEL_DEPLOY_TOKEN", "LUXIA_MONITORING_TOKEN", "LUXIA_MONITORING_TOKEN", "VERCEL_DEPLOY_TOKEN"]);
    expect(JSON.stringify(deploy.env ?? {})).not.toContain("secrets");
    const holders = (name: string) => deploy.steps.filter((s) => JSON.stringify(s.env ?? {}).includes(`secrets.${name}`)).map((s) => s.id);
    expect(holders("VERCEL_DEPLOY_TOKEN")).toEqual(["deploy", "rollback"]);
    // The readiness token: the deploy step only checks that it is configured; the checks step sends it.
    expect(holders("LUXIA_MONITORING_TOKEN")).toEqual(["deploy", "checks"]);
    expect(JSON.stringify(confirm)).not.toContain("secrets");
  });

  it("no token is ever an argument of a command: both Vercel helpers read a header file, removed when the step ends (Codex, review of #189)", () => {
    for (const id of ["deploy", "rollback"]) {
      const run = step(deploy, id).run!;
      expect(run, id).not.toMatch(/Bearer \$VERCEL_TOKEN"/);
      expect(run, id).toMatch(/\(umask 077; printf 'Authorization: Bearer %s\\n' "\$VERCEL_TOKEN" > "\$auth"\); trap 'rm -f "\$auth"' EXIT/);
      expect(run.match(/curl /g)?.length, id).toBe(1); // the helper is the only curl of the step
      expect(run, id).toMatch(/curl [^\n]*-H @"\$auth"/);
    }
    expect(step(deploy, "checks").run).toMatch(/curl [^\n]*-H @"\$header"[^\n]*\/api\/internal\/readiness/);
    expect(step(deploy, "checks").run).not.toMatch(/-H "x-luxia-monitoring-token/);
    // An EXIT trap removes it whenever the step's shell exits, normally or on an error (Antigravity, review of #189). A
    // runner killed outright (SIGKILL) runs no trap; the file then dies with the runner's temporary space. This test
    // checks that the trap is written, not an interruption.
    expect(step(deploy, "checks").run).toContain(`> "$header"); trap 'rm -f "$header"' EXIT`);
  });

  it("the time budget keeps the rollback's window inside the job (Codex F3, review of #136)", () => {
    const minutes = deploy.steps.filter((s) => s.run).map((s) => s["timeout-minutes"]);
    expect(minutes.every((m) => typeof m === "number")).toBe(true);
    expect((minutes as number[]).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(deploy["timeout-minutes"]!);
    expect(step(deploy, "rollback")["timeout-minutes"]).toBe(11);
    expect(step(deploy, "rollback").run).toContain('budget="${ROLLBACK_BUDGET_SECONDS:-540}"');
    expect(step(deploy, "rollback").run).toContain("(( budget <= 540 )) || budget=540");
  });

  it("a separate job without any secret checks Production after every run, even a cancelled one", () => {
    expect(confirm.needs).toBe("deploy");
    expect(confirm.if).toBe("always() && needs.deploy.result != 'skipped'");
    expect(confirm.permissions).toEqual({});
    expect(confirm.environment).toBeUndefined();
  });

  it("the rollback runs on failure or cancellation once a deployment may exist", () => {
    expect(step(deploy, "rollback").if).toBe("(failure() || cancelled()) && steps.deploy.outputs.attempted == 'true'");
    const run = step(deploy, "deploy").run!;
    expect(run.indexOf('echo "attempted=true"')).toBeGreaterThan(-1);
    expect(run.indexOf('echo "attempted=true"')).toBeLessThan(run.indexOf("-X POST"));
  });

  it("no expression is interpolated inside a shell script: inputs reach shells through env only", () => {
    for (const job of Object.values(parsed.jobs)) for (const s of job.steps) if (s.run) expect(s.run).not.toContain("${{");
  });

  // The steps' own scripts, run against stand-ins for the Vercel and GitHub APIs: a removed control turns these red.
  const hasShell = spawnSync("bash", ["-c", "command -v jq"]).status === 0;
  it.runIf(process.env.CI)("in CI these script tests really run", () => expect(hasShell).toBe(true));
  // spawnSync blocks the event loop, so the test's own limit cannot interrupt it: the child has a hard deadline
  // (25 s by default, 5 s under the test's limit), and a child killed at its deadline fails the test explicitly.
  function run(id: string, api: string, env: Record<string, string> = {}, gh = "exit 1", deadlineMs = 25_000) {
    const script = [verify, deploy, confirm].flatMap((job) => job.steps).find((s) => s.id === id)!.run!;
    const dir = mkdtempSync(join(tmpdir(), "deploy-"));
    try {
      writeFileSync(join(dir, "curl"), `#!/bin/bash\nfor a in "$@"; do [[ "$a" == https://* ]] && url="$a"; done\necho "$*" >> "${dir}/calls"\n${api}\n`);
      writeFileSync(join(dir, "gh"), `#!/bin/bash\n${gh}\n`);
      // A short real pause instead of the step's 10 s: loops still advance quickly, without spinning the CPU.
      writeFileSync(join(dir, "sleep"), "#!/bin/bash\n/bin/sleep 0.05\n");
      for (const tool of ["curl", "gh", "sleep"]) chmodSync(join(dir, tool), 0o755);
      writeFileSync(join(dir, "step.sh"), script);
      const result = spawnSync("bash", [join(dir, "step.sh")], { cwd: dir, encoding: "utf8", timeout: deadlineMs, killSignal: "SIGKILL", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        VERCEL_TOKEN: VERCEL, MONITORING_TOKEN: MONITORING, TEAM: "team", PROJECT: "prj", REPO_ID: "1", SHA: "a".repeat(40), REASON: "test", REPO: "o/r", BASE: "https://example.invalid",
        GITHUB_OUTPUT: join(dir, "out"), GITHUB_STEP_SUMMARY: join(dir, "summary"), GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2", RUN_ID: "77", PREVIOUS: "dpl_old", DEPLOYMENT: "",
        ROLLBACK_BUDGET_SECONDS: "10", ...env } });
      if (result.error) throw new Error(`step ${id} did not finish within ${deadlineMs} ms: ${result.error.message}`);
      const read = (name: string) => { try { return readFileSync(join(dir, name), "utf8"); } catch { return ""; } };
      return { status: result.status, output: result.stdout + result.stderr, calls: read("calls"), out: read("out"), summary: read("summary"), record: read("production-change-record.json") };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const project = (id: string) => `*"/v9/projects/"*) echo '{"targets":{"production":{"id":"${id}"}}}' ;;`;
  // Vercel's environment variables of the project (names and targets only), as the deploy step reads them before sending.
  const vercelEnvs = (envs: unknown = [{ key: "AUTHZ_MODE", target: ["production", "preview"] }, { key: "LUXIA_MONITORING_TOKEN", target: ["production"] },
    { key: "CRON_SECRET", target: "production" }]) => `*"/v10/projects/"*) echo '${JSON.stringify({ envs })}' ;;`;

  it.runIf(hasShell)("approval: unreadable, missing, or for another environment, nothing is deployed (Codex F4)", () => {
    for (const [gh, message] of [
      ["exit 1", "cannot be read"],
      ["echo '[]'", "no approval is recorded"],
      [`echo '[{"state":"rejected","user":{"login":"op"},"environments":[{"name":"Production"}]}]'`, "no approval is recorded"],
      [`echo '[{"state":"approved","user":{"login":"op"},"environments":[{"name":"staging"}]}]'`, "no approval is recorded"],
    ]) {
      const { status, output, out } = run("approval", "exit 1", {}, gh);
      expect(status, gh).not.toBe(0);
      expect(output, gh).toContain(message);
      expect(out, gh).not.toContain("approved_by");
      expect(out, gh).toContain("refused=true"); // the confirm job's explicit evidence that nothing was deployed
    }
    const ok = run("approval", "exit 1", {}, `echo '[{"state":"approved","user":{"login":"op"},"environments":[{"name":"Production"}]}]'`);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("approved_by=op");
  }, 30_000);

  it.runIf(hasShell)("deploy: a build that never finishes is cancelled, and the run fails", () => {
    const { status, calls, output, out } = run("deploy", `case "$url" in ${project("dpl_old")} ${vercelEnvs()}
      *"/v13/deployments?"*) echo '{"id":"dpl_new","projectId":"prj"}' ;;
      *"/cancel"*) echo '{}' ;;
      *) echo '{"readyState":"BUILDING"}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("not ready after 10 minutes");
    expect(calls).toContain("/deployments/dpl_new/cancel");
    expect(calls).toMatch(/--max-time 30/);
    expect(calls).toContain("-H @"); // the token is read from a file by curl
    expect(calls).not.toContain(VERCEL); // and never appears among its arguments
    expect(out).toContain("attempted=true");
  }, 30_000);

  it.runIf(hasShell)("deploy: a lost creation answer still leaves 'attempted' recorded for the rollback", () => {
    const { status, out, calls } = run("deploy", `case "$url" in ${project("dpl_old")} ${vercelEnvs()}
      *"/v13/deployments?"*) exit 28 ;; esac`);
    expect(status).not.toBe(0);
    expect(out).toContain("previous=dpl_old");
    expect(out).toContain("not_attempted=true");
    expect(out.indexOf("attempted=true", out.indexOf("not_attempted=true") + 1)).toBeGreaterThan(-1);
    expect(out).not.toContain("deployment=");
    // The deployment carries the run and its attempt, so a rerun cannot mistake an earlier attempt's deployment for it.
    expect(calls).toMatch(/"luxiaRun": ?"77\.2"/);
  }, 30_000);

  it.runIf(hasShell)("deploy: a deployment created in another project stops the run", () => {
    const { status, output } = run("deploy", `case "$url" in ${project("dpl_old")} ${vercelEnvs()}
      *) echo '{"id":"dpl_new","projectId":"other"}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("not in the configured project");
  }, 30_000);

  // Codex F2, consolidated review of the Release Candidate: missing or invalid monitoring parameters refuse the deploy
  // before anything is sent; afterwards, public pages alone never make a deployment pass.
  it.runIf(hasShell)("deploy: missing or invalid monitoring parameters refuse before anything is sent", () => {
    const refusals: Array<[string, Record<string, string>, string]> = [
      [vercelEnvs(), { MONITORING_TOKEN: "" }, "LUXIA_MONITORING_TOKEN is missing or shorter than 32 characters"],
      [vercelEnvs(), { MONITORING_TOKEN: "m".repeat(31) }, "LUXIA_MONITORING_TOKEN is missing or shorter than 32 characters"],
      [`*"/v10/projects/"*) echo 'forbidden'; exit 22 ;;`, {}, "environment variables cannot be read"],
      [vercelEnvs([{ key: "LUXIA_MONITORING_TOKEN", target: ["production"] }, { key: "CRON_SECRET", target: ["production"] }]), {}, "AUTHZ_MODE is not set for Production"],
      [vercelEnvs([{ key: "AUTHZ_MODE", target: ["production"] }, { key: "CRON_SECRET", target: ["production"] }]), {}, "LUXIA_MONITORING_TOKEN is not set for Production"],
      [vercelEnvs([{ key: "AUTHZ_MODE", target: ["production"] }, { key: "LUXIA_MONITORING_TOKEN", target: ["production"] }]), {}, "CRON_SECRET is not set for Production"],
      [vercelEnvs([{ key: "AUTHZ_MODE", target: ["preview", "development"] }, { key: "LUXIA_MONITORING_TOKEN", target: ["production"] }, { key: "CRON_SECRET", target: ["production"] }]), {}, "AUTHZ_MODE is not set for Production"],
      [vercelEnvs([]), {}, "AUTHZ_MODE is not set for Production"],
      [`*"/v10/projects/"*) echo 'not json' ;;`, {}, "environment variables cannot be read"],
    ];
    // Values in Vercel's answer are dropped as it is read: a value never reaches the step's output.
    const withValues = vercelEnvs([{ key: "AUTHZ_MODE", target: ["production"], value: "value-must-not-leak" }]);
    const leaked = run("deploy", `case "$url" in ${project("dpl_old")} ${withValues}
        *) echo '{}' ;; esac`);
    expect(leaked.output).toContain("LUXIA_MONITORING_TOKEN is not set for Production");
    expect(leaked.output + leaked.out).not.toContain("value-must-not-leak");
    expect(step(deploy, "deploy").run).toContain(`| jq -c '[.envs[]? | {key, target}]')"`);
    for (const [envs, env, message] of refusals) {
      const { status, output, out, calls } = run("deploy", `case "$url" in ${project("dpl_old")} ${envs}
        *) echo '{"id":"dpl_new","projectId":"prj","readyState":"READY"}' ;; esac`, env);
      expect(status, message).not.toBe(0);
      expect(output, message).toContain(message);
      expect(output, message).toContain("nothing is deployed");
      expect(out, message).toContain("not_attempted=true"); // the confirm job's evidence that nothing was sent
      expect(out.replace("not_attempted=true", ""), message).not.toContain("attempted=true");
      expect(calls, message).not.toContain("-X POST");
      expect(output + calls, message).not.toContain(MONITORING);
    }
  }, 30_000);

  // The after-checks against a stand-in Production: public pages healthy, readiness as given. The stand-in reads the token
  // from the header file the step passes, as the application does, and answers 401 when it is not the configured one.
  const production = (readiness: string) => `
    hdr=""; prev=""; for a in "$@"; do [[ "$prev" == "-H" && "$a" == @* ]] && hdr="\${a#@}"; prev="$a"; done
    case "$url" in
      */login) echo '<title>LUXIA</title>' > login.html; printf 200 ;;
      */api/canonical/sessions) echo '{"error":"Unauthorized"}' > api.json; printf 401 ;;
      */api/internal/readiness)
        token="$(sed -n 's/^x-luxia-monitoring-token: //p' "$hdr" 2>/dev/null)"
        if [[ "$token" != "${MONITORING}" ]]; then echo '{"error":"Unauthorized"}' > ready.json; printf 401; exit 0; fi
        ${readiness} ;;
      *) printf '307 https://example.invalid/login' ;;
    esac`;
  const answer = (code: number, body: unknown) => `echo '${JSON.stringify(body)}' > ready.json; printf ${code}`;
  const allReady = { ready: true, checks: { authorization: true, database: true, session: true } };

  it.runIf(hasShell)("checks: the deployment passes only with public pages and an authenticated readiness that is fully ready", () => {
    const ok = run("checks", production(answer(200, allReady)));
    expect(ok.status, ok.output).toBe(0);
    expect(ok.output).toContain("readiness included");
    expect(ok.calls).toContain("/api/internal/readiness");
    // The token never appears on a command line or in the log.
    expect(ok.calls + ok.output).not.toContain(MONITORING);
  }, 30_000);

  it.runIf(hasShell)("checks: database down, authorization misconfigured, session path failing, token absent or invalid, timeout: the step fails", () => {
    const failing: Array<[string, string, Record<string, string>]> = [
      ["database unavailable", answer(503, { ready: false, checks: { authorization: true, database: false, session: false } }), {}],
      ["authorization misconfigured", answer(503, { ready: false, checks: { authorization: false, database: true, session: true } }), {}],
      ["session path failing", answer(503, { ready: false, checks: { authorization: true, database: true, session: false } }), {}],
      ["token absent", answer(200, allReady), { MONITORING_TOKEN: "" }],
      ["token invalid", answer(200, allReady), { MONITORING_TOKEN: "x".repeat(40) }],
      ["readiness timeout", "exit 28", {}],
      ["readiness missing (old deployment, 401 from the middleware)", `echo '{"error":"Unauthorized"}' > ready.json; printf 401`, {}],
      ["200 with a check false", answer(200, { ready: true, checks: { authorization: true, database: true, session: false } }), {}],
      ["200 without checks", answer(200, { ready: true }), {}],
      ["200 with a body that is not JSON", "echo 'ok' > ready.json; printf 200", {}],
    ];
    for (const [name, readiness, env] of failing) {
      const { status, output } = run("checks", production(readiness), env);
      expect(status, name).toBe(1);
      expect(output, name).toContain("after-checks failed");
      expect(output, name).toMatch(/attempt 3 failed: login=200 root=307 https:\/\/example.invalid\/login api=401 readiness=/);
    }
  }, 30_000);

  it("a failed after-check is a failed step: the rollback runs, and the run cannot end green", () => {
    // The rollback's condition covers a failed step; its own outcomes (confirmed, not confirmed, unresolved) are the
    // rollback tests below. A rollback that cannot be confirmed fails the run (ROLLBACK NOT CONFIRMED, UNRESOLVED).
    expect(step(deploy, "rollback").if).toContain("failure()");
    expect(step(deploy, "checks").run).toMatch(/echo "::error::after-checks failed"; exit 1$/m);
    expect(step(deploy, "rollback").run).toContain("ROLLBACK NOT CONFIRMED");
    expect(step(deploy, "rollback").run).toContain("ROLLBACK UNRESOLVED");
  });

  it.runIf(hasShell)("rollback: finds a deployment whose creation answer was lost, stops it, then confirms Production", () => {
    const { status, calls } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_lost"}]}' ;;
      *"/cancel"*) echo '{}' ;;
      *"/promote/"*) echo '{}' ;;
      *) if grep -q cancel "$(dirname "$0")/calls"; then echo '{"readyState":"CANCELED"}'; else echo '{"readyState":"BUILDING"}'; fi ;; esac`);
    expect(status).toBe(0);
    expect(calls).toContain("meta-luxiaRun=77.2");
    expect(calls.indexOf("/deployments/dpl_lost/cancel")).toBeGreaterThan(-1);
    expect(calls.indexOf("/deployments/dpl_lost/cancel")).toBeLessThan(calls.indexOf("/promote/dpl_old"));
    expect(calls).toContain("-H @");
    expect(calls).not.toContain(VERCEL); // the rollback's token is never a command argument either
  }, 30_000);

  it.runIf(hasShell)("rollback: a deployment of an earlier attempt cannot stand in for this attempt's lost one (Codex F1, second pass)", () => {
    const { status, output } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"meta-luxiaRun=77.2"*) echo '{"deployments":[]}' ;;
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_attempt1"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"ERROR"}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: a deployment was requested but none of this run can be found");
    expect(output).not.toContain("rolled back:");
  }, 30_000);

  it.runIf(hasShell)("rollback: a slow Production query in the first promotion window cannot take the retry's turn (Codex F2, third pass)", () => {
    // Listing, states and promotion answer at once; every Production query hangs for the whole --max-time it is given.
    const api = `case "$url" in
      *"/v9/projects/"*) t=30; prev=""; for a in "$@"; do [[ "$prev" == "--max-time" ]] && t="$a"; prev="$a"; done; /bin/sleep "$t"; exit 28 ;;
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"ERROR"}' ;; esac`;
    // The only test with a 16 s budget: its child deadline is 35 s, and its limit 40 s.
    const { status, output, calls } = run("rollback", api, { DEPLOYMENT: "dpl_new", ROLLBACK_BUDGET_SECONDS: "16" }, "exit 1", 35_000);
    expect(status).not.toBe(0);
    expect(calls.match(/\/promote\/dpl_old/g)).toHaveLength(2);
    expect(output).toContain("ROLLBACK NOT CONFIRMED");
  }, 40_000);

  it.runIf(hasShell)("rollback: slow answers near the deadline: no request outlasts it, and the diagnostic is written (Codex F2, second pass)", () => {
    // A stand-in that hangs for the whole --max-time it is given, then fails: the worst case for every request.
    const hang = `t=30; prev=""; for a in "$@"; do [[ "$prev" == "--max-time" ]] && t="$a"; prev="$a"; done; echo "max-time $t" >> "$(dirname "$0")/limits"; /bin/sleep "$t"; exit 28`;
    const started = Date.now();
    const { status, output } = run("rollback", hang, { DEPLOYMENT: "dpl_new", ROLLBACK_BUDGET_SECONDS: "8" });
    const elapsed = (Date.now() - started) / 1000;
    expect(status).not.toBe(0);
    expect(output).toMatch(/ROLLBACK (UNRESOLVED|NOT CONFIRMED)/);
    expect(elapsed).toBeLessThan(8 + 5);
  }, 30_000);

  it.runIf(hasShell)("rollback: no deployment of this run can be found after a request was sent: unresolved, never success (Codex F1)", () => {
    const { status, output, calls } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[]}' ;;
      *"/promote/"*) echo '{}' ;; esac`);
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: a deployment was requested but none of this run can be found");
    expect(output).not.toContain("rolled back:");
    expect(calls).toContain("/promote/dpl_old"); // the previous deployment is still promoted, as a best effort
  }, 30_000);

  it.runIf(hasShell)("rollback: the deployments of this run cannot be listed: unresolved", () => {
    const { status, output } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) exit 22 ;;
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"READY"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: the deployments of this run could not be listed");
  }, 30_000);

  it.runIf(hasShell)("rollback: a lost promotion answer does not stop the run; Production state decides (Codex F2)", () => {
    const { status, output, calls } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) exit 28 ;;
      *) echo '{"readyState":"ERROR"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).toBe(0);
    expect(output).toContain("promotion request 1 failed or its answer was lost");
    expect(output).toContain("rolled back: Production serves dpl_old");
    expect(calls.lastIndexOf("/v9/projects/")).toBeGreaterThan(calls.indexOf("/promote/dpl_old"));
  }, 30_000);

  it.runIf(hasShell)("rollback: an accepted promotion that never takes effect is retried, then reported as not confirmed", () => {
    const { status, output, calls } = run("rollback", `case "$url" in ${project("dpl_new")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"READY"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK NOT CONFIRMED: Production last seen serving dpl_new");
    expect(calls.match(/\/promote\/dpl_old/g)).toHaveLength(2);
  }, 30_000);

  it.runIf(hasShell)("rollback: a failed last read keeps the Production state actually seen in the diagnostic (CI of d0c87c0)", () => {
    // Production is read once (still the new deployment), then every read fails: the diagnostic names what was seen.
    const api = `case "$url" in
      *"/v9/projects/"*) n="$(dirname "$0")/reads"; if [[ -f "$n" ]]; then exit 28; fi; touch "$n"; echo '{"targets":{"production":{"id":"dpl_new"}}}' ;;
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *) echo '{"readyState":"READY"}' ;; esac`;
    const { status, output } = run("rollback", api, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK NOT CONFIRMED: Production last seen serving dpl_new, not dpl_old");
  }, 30_000);

  it.runIf(hasShell)("rollback: a deployment that will not stop is unresolved, within the budget", () => {
    const started = Date.now();
    const { status, output } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *"/cancel"*) echo '{}' ;;
      *) echo '{"readyState":"BUILDING"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: deployment dpl_new is still BUILDING (last state seen). Production last seen serving");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 30_000);

  it.runIf(hasShell)("rollback: a failed state read keeps the deployment state actually seen (main CI of 24383c5)", () => {
    // The deployment is read once (BUILDING), then every state read fails: the diagnostic names what was seen,
    // as it does for Production (fc58715). On a loaded runner the last read had failed and the state was lost.
    const { status, output } = run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[{"uid":"dpl_new"}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *"/cancel"*) echo '{}' ;;
      *"/v13/deployments/"*) n="$(dirname "$0")/states"; if [[ -f "$n" ]]; then exit 28; fi; touch "$n"; echo '{"readyState":"BUILDING"}' ;; esac`, { DEPLOYMENT: "dpl_new" });
    expect(status).not.toBe(0);
    // The whole sentence: the state is named once (Codex review of ade6213: "BUILDING (last state seen)BUILDING").
    expect(output).toContain("ROLLBACK UNRESOLVED: deployment dpl_new is still BUILDING (last state seen). Production last seen serving");
  }, 30_000);

  // Boundaries of the state kept between reads (Codex review of ade6213, F3).
  const stateRun = (states: string, ids = "dpl_new") => run("rollback", `case "$url" in ${project("dpl_old")}
      *"/v6/deployments"*) echo '{"deployments":[${ids.split(" ").map((id) => `{"uid":"${id}"}`).join(",")}]}' ;;
      *"/promote/"*) echo '{}' ;;
      *"/cancel"*) echo '{}' ;;
      *"/v13/deployments/"*) n="$(dirname "$0")/states"; ${states} ;; esac`, { DEPLOYMENT: ids.split(" ")[0] });

  it.runIf(hasShell)("rollback: a deployment never read is reported as unknown, never as a state", () => {
    const { status, output } = stateRun("exit 28");
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: deployment dpl_new is in an unknown state (never read). Production last seen serving");
  }, 30_000);

  it.runIf(hasShell)("rollback: an empty answer does not erase the state seen, and a failed answer is never believed", () => {
    // BUILDING once; then answers that succeed without a state, and answers that fail while printing READY.
    const { status, output } = stateRun(`if [[ ! -f "$n" ]]; then touch "$n"; echo '{"readyState":"BUILDING"}'; exit 0; fi
        if [[ -f "$n.2" ]]; then rm "$n.2"; echo '{"readyState":"READY"}'; exit 28; fi; touch "$n.2"; echo '{}'`);
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: deployment dpl_new is still BUILDING (last state seen). Production last seen serving");
  }, 30_000);

  it.runIf(hasShell)("rollback: the state seen for one deployment never carries over to the next", () => {
    // dpl_a answers BUILDING until the budget ends; dpl_b is never read: it must be reported unknown, not BUILDING.
    const { status, output } = stateRun(`case "$url" in *dpl_a*) echo '{"readyState":"BUILDING"}' ;; *) exit 28 ;; esac`, "dpl_a dpl_b");
    expect(status).not.toBe(0);
    expect(output).toContain("ROLLBACK UNRESOLVED: deployment dpl_b is in an unknown state (never read). Production last seen serving");
  }, 30_000);

  it.runIf(hasShell)("record: the reason cannot break the table, and the JSON record keeps it whole", () => {
    const reason = "fix | injected\n| row | `code`";
    const { status, summary, record } = run("record", "exit 1", { REASON: reason, APPROVED_BY: "op", DEPLOYMENT: "dpl_new", DEPLOY: "success", CHECKS: "failure", ROLLBACK: "success" });
    expect(status).toBe(0);
    const reasonRow = summary.split("\n").find((line) => line.startsWith("| Reason |"))!;
    expect(reasonRow.split("|")).toHaveLength(4);
    expect(summary.split("\n").filter((line) => line.startsWith("| row"))).toEqual([]);
    expect(JSON.parse(record)).toMatchObject({ reason, approvedBy: "op", deployment: "dpl_new", checks: "failure", rollback: "success" });
    const refused = run("record", "exit 1", { APPROVED_BY: "" });
    expect(refused.summary).toContain("none: nothing was deployed");
  }, 30_000);

  it.runIf(hasShell)("confirm: Production is checked after every run, and an unproven state makes the run red", () => {
    const healthy = `case "$url" in *"/login"*) echo '<title>LUXIA</title>' > login.html; printf 200 ;; *) printf 401 ;; esac`;
    const down = "printf 000";
    const started = { REFUSED: "", NOT_ATTEMPTED: "true" };
    const cases: Array<[string, Record<string, string>, number]> = [
      [healthy, { ...started, DEPLOY_RESULT: "success", ATTEMPTED: "true" }, 0],
      [down, { ...started, DEPLOY_RESULT: "success", ATTEMPTED: "true" }, 1],
      [healthy, { ...started, DEPLOY_RESULT: "failure", ATTEMPTED: "true" }, 1],
      [healthy, { ...started, DEPLOY_RESULT: "cancelled", ATTEMPTED: "true" }, 1],
      // Explicit evidence that nothing was sent: the approval step wrote refused=true, or the deploy step stopped
      // before its request (not_attempted without attempted).
      [healthy, { REFUSED: "true", NOT_ATTEMPTED: "", ATTEMPTED: "", DEPLOY_RESULT: "failure" }, 0],
      [healthy, { ...started, DEPLOY_RESULT: "failure", ATTEMPTED: "" }, 0],
      [down, { ...started, DEPLOY_RESULT: "failure", ATTEMPTED: "" }, 1],
      // Missing evidence proves nothing (Codex F3 second pass, F1 third pass): every output missing, a cancelled job,
      // and a refusal contradicted by attempted=true.
      [healthy, { REFUSED: "", NOT_ATTEMPTED: "", ATTEMPTED: "", DEPLOY_RESULT: "failure" }, 1],
      [healthy, { REFUSED: "", NOT_ATTEMPTED: "", ATTEMPTED: "", DEPLOY_RESULT: "cancelled" }, 1],
      [healthy, { REFUSED: "", NOT_ATTEMPTED: "", ATTEMPTED: "true", DEPLOY_RESULT: "failure" }, 1],
      [healthy, { REFUSED: "true", NOT_ATTEMPTED: "", ATTEMPTED: "true", DEPLOY_RESULT: "failure" }, 1],
    ];
    for (const [api, env, expected] of cases) {
      const { status, output } = run("confirm", api, env);
      expect(status, JSON.stringify(env)).toBe(expected);
      if (expected) expect(output).toContain("MANUAL CHECK REQUIRED");
    }
  }, 30_000);
});
