import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
function files(root: string): string[] { return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? files(path) : [path]; }); }
describe("Phase 6I architecture boundaries", () => {
  it("confines cloud SDK and provider vocabulary to adapter implementations", () => {
    const source = [...files("lib/auth"), ...files("lib/identity")].filter((path) => path.endsWith(".ts")).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(/googleapis|@aws-sdk|@octokit|github.*authorization|amazon resource name|arn:aws/i);
  });
  it("uses existing additive provider types and keeps cloud fields out of Subject", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8"); const subject = schema.slice(schema.indexOf("model Subject {"), schema.indexOf("model IdentityAccount {"));
    expect(subject).not.toMatch(/google|github|aws|arn|accountId|organizationId.*github/i);
    for (const providerType of ["GOOGLE_WORKSPACE", "AWS", "GITHUB"]) expect(schema).toContain(providerType);
  });
});
