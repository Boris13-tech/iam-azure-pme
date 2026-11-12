import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every operator command that records the version of the tool it ran must take it from tool-version.ts: the commit of
// the sources this process loaded, proven byte for byte against a clean checkout, without inherited GIT_* variables.
// The behaviour of that function (modified, staged, untracked or filtered files, another checkout, replaced objects,
// GIT_* variables, preloaded modules) is tested in break-glass.test.ts. Codex, consolidated review of the Release
// Candidate: the erasure command recorded the working directory's HEAD, whatever code ran.
const folder = "scripts/operators";
const all = readdirSync(folder).filter((name) => /\.(ts|js|cjs|mjs)$/.test(name) && name !== "tool-version.ts")
  .map((name) => ({ name, source: readFileSync(join(folder, name), "utf8").replace(/\r\n/g, "\n") }));
const commands = all.filter(({ source }) => /toolVersion/.test(source));

// Every file of the folder is classified, so a new operator command cannot escape this test by recording no version
// (Antigravity, review of #188). The plan-and-apply commands that change Production record the version; the others
// say here why they do not.
const VERSIONED = ["break-glass.ts", "organization-erasure.ts", "signup-codes.ts"];
const NOT_VERSIONED: Record<string, string> = {
  "archive-certification-clone.cjs": "archives a certification clone; no Production write",
  "browser-evidence.ts": "transport of browser evidence only; no session, grant or Production write",
  "production-bootstrap-registry.ts": "data module (reviewed registrations), not a command",
  "production-resource-preflight.ts": "read-only inspection",
  "resource-owner-bootstrap.ts": "library of the one-time resource bootstrap, not a command",
  "run-production-resource-bootstrap.ts": "one-time historical bootstrap (PRODUCTION VERIFIED); repository follow-up: record its version before any reuse",
};

describe("operator commands record the version of the code they ran", () => {
  it("every file of scripts/operators is classified: versioned, or not with a reason (a new file must be added here)", () => {
    expect(all.map(({ name }) => name).sort()).toEqual([...VERSIONED, ...Object.keys(NOT_VERSIONED)].sort());
    expect(commands.map(({ name }) => name).sort()).toEqual(VERSIONED);
    for (const name of Object.keys(NOT_VERSIONED)) expect(VERSIONED, name).not.toContain(name);
  });

  for (const { name, source } of commands) {
    it(`${name}: the version comes from tool-version.ts, over the sources actually loaded`, () => {
      expect(source).toMatch(/import \{[^}]*\bloadedSources\b[^}]*\} from "\.\/tool-version";/);
      expect(source).toMatch(/\b(sourceVersion|toolVersion)\(loadedSources\(\)\)/);
    });

    it(`${name}: no git command of its own, and no child process at all`, () => {
      expect(source).not.toMatch(/node:child_process|\bexecSync\b|\bexecFileSync\b|\bspawnSync\b|rev-parse/);
    });
  }

  it("erasure and sign-up codes call it at plan time and at apply time", () => {
    for (const name of ["organization-erasure.ts", "signup-codes.ts"]) {
      const { source } = commands.find((command) => command.name === name)!;
      expect(source.match(/toolVersion\(\)/g)?.length, name).toBe(3); // its definition, then the plan and the apply calls
      expect(source, name).toMatch(/function toolVersion\(\): string \{\n\s+return sourceVersion\(loadedSources\(\)\);\n\}/);
    }
  });
});
