// scripts/ops/verify-release.sh decides which commit a Production operation may use. It runs here against a fake `gh`
// (no network): each case sets what GitHub would answer, and the script must accept exactly one commit, or refuse.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RC = "162c60216c2c1fd445dfb858caad5dbfb67928e1";
const TAG_OBJECT = "c3998cc0000000000000000000000000000000aa";
const MAIN = "21d4add1b7db3159d0c7cbbe1125eaa2f972897b";
const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
const calls = join(dir, "calls.log");
// The fake answers by endpoint, from variables the case sets; "FAIL" (or nothing) is an API error.
writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
echo "$*" >> "${calls.replace(/\\/g, "/")}"
answer() { if [ -z "\${1:-}" ] || [ "$1" = FAIL ]; then echo "gh: HTTP 404" >&2; exit 1; fi; printf '%s\\n' "$1"; }
case "$2" in
  */git/ref/tags/*) answer "\${FAKE_REF:-}" ;;
  */git/tags/*) answer "\${FAKE_TAG_OBJECT:-}" ;;
  */compare/*) answer "\${FAKE_COMPARE:-}" ;;
  */actions/workflows/ci.yml/runs*) answer "\${FAKE_RUN:-}" ;;
  *) echo "unexpected endpoint $2" >&2; exit 2 ;;
esac
`);
chmodSync(join(dir, "gh"), 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GOOD = { FAKE_REF: `tag ${TAG_OBJECT}`, FAKE_TAG_OBJECT: `commit ${RC}`, FAKE_COMPARE: "ahead", FAKE_RUN: `43180572521 ${RC} success https://ci/43180572521` };
function verify(release: string, sha: string, answers: Record<string, string> = GOOD) {
  writeFileSync(calls, "");
  const result = spawnSync("bash", ["scripts/ops/verify-release.sh", release, sha], {
    encoding: "utf8", env: { ...process.env, ...answers, REPO: "owner/repo", PATH: `${dir}${delimiter}${process.env.PATH}` } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, ""), calls: readFileSync(calls, "utf8") };
}

describe("verify-release.sh: the one commit a Production operation may use", () => {
  it("accepts the RC tag (annotated, peeled) on its commit, on main, with a green CI run", () => {
    const { code, out, calls: made } = verify("rc-private-beta-1", RC);
    expect(code).toBe(0);
    expect(out).toBe(`release=rc-private-beta-1\nsha=${RC}\nci_run_id=43180572521\nci_run_url=https://ci/43180572521\n`);
    expect(made).toContain(`repos/owner/repo/compare/${RC}...main`);
    expect(made).toContain(`head_sha=${RC}&branch=main&event=push&status=completed&per_page=1`);
  });

  it("accepts a lightweight tag and a release given as the commit itself", () => {
    expect(verify("v1", RC, { ...GOOD, FAKE_REF: `commit ${RC}` }).code).toBe(0);
    expect(verify(RC, RC).code).toBe(0);
  });

  it("refuses an incorrect sha: the tag points elsewhere", () => {
    const { code, out } = verify("rc-private-beta-1", MAIN);
    expect(code).toBe(1);
    expect(out).toContain(`REFUSED: tag rc-private-beta-1 points to ${RC}, not to the authorized sha ${MAIN}`);
  });

  it("refuses a moved tag: the same name now resolves to another commit", () => {
    const { code, out } = verify("rc-private-beta-1", RC, { ...GOOD, FAKE_TAG_OBJECT: `commit ${MAIN}` });
    expect(code).toBe(1);
    expect(out).toContain("REFUSED: tag rc-private-beta-1 points to");
  });

  it("refuses a different reference: a release SHA that is not the authorized sha", () => {
    expect(verify(MAIN, RC).out).toContain(`REFUSED: release ${MAIN} is not the authorized sha ${RC}`);
  });

  it("refuses a commit that is not on main", () => {
    for (const status of ["behind", "diverged"]) {
      const { code, out } = verify("rc-private-beta-1", RC, { ...GOOD, FAKE_COMPARE: status });
      expect(code, status).toBe(1);
      expect(out, status).toContain(`is not on main (compare: ${status})`);
    }
  });

  it("refuses when CI is absent, failed, or for another commit", () => {
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_RUN: "  none " }).out).toContain("REFUSED: no completed CI run on main");
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_RUN: `1 ${RC} failure https://ci/1` }).out).toContain("is 'failure', not success");
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_RUN: `1 ${MAIN} success https://ci/1` }).out).toContain("REFUSED: no completed CI run on main");
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_RUN: "FAIL" }).out).toContain("REFUSED: the CI runs of");
  });

  it("refuses an unknown tag, a tag that is not a commit, and an unreadable tag object", () => {
    expect(verify("rc-private-beta-9", RC, { ...GOOD, FAKE_REF: "FAIL" }).out).toContain("REFUSED: tag rc-private-beta-9 cannot be read");
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_TAG_OBJECT: "tree abc" }).out).toContain("does not point to a commit");
    expect(verify("rc-private-beta-1", RC, { ...GOOD, FAKE_TAG_OBJECT: "FAIL" }).out).toContain("cannot be read");
  });

  it("refuses malformed input before any call: short or uppercase sha, a path, an option or an expression as release", () => {
    for (const [release, sha] of [["rc-private-beta-1", RC.slice(0, 7)], ["rc-private-beta-1", RC.toUpperCase()], ["rc-private-beta-1", ""],
      ["../heads/main", RC], ["--paginate", RC], ["$(id)", RC], ["", RC], ["a b", RC]]) {
      const { code, out, calls: made } = verify(release, sha);
      expect(code, `${release} ${sha}`).toBe(1);
      expect(out, `${release} ${sha}`).toMatch(/^REFUSED: /);
      expect(made, `${release} ${sha}`).toBe("");
    }
  });
});
