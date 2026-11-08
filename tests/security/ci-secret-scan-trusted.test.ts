import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The secret scan a pull request cannot switch off (review follow-up of #101): pull_request_target runs the base
// branch's definition, so editing, disabling ("if: false") or deleting the job in a pull request changes nothing for
// that pull request's own scan. The job reads the change as data only, with a read-only token and no secret.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const wf = read(".github/workflows/secret-scan-trusted.yml");
const ci = read(".github/workflows/ci.yml");
const script = wf.slice(wf.indexOf("      run: |\n"));

describe("trusted secret scan (base-branch definition)", () => {
  it("runs from the base branch's definition on every pull request to main, and on main itself; no other trigger", () => {
    expect(wf).toMatch(/\non:\n {2}pull_request_target:\n {4}branches: \[main\]\n {2}push:\n {4}branches: \[main\]\n\n/);
    expect(wf).not.toMatch(/\n {2}(pull_request|workflow_dispatch|workflow_run|workflow_call|schedule|issue_comment):/);
    expect(wf).not.toMatch(/\n {4}if:/); // nothing can skip the job
  });

  it("holds a read-only token and no secret, and never keeps credentials", () => {
    expect(wf).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(wf).toMatch(/\n {4}permissions:\n {6}contents: read\n {4}steps:/);
    expect(wf).not.toMatch(/secrets\.|GITHUB_TOKEN|github\.token|write/);
    expect(wf.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(wf.match(/uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/g)).toHaveLength(2);
    expect(wf.match(/uses: /g)).toHaveLength(2); // no other action
  });

  it("checks the change out as data and never executes anything from it", () => {
    expect(wf).toContain("path: scanned");
    expect(wf).toContain("ref: ${{ github.event.pull_request.head.sha || github.sha }}");
    expect(script).not.toContain("${{");
    expect(script).not.toMatch(/\b(npm|npx|node|pnpm|yarn|make|python|sh|bash|source)\b\s/);
    // The only uses of the checked-out change: its ignore file is compared (never used), and it is the scan target.
    const uses = script.match(/scanned[^\s"]*/g) ?? [];
    expect([...new Set(uses)].sort()).toEqual(["scanned", "scanned/.gitleaksignore"]);
    expect(script).toContain('scan scanned "$RUNNER_TEMP/gitleaks.json" "$trusted"');
  });

  it("uses the base branch's ignore file and config outside the checkout, never the change's", () => {
    expect(script).toContain('if [ -f trusted/.gitleaksignore ]; then cp trusted/.gitleaksignore "$trusted"; else : > "$trusted"; fi');
    expect(script).toContain(`scan() { cp "$3" "$1/.gitleaksignore"; "$RUNNER_TEMP/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --gitleaks-ignore-path "$3" --ignore-gitleaks-allow`);
    expect(script).not.toMatch(/cp scanned\/\.gitleaksignore/);
  });

  it("runs the same pinned release, checked before extraction, and the same canary as the CI job", () => {
    for (const line of ["GITLEAKS_VERSION: 8.30.1", "GITLEAKS_SHA256: 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"]) {
      expect(wf, line).toContain(line);
      expect(ci, line).toContain(line);
    }
    expect(script.indexOf("sha256sum -c -")).toBeGreaterThan(0);
    expect(script.indexOf("sha256sum -c -")).toBeLessThan(script.indexOf("tar -xzf"));
    expect(script).toContain(`scan "$canary" "$RUNNER_TEMP/canary.json" "$RUNNER_TEMP/empty.gitleaksignore"`);
    expect(script).toMatch(/if \[ "\$count" != "0" \]; then[\s\S]*exit 1/);
    expect(script).toContain("set -euo pipefail");
  });
});
