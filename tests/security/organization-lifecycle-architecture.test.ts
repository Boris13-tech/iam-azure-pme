import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// First Admin / Break-glass v1, B3: organization lifecycle enforcement, static checks.
const root = join(__dirname, "../..");
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const runtime = ["lib", "app"].flatMap((dir) => sources(join(root, dir)))
  .map((path) => ({ file: relative(root, path).replace(/\\/g, "/"), source: readFileSync(path, "utf8").replace(/\r\n/g, "\n") }));
const read = (file: string) => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
/** Body of a function or static method, up to the next top-level export or method. */
function body(source: string, name: string) {
  const start = source.search(new RegExp(`(function|static async) ${name}\\(`));
  if (start < 0) throw new Error(`missing ${name}`);
  const ends = ["\nexport ", "\n  static ", "\n  /**"].map((marker) => source.indexOf(marker, start + 1)).filter((i) => i > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}
const sqlFunction = (sql: string, name: string) => {
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION ${name}\\(`));
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2);
};

// Writers that create a session, an invitation or a domain, or start, accept or verify one.
const CREATES = /\.(session|invitation|organizationDomain)\.(create|createMany|update|upsert)\(|\.invitation\.updateMany\(|INSERT INTO "(Session|Invitation|OrganizationDomain)"/;
const LOCKED: Record<string, string[]> = {
  "lib/auth/session-store.ts": ["createSession"],
  "lib/onboarding/invitations.ts": ["createInvitation", "beginAcceptance", "completeAcceptance"],
  "lib/onboarding/domains.ts": ["addDomain", "checkDomain"],
  // B2: recovery sign-in creates a RECOVERY session; recovery enrolment ends it (the other B2 writers
  // are checked in recovery-architecture.test.ts).
  "lib/auth/recovery.ts": ["recoverySignIn", "completeRecoveryEnrollment"],
  // B4: the operator's emergency administrator invitation (D3) requires an ACTIVE organization.
  "lib/operators/break-glass.ts": ["issueRecoveryInvitation"],
};

describe("B3 organization lifecycle enforcement architecture", () => {
  it("lock order: governance lock first, then the organization status lock, then the first write", () => {
    for (const [file, names] of Object.entries(LOCKED)) {
      const source = read(file);
      for (const name of names) {
        const fn = body(source, name);
        const organization = fn.indexOf("lockOrganizationActive(tx");
        const firstWrite = fn.search(/\.(session|invitation|organizationDomain)\.(create|update|updateMany|upsert)\(/);
        const governance = fn.indexOf("lockTenantGovernance(tx");
        expect(organization, `${file} ${name}`).toBeGreaterThan(-1);
        expect(organization, `${file} ${name}`).toBeLessThan(firstWrite);
        if (governance > -1) expect(governance, `${file} ${name}`).toBeLessThan(organization);
      }
    }
  });

  it("every writer that creates, starts, accepts or verifies is listed: a new one fails until reviewed", () => {
    const writers = runtime.filter(({ source }) => CREATES.test(source)).map(({ file }) => file).sort();
    expect(writers).toEqual(Object.keys(LOCKED).sort());
    for (const { file, source } of runtime) {
      // Revocations are conditional everywhere: never a plain update of a session by id.
      expect(source, file).not.toMatch(/\.session\.update\(/);
      // Raw SQL writes on these tables only in the transition primitive (revocations and releases).
      if (file !== "lib/organizations/lifecycle.ts") expect(source, file).not.toMatch(/UPDATE "(Session|Invitation|OrganizationDomain)"/);
    }
  });

  it("before authentication, SUSPENDED and CLOSED look exactly like an unknown organization", () => {
    expect(body(read("lib/auth/organization-login.ts"), "resolveLoginOrganization")).toContain(`if (!organization || organization.status !== "ACTIVE") return null;`);
    const invitations = read("lib/onboarding/invitations.ts");
    for (const name of ["beginAcceptance", "completeAcceptance"])
      expect(body(invitations, name)).toMatch(/lockOrganizationActive\(tx, scope\.organizationId\)\) throw new InvitationError\("INVITATION_INVALID", 403\)/);
    expect(read("app/auth/callback/route.ts")).toContain(`if (error.reason === "ORGANIZATION_NOT_ACTIVE") return NextResponse.redirect(new URL("/login?error=signin", request.url), 303);`);
    const sessions = read("lib/auth/session-store.ts");
    expect(body(sessions, "createSession")).toContain(`throw new SessionCreationDeniedError("ORGANIZATION_NOT_ACTIVE")`);
    expect(read("app/api/auth/local/complete/route.ts")).toMatch(/if \(error instanceof SessionCreationDeniedError\) return failure\(\);/);
  });

  it("sessions resolve only through the canonical resolver, FULL only, with conditional refresh and sign-out", () => {
    const sessions = read("lib/auth/session-store.ts");
    const get = body(sessions, "getSession");
    expect(get).toContain("luxia_session_resolve(");
    expect(get).toContain(`session.scope !== "FULL"`);
    expect(body(sessions, "touch")).toContain("updateMany({\n      where: { id: hashedToken, revokedAt: null }");
    const signOut = body(sessions, "revokeByToken");
    expect(signOut).toContain("luxia_session_resolve(");
    expect(signOut).toContain("updateMany({ where: { id: hashedToken, revokedAt: null }");
    expect(signOut).toContain("revoked === 1");
    for (const { file, source } of runtime) expect(source, file).not.toMatch(/FROM resolve_session\(/);
  });

  it("the transition primitive is operator-only and applies its effects in the same transaction", () => {
    const lifecycle = read("lib/organizations/lifecycle.ts");
    const transition = body(lifecycle, "transitionOrganization");
    expect(transition.indexOf("lockTenantGovernance(tx")).toBeLessThan(transition.indexOf(`UPDATE "Organization"`));
    expect(transition.indexOf(`UPDATE "Organization"`)).toBeLessThan(transition.indexOf(`UPDATE "Session"`));
    expect(transition).toContain(`if (to !== "ACTIVE")`); // reactivation revokes nothing and resurrects nothing
    expect(transition.trimEnd().indexOf("SET CONSTRAINTS ALL IMMEDIATE")).toBeGreaterThan(transition.indexOf(`UPDATE "OrganizationDomain"`));
    // B4 wraps it: the operator break-glass procedure is the only caller (and it is not a route).
    const importers = runtime.filter(({ file, source }) => file !== "lib/organizations/lifecycle.ts" && /transitionOrganization/.test(source));
    expect(importers.map(({ file }) => file)).toEqual(["lib/operators/break-glass.ts"]);
  });

  it("the B3 migration only extends the canonical resolver, and its rollback restores the previous body", () => {
    const b3 = read("prisma/migrations/20261011200000_session_resolve_subject_account/migration.sql");
    const previous = sqlFunction(read("prisma/migrations/20261011180000_organization_status_session_scope/migration.sql"), "luxia_session_resolve");
    const extended = sqlFunction(b3, "luxia_session_resolve");
    const returns = (definition: string) => definition.slice(definition.indexOf("RETURNS"), definition.indexOf("LANGUAGE")).replace(/\s+/g, " ");
    expect(returns(extended)).toBe(returns(previous));
    expect(extended).toContain(`su."lifecycleState" = 'ACTIVE' AND ia."status" = 'ACTIVE'`);
    expect(extended).toContain(`o."status" = 'ACTIVE'`);
    expect(b3).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP |GRANT /);
    const rollback = sqlFunction(read("docs/operations/B3-SESSION-RESOLVE-ROLLBACK.sql"), "luxia_session_resolve");
    expect(rollback.replace("CREATE OR REPLACE", "CREATE")).toBe(previous);
  });
});
