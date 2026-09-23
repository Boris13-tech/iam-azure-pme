import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
function files(root: string): string[] { return readdirSync(root).flatMap((name) => { const path = join(root, name); return statSync(path).isDirectory() ? files(path) : [path]; }); }
describe("Phase 6H architecture boundaries", () => {
  it("confines directory protocol vocabulary to adapter implementations", () => {
    const outside = [...files("lib/auth"), ...files("lib/identity")].filter((path) => path.endsWith(".ts"));
    const source = outside.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(/ldapjs|ldap:\/\/|ldaps:\/\/|sAMAccountName|objectGUID|entryUUID/i);
  });
  it("keeps provider-specific fields out of Subject and makes the migration additive", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8"); const subject = schema.slice(schema.indexOf("model Subject {"), schema.indexOf("model IdentityAccount {"));
    expect(subject).not.toMatch(/ldap|activeDirectory|samba|objectGUID|distinguishedName/i);
    const migration = readFileSync("prisma/migrations/20260923040000_phase6h_enterprise_directory_provider_types/migration.sql", "utf8");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/i); expect(migration).toContain("FORCE ROW LEVEL SECURITY");
  });
});
