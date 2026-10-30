import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Finding confirmed on 2026-10-18: workflow inputs were interpolated with expressions directly into the shell scripts of
// a Production workflow, so a crafted value could run commands in a job that holds Production secrets. Inputs now reach
// the shell through `env:` only. These tests hold that on the source, and prove it by running the real step scripts with
// hostile payloads. A control shows that the same payloads do execute under the old, interpolated form. The mode is also
// checked against an allowlist first (fail closed): any value other than preflight or apply stops the job before
// anything else, and is never echoed (no log or workflow-command pollution).
const PRODUCTION_WORKFLOWS = [".github/workflows/production-identity-bootstrap.yml", ".github/workflows/production-activation-gate.yml"];
const BOOTSTRAP = PRODUCTION_WORKFLOWS[0];
const read = (path: string) => readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

/** Every `run:` script of a workflow (block or single line), found by indentation: no YAML dependency needed. */
function runScripts(path: string): Array<{ line: number; script: string }> {
  const lines = read(path).split("\n");
  const scripts: Array<{ line: number; script: string }> = [];
  lines.forEach((text, index) => {
    const block = /^(\s*)run: [|>][-+]?\s*$/.exec(text);
    const single = /^\s*run: (?![|>])(.+)$/.exec(text);
    if (single) scripts.push({ line: index + 1, script: single[1] });
    if (!block) return;
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next];
      if (candidate.trim() !== "" && candidate.length - candidate.trimStart().length <= block[1].length) break;
      body.push(candidate);
    }
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    scripts.push({ line: index + 1, script: body.map((l) => l.slice(indent)).join("\n").trimEnd() + "\n" });
  });
  return scripts;
}

/** The `run:` script of one named step of the bootstrap workflow. */
function stepScript(name: string): string {
  const lines = read(BOOTSTRAP).split("\n");
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`step not found: ${name}`);
  const runLine = lines.findIndex((l, i) => i > at && /^\s*run: \|\s*$/.test(l));
  return runScripts(BOOTSTRAP).find((s) => s.line === runLine + 1)!.script;
}

// bash: the CI runner's, or Git for Windows locally. The behavioural tests need one.
const BASH = process.platform === "win32"
  ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => existsSync(p))
  : "bash";

// Test-only connection strings: they only satisfy the posture checks of the step; nothing connects to them.
const POSTURE = {
  DATABASE_URL: "postgresql://app_user:test-only@ep-test-pooler.example.invalid/db",
  DATABASE_MIGRATION_URL: "postgresql://neondb_owner:test-only@ep-test.example.invalid/db",
};

let workdir: string | undefined;
afterEach(() => { if (workdir) rmSync(workdir, { recursive: true, force: true }); workdir = undefined; });
function sandbox() {
  workdir = mkdtempSync(join(tmpdir(), "luxia-injection-"));
  const marker = join(workdir, "pwned").replace(/\\/g, "/");
  return { marker };
}
/** Hostile values, each trying to create the marker file if it were ever executed. */
const payloads = (marker: string) => [
  `"`,
  `x"; touch "${marker}"; echo "`,
  `$(touch "${marker}")`,
  `\`touch "${marker}"\``,
  `; touch "${marker}"`,
  `x" ] || touch "${marker}" || [ "`,
  `APPLY_CANONICAL_IDENTITY_BOOTSTRAP_PRODUCTION"; touch "${marker}"; echo "`,
];
function runStep(script: string, env: Record<string, string>) {
  return spawnSync(BASH!, ["-c", script], { env: { ...process.env, ...POSTURE, ...env }, encoding: "utf8" });
}

describe("Production workflow inputs never reach a shell by expression interpolation", () => {
  it("no run script of a Production workflow interpolates inputs or event data", () => {
    for (const path of PRODUCTION_WORKFLOWS) {
      const scripts = runScripts(path);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const { line, script } of scripts) {
        expect(script, `${path}:${line}`).not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
      }
    }
  });

  it("the bootstrap steps bind mode and confirmation through env", () => {
    const source = read(BOOTSTRAP);
    expect(source).toContain("BOOTSTRAP_MODE: ${{ inputs.mode }}");
    expect(source).toContain("BOOTSTRAP_CONFIRMATION: ${{ inputs.confirmation }}");
    expect(stepScript("Validate connection posture and requested mode")).toContain(`if [ "$BOOTSTRAP_MODE" = "apply" ]; then`);
    expect(stepScript("Validate connection posture and requested mode")).toContain(`test "$BOOTSTRAP_CONFIRMATION" = "APPLY_CANONICAL_IDENTITY_BOOTSTRAP_PRODUCTION"`);
    expect(stepScript("Evidence summary")).toContain(`echo "Mode: $BOOTSTRAP_MODE"`);
  });

  it("the mode allowlist comes first, and the evidence summary runs only after the earlier steps succeeded", () => {
    const validate = stepScript("Validate connection posture and requested mode");
    const allowlist = validate.indexOf(`case "$BOOTSTRAP_MODE" in`);
    expect(allowlist).toBeGreaterThan(0);
    expect(validate).toMatch(/^\s*preflight\|apply\) ;;$/m);
    expect(validate).toContain(`echo "Unsupported bootstrap mode"`);
    expect(allowlist).toBeLessThan(validate.indexOf(`test -n "$DATABASE_URL"`));
    // No `if:` on the summary step: GitHub runs it only when every earlier step succeeded (success() by default).
    const lines = read(BOOTSTRAP).split("\n");
    const at = lines.findIndex((l) => l.trim() === "- name: Evidence summary");
    const stepEnd = lines.findIndex((l, i) => i > at && /^\s*- name: /.test(l));
    const summaryStep = lines.slice(at, stepEnd < 0 ? undefined : stepEnd).join("\n");
    expect(summaryStep).not.toMatch(/^\s*if:/m);
  });

  describe.runIf(Boolean(BASH))("the real step scripts, run with hostile payloads", () => {
    it("apply with a hostile confirmation: refused, and nothing executed", () => {
      const script = stepScript("Validate connection posture and requested mode");
      const { marker } = sandbox();
      for (const payload of payloads(marker)) {
        const result = runStep(script, { BOOTSTRAP_MODE: "apply", BOOTSTRAP_CONFIRMATION: payload });
        expect(result.status, payload).not.toBe(0);
        expect(result.stdout, payload).toContain("Apply confirmation phrase missing");
        expect(existsSync(marker), payload).toBe(false);
      }
    });

    it("an unknown or hostile mode is refused first, never echoed, and executes nothing", () => {
      const validate = stepScript("Validate connection posture and requested mode");
      const { marker } = sandbox();
      const modes = [
        ...payloads(marker).map((payload) => `apply${payload}`),
        "", "APPLY", " apply", "apply ", "preflight\napply",
        // Newlines and strings shaped like GitHub Actions workflow commands, which a runner would act on if echoed.
        "preflight\n::error::injected", "apply\n::add-mask::secret", "x\n::set-output name=mode::apply", "::stop-commands::token",
      ];
      for (const mode of modes) {
        // No posture variables at all: the refusal must come from the allowlist, before any other check.
        const result = spawnSync(BASH!, ["-c", validate], { env: { ...process.env, DATABASE_URL: "", DATABASE_MIGRATION_URL: "",
          BOOTSTRAP_MODE: mode, BOOTSTRAP_CONFIRMATION: "APPLY_CANONICAL_IDENTITY_BOOTSTRAP_PRODUCTION" }, encoding: "utf8" });
        expect(result.status, JSON.stringify(mode)).toBe(1);
        expect(result.stdout.trim(), JSON.stringify(mode)).toBe("Unsupported bootstrap mode");
        if (mode.trim()) expect(result.stdout + result.stderr, JSON.stringify(mode)).not.toContain(mode.trim());
        expect(existsSync(marker), JSON.stringify(mode)).toBe(false);
      }
    });

    it("defence in depth: even if reached, the evidence summary would print a value literally and execute nothing", () => {
      const summary = stepScript("Evidence summary");
      const { marker } = sandbox();
      for (const payload of payloads(marker)) {
        const printed = runStep(summary, { BOOTSTRAP_MODE: payload, GITHUB_SHA: "0".repeat(40) });
        expect(printed.status, payload).toBe(0);
        expect(printed.stdout, payload).toContain(`Mode: ${payload}`);
        expect(existsSync(marker), payload).toBe(false);
      }
    });

    it("unchanged behaviour: the exact phrase is accepted for apply; preflight needs none", () => {
      const script = stepScript("Validate connection posture and requested mode");
      expect(runStep(script, { BOOTSTRAP_MODE: "apply", BOOTSTRAP_CONFIRMATION: "APPLY_CANONICAL_IDENTITY_BOOTSTRAP_PRODUCTION" }).status).toBe(0);
      expect(runStep(script, { BOOTSTRAP_MODE: "apply", BOOTSTRAP_CONFIRMATION: "" }).status).not.toBe(0);
      expect(runStep(script, { BOOTSTRAP_MODE: "preflight", BOOTSTRAP_CONFIRMATION: "" }).status).toBe(0);
    });

    it("control: under the old interpolated form, the same payloads do execute (the test can fail)", () => {
      const script = stepScript("Validate connection posture and requested mode");
      const { marker } = sandbox();
      // What GitHub did before the fix: the value pasted into the script text before bash parses it.
      const interpolated = (confirmation: string) => script
        .replaceAll(`"$BOOTSTRAP_MODE"`, `"apply"`)
        .replace(`"$BOOTSTRAP_CONFIRMATION"`, `"${confirmation}"`);
      const executed = payloads(marker).filter((payload) => {
        rmSync(marker, { force: true });
        runStep(interpolated(payload), {});
        return existsSync(marker);
      });
      expect(executed.length).toBeGreaterThan(0);
    });
  });
});
