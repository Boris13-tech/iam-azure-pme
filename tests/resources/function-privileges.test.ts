import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";

const functions = ["luxia_sod_scope_contains", "luxia_sod_assignment_guard", "luxia_review_immutable_guard", "luxia_resource_onboarding_evidence_guard"];
describe("LUXIA SQL function privilege architecture", () => {
  it("every function introduced by these migrations explicitly revokes PUBLIC", () => {
    const files = ["20261004120000_resource_governance_foundation", "20261004160000_static_sod_v1", "20261004180000_access_reviews_v1", "20261008040000_resource_onboarding_evidence"];
    const names: string[] = [];
    for (const file of files) {
      const sql = readFileSync(`prisma/migrations/${file}/migration.sql`, "utf8");
      const declarations = [...sql.matchAll(/CREATE FUNCTION (luxia_\w+)/g)];
      for (let i = 0; i < declarations.length; i++) {
        const name = declarations[i][1]; names.push(name);
        const segment = sql.slice(declarations[i].index, declarations[i + 1]?.index);
        // First statement after the function body, before any trigger or grant.
        expect(segment).toMatch(new RegExp(`\\$\\$;\\s*REVOKE ALL ON FUNCTION ${name}\\([^;]*\\) FROM PUBLIC;`));
        if (name !== "luxia_sod_scope_contains") expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(`));
      }
    }
    expect(names.sort()).toEqual([...functions].sort());
  });
});

type Privilege = { nspname: string; proname: string; owner: string; proacl: string | null;
  public_execute: boolean; runtime_execute: boolean; owner_execute: boolean; unrelated_execute: boolean; unexpected_acl: boolean };
describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Generic PostgreSQL LUXIA function privilege gate", () => {
  it("PUBLIC/anonymous/unrelated execute NONE; runtime helper only; owner retains EXECUTE", async () => {
    const rows = await rawPrisma.$queryRaw<Privilege[]>`
      SELECT n.nspname,p.proname,pg_get_userbyid(p.proowner) AS owner,p.proacl::text,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
        has_function_privilege('app_user',p.oid,'EXECUTE') AS runtime_execute,
        has_function_privilege(p.proowner,p.oid,'EXECUTE') AS owner_execute,
        has_function_privilege('pg_read_all_data',p.oid,'EXECUTE') AS unrelated_execute,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user') AND p.proname='luxia_sod_scope_contains')) AS unexpected_acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`;
    // There is no PUBLIC whitelist: a newly introduced function is fail-closed.
    expect(rows.map(row => row.proname).sort()).toEqual([...functions].sort());
    for (const row of rows) {
      expect(row.public_execute, row.proname).toBe(false);
      expect(row.unrelated_execute, row.proname).toBe(false);
      expect(row.unexpected_acl, row.proname).toBe(false);
      expect(row.owner_execute, row.proname).toBe(true);
      expect(row.runtime_execute, row.proname).toBe(row.proname === "luxia_sod_scope_contains");
    }
    const anonymous = await rawPrisma.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT has_function_privilege(r.oid,p.oid,'EXECUTE') AS allowed FROM pg_roles r CROSS JOIN pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE r.rolname IN ('anon','anonymous','authenticated') AND n.nspname='public' AND p.proname LIKE 'luxia_%'`;
    expect(anonymous.every(row => !row.allowed)).toBe(true);
    const triggers = await rawPrisma.$queryRaw<Array<{ tgname: string; proname: string }>>`
      SELECT t.tgname,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname IN ('assignment_static_sod','review_campaign_immutable','review_item_immutable') ORDER BY t.tgname`;
    expect(triggers).toHaveLength(3);
    expect(triggers.filter(row => row.proname === 'luxia_review_immutable_guard')).toHaveLength(2);
    expect(triggers.filter(row => row.proname === 'luxia_sod_assignment_guard')).toHaveLength(1);
  });
});
