import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthContext } from "../../lib/auth/auth-context";
import type { AuthContext as EngineAuthContext } from "../../lib/auth/authorization-engine";
import type { RecoveryContext } from "../../lib/auth/recovery-session";

// First Admin / Break-glass v1, B2: recovery codes and the recovery-only session, static checks.
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
const users = (pattern: RegExp) => runtime.filter(({ source }) => pattern.test(source)).map(({ file }) => file).sort();
function body(source: string, name: string) {
  const start = source.search(new RegExp(`(function|static async) ${name}\\(`));
  if (start < 0) throw new Error(`missing ${name}`);
  const ends = ["\nexport ", "\n  static ", "\n  /**"].map((marker) => source.indexOf(marker, start + 1)).filter((i) => i > 0);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

// Section 5: exactly these entry points accept a recovery session (sign-out revokes any scope).
const RECOVERY_ENTRY_POINTS = [
  "app/api/auth/recovery/enrollment/begin/route.ts",
  "app/api/auth/recovery/enrollment/complete/route.ts",
  "app/recovery/page.tsx",
];
const PERMISSION = /requireAuth|getAuthContext|checkPermission|requireNative|requireCanonicalAccess|authorization-(engine|gateway)|canonical-administration/;
const WRITE = /\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;

// Type-level separation, checked by tsc (npm run build): a recovery session is never an AuthContext.
export function typeSeparation(recovery: RecoveryContext, auth: AuthContext): [AuthContext, EngineAuthContext, RecoveryContext] {
  // @ts-expect-error a RecoveryContext cannot be used where a signed-in AuthContext is required
  const asAuth: AuthContext = recovery;
  // @ts-expect-error nor where a permission check takes its context
  const asEngine: EngineAuthContext = recovery;
  // @ts-expect-error and an AuthContext cannot pose as a recovery session
  const asRecovery: RecoveryContext = auth;
  return [asAuth, asEngine, asRecovery];
}

describe("B2 recovery architecture", () => {
  it("the recovery session is read only through the allow-list, which checks no permission", () => {
    expect(users(/getRecoverySession\(/)).toEqual(["lib/auth/recovery-session.ts", "lib/auth/session-store.ts"]);
    expect(users(/getRecoveryContext\(/)).toEqual([...RECOVERY_ENTRY_POINTS, "lib/auth/recovery-session.ts"].sort());
    for (const file of RECOVERY_ENTRY_POINTS) expect(read(file), file).not.toMatch(PERMISSION);
    const sessions = read("lib/auth/session-store.ts");
    expect(body(sessions, "getSession")).toContain(`session.scope !== "FULL"`);
    const recovery = body(sessions, "getRecoverySession");
    expect(recovery).toContain("luxia_session_resolve(");
    expect(recovery).toContain(`session.scope !== "RECOVERY"`);
    expect(recovery).not.toMatch(/touch\(/); // nothing extends the 15 minutes
    expect(read("lib/auth/auth-context.ts")).not.toMatch(/getRecovery|RECOVERY/);
  });

  it("only the recovery service writes recovery codes or creates a RECOVERY session", () => {
    expect(users(/\.localRecoveryCode\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/)).toEqual(["lib/auth/recovery.ts"]);
    expect(users(/scope: "RECOVERY"/)).toEqual(["lib/auth/recovery.ts"]);
    expect(users(/purpose: "RECOVERY"/)).toEqual(["lib/auth/recovery.ts"]);
    const store = read("lib/provider-adapters/implementations/luxia-local/prisma-local-identity-store.ts");
    expect(store).toMatch(/async saveRecoveryCode\(\): Promise<void> \{\n    throw new ProviderAdapterError\(/);
    expect(store).toMatch(/async consumeRecoveryCode\(\): Promise<boolean> \{\n    return false;\n  \}/);
  });

  it("lock order: the organization first, then the person's own rows, then the first write", () => {
    const recovery = read("lib/auth/recovery.ts");
    for (const name of ["recoverySignIn", "beginRecoveryEnrollment", "completeRecoveryEnrollment", "generateRecoveryCodes", "revokeRecoveryCodes"]) {
      const fn = body(recovery, name);
      const organization = fn.indexOf("lockOrganizationActive(tx");
      expect(organization, name).toBeGreaterThan(-1);
      expect(organization, name).toBeLessThan(fn.search(WRITE));
      expect(fn.trimEnd(), name).toMatch(/SET CONSTRAINTS ALL IMMEDIATE|localAuthChallenge\.create/);
    }
    for (const name of ["generateRecoveryCodes", "revokeRecoveryCodes"]) {
      const fn = body(recovery, name);
      expect(fn.indexOf("lockOwnLocalIdentity(tx"), name).toBeGreaterThan(fn.indexOf("lockOrganizationActive(tx"));
      expect(fn.indexOf("lockOwnLocalIdentity(tx"), name).toBeLessThan(fn.search(WRITE));
    }
    expect(body(recovery, "lockOwnLocalIdentity")).toContain("FOR NO KEY UPDATE OF li");
    // R2: generation needs a passkey sign-in less than 15 minutes old, checked before any write.
    const generate = body(recovery, "generateRecoveryCodes");
    expect(generate.indexOf("requireRecentPasskeySignIn(tx")).toBeLessThan(generate.search(WRITE));
  });

  it("enrolment ends the recovery session first, once, and applies R4 in the same transaction", () => {
    const fn = body(read("lib/auth/recovery.ts"), "completeRecoveryEnrollment");
    const order = [`scope: "RECOVERY",\n        revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now }`, "localAuthChallenge.updateMany(",
      "localAuthenticator.updateMany(", "localAuthenticator.create(", "session.updateMany({ where: { ...own, revokedAt: null }",
      `"RECOVERY.PASSKEY_ENROLLED"`, "SET CONSTRAINTS ALL IMMEDIATE"].map((part) => fn.indexOf(part));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fn).toContain("if (ended.count !== 1) throw sessionInvalid();");
    expect(read("app/api/auth/recovery/enrollment/complete/route.ts")).toContain(`response.cookies.set("luxia_session", "", {`);
  });

  it("recovery sign-in: one generic refusal, a minimum duration, and a session of 15 minutes", () => {
    const route = read("app/api/auth/local/recovery/route.ts");
    expect(route.match(/NextResponse\.json\(\{ error: "[A-Z_]+" \}/g)).toEqual([`NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }`]);
    expect(route).toContain(`allowRequest("recovery", clientNetworkKey(request))`);
    expect(route).toContain(`allowRequest("recovery-identity", `);
    expect(route.match(/return withMinimumDuration\(|return failure\(\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(route).not.toMatch(/return NextResponse\./);
    const signIn = body(read("lib/auth/recovery.ts"), "recoverySignIn");
    expect(signIn).toContain(`scope: "RECOVERY", createdAt: now, expiresAt, lastSeenAt: now`);
    expect(read("lib/auth/recovery.ts")).toContain("export const RECOVERY_SESSION_MS = 15 * 60_000;");
    expect(read("lib/security/rate-limit.ts")).toMatch(/"recovery": \{ windowSeconds: 3600, max: 10 \}[^\n]*\n\s*"recovery-identity": \{ windowSeconds: 3600, max: 5 \}/);
  });

  it("B2 stays self-service: no permission, no grant, no operator or B4 logic", () => {
    const service = read("lib/auth/recovery.ts").replace(/^\s*\/\/.*$/gm, "");
    expect(service).not.toMatch(PERMISSION);
    expect(service).not.toMatch(/\.assignment\.|grantAdministrator|last-administrator|lockTenantGovernance/);
    expect(service).not.toMatch(/transitionOrganization|readOrganizationLifecycle|BREAK_GLASS|identityRecoveryCeremony|operator/i);
    for (const name of ["beginRecoveryEnrollment", "completeRecoveryEnrollment"])
      expect(body(service, name), name).toMatch(new RegExp(`function ${name}\\(context: RecoveryContext`));
    for (const name of ["recoveryCodeStatus", "generateRecoveryCodes", "revokeRecoveryCodes"])
      expect(body(service, name), name).toMatch(new RegExp(`function ${name}\\(auth: AuthContext`));
  });

  it("the migration adds an owner-only guard trigger, and the rollback cannot resurrect a code", () => {
    const sql = read("prisma/migrations/20261012090000_recovery_codes_b2/migration.sql");
    expect(sql).toContain(`CREATE TRIGGER recovery_code_guard BEFORE INSERT OR UPDATE OR DELETE ON "LocalRecoveryCode"`);
    expect(sql).not.toMatch(/SECURITY DEFINER|GRANT /);
    expect(sql).toContain("RECOVERY_CODE_FROZEN");
    expect(sql).toContain("RECOVERY_CODE_LIMIT");
    const rollback = read("docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql");
    const steps = [`DROP TRIGGER recovery_code_guard`, `DROP CONSTRAINT "LocalRecoveryCode_hash_format"`, `SET "usedAt" = "revokedAt" WHERE "revokedAt" IS NOT NULL AND "usedAt" IS NULL`,
      `"scope" = 'RECOVERY' AND "revokedAt" IS NULL`, `DROP COLUMN "batchId", DROP COLUMN "revokedAt"`,
      `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261012090000_recovery_codes_b2'`].map((step) => rollback.indexOf(step));
    expect(steps.every((index) => index > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });
});
