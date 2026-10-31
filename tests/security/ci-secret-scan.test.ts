import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// P6 compensating control: the CI secret scan runs an official gitleaks release, pinned by version and SHA-256,
// verified before it runs, over the whole history, and never prints matched content in the public log.
const ci = readFileSync(".github/workflows/ci.yml", "utf8").replace(/\r\n/g, "\n");
const start = ci.indexOf("\n  secret-scan:\n");
const job = ci.slice(start, ci.indexOf("\n  test-and-build:\n"));

describe("CI secret scan (gitleaks)", () => {
  it("exists, with read-only permissions and a SHA-pinned checkout of the whole history", () => {
    expect(start).toBeGreaterThan(0);
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n/);
    expect(job).toContain("uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(job).toContain("fetch-depth: 0");
    expect(job).toContain("persist-credentials: false");
  });

  it("downloads the official release only, pinned by version and digest, and checks the digest before extraction", () => {
    expect(job).toMatch(/GITLEAKS_VERSION: 8\.30\.1\n/);
    expect(job).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}\n/);
    expect(job).toContain(`"https://github.com/gitleaks/gitleaks/releases/download/v\${GITLEAKS_VERSION}/\${archive}"`);
    const check = job.indexOf("sha256sum -c -");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(job.indexOf("tar -xzf"));
    expect(job.indexOf("tar -xzf")).toBeLessThan(job.indexOf(`"$RUNNER_TEMP/gitleaks" git`));
  });

  it("redacts, and prints only counts, rules, files and commits; any finding fails the job", () => {
    expect(job).toContain("--redact");
    expect(job).not.toMatch(/--verbose|-v\b/);
    expect(job).toContain(`jq -r '.[] | "\\(.RuleID) \\(.File) \\(.Commit[0:7])"'`);
    expect(job).not.toMatch(/\.(Secret|Match|Line)\b/);
    expect(job).toMatch(/if \[ "\$count" != "0" \]; then[\s\S]*exit 1/);
  });

  it("a pull request cannot silence the scan from inside, and every run proves it on a canary", () => {
    expect(job).toContain(`--config "$RUNNER_TEMP/gitleaks.toml"`);
    expect(job).toContain("--ignore-gitleaks-allow");
    expect(job).toContain("# gitleaks:allow");
    expect(job).toContain(`"$canary/.gitleaks.toml"`);
    const canary = job.indexOf(`scan "$canary"`);
    expect(canary).toBeGreaterThan(0);
    expect(canary).toBeLessThan(job.indexOf(`scan . "$RUNNER_TEMP/gitleaks.json"`));
    expect(job).toMatch(/\[ "\$\(jq 'length' "\$RUNNER_TEMP\/canary\.json"\)" = "0" \]; then[\s\S]*?exit 1/);
  });

  it("a failed check stops the job, and a report only ever reaches jq", () => {
    expect(job).toContain("set -euo pipefail");
    expect(job).toMatch(/\| sha256sum -c -\n/);
    expect(job).not.toContain("|| true");
    for (const line of job.split("\n").filter((l) => /\.json/.test(l) && !l.includes("uses:")))
      expect(line, line).toMatch(/\bjq\b|scan (\.|"\$canary") "\$RUNNER_TEMP/);
  });

  it("the ignore file holds reviewed fingerprints only, each with its reason", () => {
    const lines = readFileSync(".gitleaksignore", "utf8").replace(/\r\n/g, "\n").split("\n").filter(Boolean);
    const entries = lines.filter((l) => !l.startsWith("#"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry).toMatch(/^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$/);
    expect(lines.filter((l) => l.startsWith("#")).length).toBeGreaterThan(entries.length);
  });
});
