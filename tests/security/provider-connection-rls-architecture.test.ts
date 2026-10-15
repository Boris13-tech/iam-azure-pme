import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sovereign providers F2, M2 (forced row-level security on ProviderConnection, PRODUCTION VERIFIED 2026-10-15).
// Outside an organization's scope the runtime role sees no connection at all, so any read of a connection through a
// client that has not set app.organization_id silently finds nothing: a relation becomes null (Prisma then fails on a
// required relation), a filter matches no row, a raw query returns zero rows. The lifecycle architecture test forbids
// the direct `rawPrisma.providerConnection`; this one also forbids the indirect paths.
const UNSCOPED_CLIENTS = ["rawPrisma", "prisma"]; // lib/db/raw-prisma.ts and lib/prisma.ts: app_user, no context
const SCOPE_FILE = join("lib", "db", "scoped-client.ts"); // withTenantDb itself: it sets the context first
const RELATION = /\bproviderConnection\b/;   // a relation name, not providerConnectionId or providerConnectionTenantScope
const TABLE = /"ProviderConnection"/;
const SETS_SCOPE = /set_config\(\s*'app\.organization_id'/;

/** The text between the parenthesis at `open` and its matching one, skipping string and template contents. */
function callArguments(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Every unscoped read that reaches a connection, as "<client>.<call>" labels. */
function unscopedConnectionReads(text: string): string[] {
  const found: string[] = [];
  for (const client of UNSCOPED_CLIENTS) {
    const call = new RegExp(`\\b${client}\\s*\\.\\s*(\\$?\\w+)(?:\\s*\\.\\s*(\\w+))?\\s*(?:<[^()\`]*?>)?\\s*\\(`, "g");
    for (const match of text.matchAll(call)) {
      const [whole, first, second] = match;
      const args = callArguments(text, match.index! + whole.length - 1);
      // Raw SQL: matched as `$queryRaw(`; the tagged-template form is handled below.
      if (/^\$(query|execute)Raw(Unsafe)?$/.test(first)) { if (TABLE.test(args)) found.push(`${client}.${first}`); continue; }
      if (first === "$transaction") {
        if ((RELATION.test(args) || TABLE.test(args)) && !SETS_SCOPE.test(args)) found.push(`${client}.$transaction`);
        continue;
      }
      if (second && RELATION.test(args)) found.push(`${client}.${first}.${second}`);
    }
    const tagged = new RegExp(`\\b${client}\\s*\\.\\s*\\$(query|execute)Raw(Unsafe)?\\s*(?:<[^\`]*?>)?\\s*\`([^\`]*)\``, "g");
    for (const match of text.matchAll(tagged)) if (TABLE.test(match[3])) found.push(`${client}.$${match[1]}Raw`);
  }
  return found;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("ProviderConnection under forced row-level security: no unscoped read, direct or indirect", () => {
  it("the detector catches every unscoped path and accepts the scoped ones", () => {
    const flagged = (code: string) => unscopedConnectionReads(code);
    // Unscoped: a relation in include, select or where; raw SQL; a transaction that never sets the scope.
    expect(flagged(`rawPrisma.session.findUnique({ where: { id }, include: { identityAccount: { include: { providerConnection: true } } } })`))
      .toEqual(["rawPrisma.session.findUnique"]);
    expect(flagged(`await rawPrisma.localIdentity.findFirst({ where: { identityAccount: { providerConnection: { providerType: "LUXIA_LOCAL" } } } })`))
      .toEqual(["rawPrisma.localIdentity.findFirst"]);
    expect(flagged(`prisma.identityAccount.findMany({ select: { providerConnection: { select: { name: true } } } })`)).toEqual(["prisma.identityAccount.findMany"]);
    expect(flagged("rawPrisma.$queryRaw`SELECT id FROM \"ProviderConnection\" WHERE id = ${id}`")).toEqual(["rawPrisma.$queryRaw"]);
    expect(flagged("rawPrisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM \"ProviderConnection\"`")).toEqual(["rawPrisma.$queryRaw"]);
    expect(flagged(`rawPrisma.$queryRawUnsafe('SELECT * FROM "ProviderConnection"')`)).toEqual(["rawPrisma.$queryRawUnsafe"]);
    expect(flagged(`rawPrisma.$transaction(async (tx) => tx.identityAccount.findFirst({ include: { providerConnection: true } }))`))
      .toEqual(["rawPrisma.$transaction"]);
    // Scoped or unrelated: accepted.
    expect(flagged(`rawPrisma.$transaction(async (tx) => { await tx.$queryRaw\`SELECT set_config('app.organization_id', \${o}, true)\`;
      return tx.providerConnection.create({ data }); })`)).toEqual([]);
    expect(flagged(`withTenantDb(scope, (tx) => tx.identityAccount.findFirst({ include: { providerConnection: true } }))`)).toEqual([]);
    expect(flagged(`rawPrisma.authTransaction.create({ data: { expectedProviderConnectionId: id } })`)).toEqual([]);
    expect(flagged(`rawPrisma.identityAccount.findUnique({ where: { organizationId_providerConnectionId_externalObjectId: k } })`)).toEqual([]);
    expect(flagged("rawPrisma.$queryRaw`SELECT * FROM luxia_session_resolve(${token})`")).toEqual([]);
  });

  it("the application (app/, lib/) never reads a connection, or through a connection relation, outside a tenant scope", () => {
    const violations = [...files("app"), ...files("lib")]
      .filter((file) => file !== SCOPE_FILE)
      .flatMap((file) => unscopedConnectionReads(readFileSync(file, "utf8")).map((call) => `${file}: ${call}`));
    expect(violations).toEqual([]);
  });
});
