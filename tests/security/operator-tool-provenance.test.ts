import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every operator command that records the version of the tool it ran must take it from tool-version.ts: the commit of
// the sources this process loaded, proven byte for byte against a clean checkout, without inherited GIT_* variables.
// The behaviour of that function (modified, staged, untracked or filtered files, another checkout, replaced objects,
// GIT_* variables, preloaded modules) is tested in break-glass.test.ts. Codex, consolidated review of the Release
// Candidate: the erasure command recorded the working directory's HEAD, whatever code ran.
const folder = "scripts/operators";
const commands = readdirSync(folder).filter((name) => name.endsWith(".ts") && name !== "tool-version.ts")
  .map((name) => ({ name, source: readFileSync(join(folder, name), "utf8").replace(/\r\n/g, "\n") }))
  .filter(({ source }) => /toolVersion/.test(source));

describe("operator commands record the version of the code they ran", () => {
  it("the commands that record a tool version are the three known ones (a new one must be added here)", () => {
    expect(commands.map(({ name }) => name).sort()).toEqual(["break-glass.ts", "organization-erasure.ts", "signup-codes.ts"]);
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
