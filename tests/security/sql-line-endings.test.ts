import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Prisma records the checksum of each migration file when it applies it. A Windows checkout that turned LF into CRLF
// would present different bytes for an applied migration. Every SQL file is therefore stored and checked out as LF.
const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });
const inCheckout = git("rev-parse", "--is-inside-work-tree").stdout.trim() === "true";

describe.runIf(inCheckout || process.env.CI)("SQL line endings", () => {
  it("every SQL file is text with LF line endings, in the repository and on checkout", () => {
    const listed = git("ls-files", "--eol", "--", "*.sql").stdout.trim().split("\n").filter(Boolean);
    expect(listed.length).toBeGreaterThan(40);
    for (const line of listed) {
      // Format: "i/<index eol> w/<worktree eol> attr/<attributes>\t<path>"; the attributes may hold spaces.
      const [index, , ...attribute] = line.split("\t")[0].trim().split(/\s+/);
      const attributes = attribute.join(" ");
      expect(index, line).toBe("i/lf");
      expect(attributes, line).toBe("attr/text eol=lf");
    }
  });

  it("the rule also covers a SQL file that does not exist yet", () => {
    const attributes = git("check-attr", "text", "eol", "--", "prisma/migrations/29991231000000_future/migration.sql").stdout;
    expect(attributes).toContain("text: set");
    expect(attributes).toContain("eol: lf");
  });
});
