import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePrincipalName } from "../../lib/auth/organization-login";

// R4 and R6: static checks of the retention migration, its rollback and the CI grants.
const NEW = "20261025120000_retention_invitations_pseudonymization";
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const migration = read(`prisma/migrations/${NEW}/migration.sql`);
const rollback = read("docs/operations/RETENTION-INVITATIONS-PSEUDONYMIZATION-ROLLBACK.sql");
const bootstrap = read("scripts/ci/bootstrap-app-user.sql");
const GATE = `  -- R4: the data-based exception, the DELETE of an invitation finished (accepted, revoked or expired) for more than
  -- 30 days (PROPOSED period). createdAt and expiresAt are set by this guard and never change; acceptedAt and
  -- revokedAt come from the application, so a backdated one cannot make a row created less than 30 days ago go.
  IF TG_OP = 'DELETE' AND LEAST(OLD."acceptedAt", OLD."revokedAt", OLD."expiresAt") < v_now - interval '30 days'
     AND OLD."createdAt" < v_now - interval '30 days' THEN
    RETURN OLD;
  END IF;
`;
const R7_GATE = `  -- R7: the one exception, a DELETE inside the operator's erasure of this CLOSED organization.
  IF TG_OP = 'DELETE' AND NULLIF(current_setting('luxia.erasure_organization', true), '') IS NOT NULL THEN
    IF luxia_erasure_allowed(OLD."organizationId", TG_RELID) THEN RETURN OLD; END IF;
  END IF;
`;
const SUBJECT_PSEUDONYM = `'Ancien membre ' || left(encode(sha256(convert_to(s."id", 'UTF8')), 'hex'), 8)`;
const PRINCIPAL_PSEUDONYM = `'ANCIEN-MEMBRE-' || encode(sha256(convert_to(l."id", 'UTF8')), 'hex')`;

function fn(sql: string, name: string) {
  const matches = [...sql.matchAll(new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`, "g"))];
  if (!matches.length) throw new Error(`missing ${name}`);
  const start = matches[matches.length - 1].index!;
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2).replace(/^CREATE (OR REPLACE )?FUNCTION (public\.)?/, "CREATE FUNCTION ");
}
/** The latest definition of a function before this migration (R7's, for the invitation guard). */
function previous(name: string) {
  const dirs = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
  let found = "";
  for (const dir of dirs) {
    const sql = read(`prisma/migrations/${dir}/migration.sql`);
    if (new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`).test(sql)) found = fn(sql, name);
  }
  return found;
}
// R4: the end of an invitation is stamped with the database's clock, so a caller cannot backdate it into the purge window.
const STAMP = `  -- R4: the moment an invitation ends is the database's clock, never the caller's. Without this, a role that may
  -- revoke could backdate revokedAt and make a row finished less than 30 days ago eligible for the purge.
  IF NEW."acceptedAt" IS NOT NULL AND OLD."acceptedAt" IS NULL THEN NEW."acceptedAt" := v_now; END IF;
  IF NEW."revokedAt" IS NOT NULL AND OLD."revokedAt" IS NULL THEN NEW."revokedAt" := v_now; END IF;
`;
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("R4/R6 retention: migration architecture", () => {
  it("comes after R7 and changes exactly one guard, the invitation guard: R7's body plus the R4 gate (first) and the end-time stamp", () => {
    const dirs = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir)).sort();
    expect(dirs.indexOf(NEW)).toBeGreaterThan(dirs.indexOf("20261023140000_organization_erasure"));
    expect([...migration.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1])).toEqual(["luxia_invitation_guard"]);
    const now = fn(migration, "luxia_invitation_guard");
    const before = previous("luxia_invitation_guard");
    expect(before, "R7's body is the previous one").toContain(R7_GATE);
    expect(now.split(GATE)).toHaveLength(2);
    expect(now.split(STAMP)).toHaveLength(2);
    expect(now.replace(GATE, "").replace(STAMP, "")).toBe(before);
    // The stamp sits after the immutability checks (a finished row cannot change) and before the expiry check.
    expect(now.indexOf(STAMP) + STAMP.length).toBe(now.indexOf(`  IF NEW."acceptedAt" IS NOT NULL AND OLD."expiresAt" <= v_now THEN`));
    expect(now.indexOf(GATE)).toBe(now.indexOf("\nBEGIN\n") + "\nBEGIN\n".length);
    // R7's erasure gate is kept, right after the R4 gate.
    expect(now.indexOf(R7_GATE)).toBe(now.indexOf(GATE) + GATE.length);
    expect(migration).not.toMatch(/CREATE TRIGGER|DROP TRIGGER|ALTER TABLE|DROP FUNCTION|TRUNCATE/);
  });

  it("the gate is data-based: DELETE only, one fixed period, rows created and finished more than 30 days ago", () => {
    expect(GATE).toMatch(/^ {2}IF TG_OP = 'DELETE' AND /m);
    expect(GATE).not.toMatch(/current_setting|current_user|session_user|UPDATE|INSERT/);
    expect([...GATE.matchAll(/interval '(\d+ \w+)'/g)].map((m) => m[1])).toEqual(["30 days", "30 days"]);
  });

  it("the purge selects with the gate's predicate and the gate's clock, so it never asks the guard for a row it refuses", () => {
    const purge = fn(migration, "luxia_retention_purge_invitations");
    const gatePredicate = squash(/IF TG_OP = 'DELETE' AND ([\s\S]+?) THEN/.exec(GATE)![1].replace(/OLD\./g, ""));
    const wheres = [...purge.matchAll(/WHERE (LEAST[\s\S]+?)\n\s+(?:ORDER BY|LIMIT)/g)].map((m) => squash(m[1]));
    expect(wheres).toEqual([gatePredicate, gatePredicate]);
    expect(purge).toContain("v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');");
    expect(fn(migration, "luxia_invitation_guard")).toContain("v_now TIMESTAMP(3) := (now() AT TIME ZONE 'UTC');");
    expect(purge.match(/DELETE FROM "(\w+)"/g)).toEqual(['DELETE FROM "Invitation"']);
    expect(purge).toContain("LIMIT p_batch FOR UPDATE SKIP LOCKED");
  });

  it("pseudonymization writes exactly two columns, only to their pseudonyms, for people retired for more than 30 days", () => {
    const pseudo = fn(migration, "luxia_retention_pseudonymize_retired");
    expect(pseudo.match(/UPDATE "\w+" \w+ SET [^\n]+/g)).toEqual([
      `UPDATE "Subject" s SET "name" = ${SUBJECT_PSEUDONYM}`,
      `UPDATE "LocalIdentity" l SET "principalName" = ${PRINCIPAL_PSEUDONYM}`,
    ]);
    expect(pseudo).not.toMatch(/DELETE|INSERT|"CanonicalAdminAuditEvent"|"AuthenticationEvidence"|"Session"|"LocalAuthenticator"|"LocalRecoveryCode"/);
    const selections = [...pseudo.matchAll(/SELECT s\."id" FROM "Subject" s\n([\s\S]+?)ORDER BY s\."lifecycleChangedAt", s\."id" LIMIT p_batch/g)].map((m) => squash(m[1]));
    expect(selections).toHaveLength(2);
    expect(selections[0]).toBe(selections[1]);
    expect(selections[0]).toContain(`WHERE s."type" = 'HUMAN' AND s."lifecycleState" = 'RETIRED' AND s."lifecycleChangedAt" < v_cutoff`);
    expect(pseudo).toContain("v_cutoff TIMESTAMP(3) := (now() AT TIME ZONE 'UTC') - interval '30 days';");
    expect(pseudo).toContain("LIMIT p_batch FOR UPDATE OF s SKIP LOCKED");
    expect(pseudo).not.toMatch(/interval '(?!30 days)/);
  });

  it("the sign-in pseudonym can never be stored or looked up by the application (it lowercases every sign-in name)", () => {
    const sample = `ANCIEN-MEMBRE-${"ab".repeat(32)}`;
    expect(sample.length).toBeLessThanOrEqual(254);
    expect(normalizePrincipalName(sample)).not.toBe(sample);
  });

  it("both entry points: definer, pinned search_path, bounded batch, dry run, one run at a time, BYPASSRLS, counts only", () => {
    for (const name of ["luxia_retention_purge_invitations", "luxia_retention_pseudonymize_retired"]) {
      const body = fn(migration, name);
      expect(body, name).toMatch(/\(p_batch integer, p_enforce boolean\) RETURNS jsonb\nLANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS \$\$/);
      expect(body, name).toContain("IF p_batch IS NULL OR p_batch < 1 OR p_batch > 5000 OR p_enforce IS NULL THEN");
      expect(body, name).toContain("RETENTION_ARGUMENT_OUT_OF_RANGE");
      expect(body, name).toContain("RETENTION_OWNER_REQUIRES_BYPASSRLS");
      expect(body, name).toMatch(/IF NOT pg_try_advisory_xact_lock\(hashtextextended\('luxia-retention-[a-z-]+', 0\)\) THEN\n\s+RAISE EXCEPTION 'RETENTION_ALREADY_RUNNING'/);
      expect(body, name).toContain("IF p_enforce THEN");
      expect(body, name).not.toMatch(/EXECUTE |format\(|\|\| *p_/);
      expect(body.match(/RETURN [^;]+;/g), name).toHaveLength(1);
      expect(body.match(/RETURN [^;]+;/g)![0], name).toMatch(/^RETURN jsonb_build_object\(/);
      expect(migration, name).toMatch(new RegExp(`END \\$\\$;\\nREVOKE ALL ON FUNCTION ${name}\\(integer, boolean\\) FROM PUBLIC;`));
    }
  });

  it("the runtime gets EXECUTE on the two entry points only, mirrored in the CI bootstrap; no table privilege changes", () => {
    expect(migration.match(/GRANT [^;]+;/g)).toEqual([
      "GRANT EXECUTE ON FUNCTION luxia_retention_purge_invitations(integer, boolean) TO app_user;",
      "GRANT EXECUTE ON FUNCTION luxia_retention_pseudonymize_retired(integer, boolean) TO app_user;",
    ]);
    expect(migration).not.toMatch(/REVOKE (?!ALL ON FUNCTION luxia_retention_)/);
    expect(bootstrap).toContain("GRANT EXECUTE ON FUNCTION public.luxia_retention_purge_invitations(INTEGER,BOOLEAN) TO app_user;");
    expect(bootstrap).toContain("GRANT EXECUTE ON FUNCTION public.luxia_retention_pseudonymize_retired(INTEGER,BOOLEAN) TO app_user;");
    // app_user still has no DELETE on Invitation in CI (same as Production since self-onboarding v1).
    expect(bootstrap).toContain('GRANT SELECT, INSERT, UPDATE ON "OrganizationDomain", "Invitation" TO app_user;');
  });

  it("the rollback restores the invitation guard exactly as R7 left it and removes the rest", () => {
    expect(fn(rollback, "luxia_invitation_guard")).toBe(previous("luxia_invitation_guard"));
    expect(rollback).not.toContain("-- R4:");
    expect([...rollback.matchAll(/CREATE (OR REPLACE )?FUNCTION (\w+)\(/g)].map((m) => m[2])).toEqual(["luxia_invitation_guard"]);
    for (const text of ["DROP FUNCTION luxia_retention_purge_invitations(integer, boolean);",
      "DROP FUNCTION luxia_retention_pseudonymize_retired(integer, boolean);", `'${NEW}'`])
      expect(rollback).toContain(text);
  });
});
