import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";

const functions = ["luxia_sod_scope_contains", "luxia_sod_assignment_guard", "luxia_review_immutable_guard", "luxia_resource_onboarding_evidence_guard",
  "luxia_organization_slug_guard", "luxia_signup_code_guard", "luxia_invitation_guard", "luxia_organization_domain_guard",
  "luxia_rate_limit_hit", "luxia_signup_reserve", "luxia_signup_consume", "luxia_invitation_resolve", "luxia_login_decoy",
  "luxia_organization_lock_active", "luxia_organization_status_guard", "luxia_organization_status_effects", "luxia_session_guard", "luxia_session_resolve",
  "luxia_recovery_code_guard", "luxia_audit_append_only",
  "luxia_provider_connection_guard", "luxia_provider_connection_effects", "luxia_provider_connection_lock_active", "luxia_session_connection_guard",
  "luxia_provider_secret_reference_guard", "luxia_session_redact_network_hashes", "luxia_retention_purge_transactions", "luxia_erasure_allowed", "luxia_organization_erase"];
// The only functions app_user may execute. Customer Self-Onboarding v1 adds five narrow SECURITY DEFINER
// entry points that take hashes only; trigger guards stay owner-only. First Admin / Break-glass v1 adds
// the canonical session resolver and the organization status lock helper; its B2 recovery-code guard is a
// trigger (owner-only, never executable by app_user). T0's append-only guard is a trigger too. Sovereign
// providers F2 adds the connection status lock helper (runtime) and three triggers; one of them, the
// quarantine completeness check, is SECURITY DEFINER so that it sees every tenant's sessions. F3's secret
// reference guard is a trigger too (owner-only, not definer). R2's session hash redaction is owner-only
// (an operator step at the gate), never executable by app_user.
// reference guard is a trigger too (owner-only, not definer). R3's retention purge is a runtime entry point
// (the daily job), SECURITY DEFINER with fixed predicates and bounded batches.
// reference guard is a trigger too (owner-only, not definer). R7's organization erasure and its guard gate are
// owner-only (an operator procedure), never executable by app_user, not definer.
const runtime = ["luxia_sod_scope_contains", "luxia_rate_limit_hit", "luxia_signup_reserve", "luxia_signup_consume", "luxia_invitation_resolve", "luxia_login_decoy",
  "luxia_organization_lock_active", "luxia_session_resolve", "luxia_provider_connection_lock_active", "luxia_retention_purge_transactions"];
const triggerDefiners = ["luxia_provider_connection_effects"];
describe("LUXIA SQL function privilege architecture", () => {
  it("every function introduced by these migrations explicitly revokes PUBLIC", () => {
    const files = ["20261004120000_resource_governance_foundation", "20261004160000_static_sod_v1", "20261004180000_access_reviews_v1", "20261008040000_resource_onboarding_evidence",
      "20261011000000_customer_self_onboarding_v1", "20261011180000_organization_status_session_scope", "20261012090000_recovery_codes_b2",
      "20261013090000_audit_append_only", "20261014090000_provider_connection_lifecycle", "20261014110000_provider_secret_reference",
      "20261023120000_session_network_hash_redaction", "20261023130000_retention_purge_transactions", "20261023140000_organization_erasure"];
    const names: string[] = [];
    for (const file of files) {
      const sql = readFileSync(`prisma/migrations/${file}/migration.sql`, "utf8");
      const declarations = [...sql.matchAll(/CREATE FUNCTION (luxia_\w+)/g)];
      for (let i = 0; i < declarations.length; i++) {
        const name = declarations[i][1]; names.push(name);
        const segment = sql.slice(declarations[i].index, declarations[i + 1]?.index);
        // First statement after the function body, before any trigger or grant.
        expect(segment).toMatch(new RegExp(`\\$\\$;\\s*REVOKE ALL ON FUNCTION ${name}\\([^;]*\\) FROM PUBLIC;`));
        if (!runtime.includes(name)) expect(sql).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(`));
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
          WHERE a.grantee<>p.proowner AND NOT(a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user') AND p.proname::text=ANY(${runtime}::text[]))) AS unexpected_acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`;
    // There is no PUBLIC whitelist: a newly introduced function is fail-closed.
    expect(rows.map(row => row.proname).sort()).toEqual([...functions].sort());
    for (const row of rows) {
      expect(row.public_execute, row.proname).toBe(false);
      expect(row.unrelated_execute, row.proname).toBe(false);
      expect(row.unexpected_acl, row.proname).toBe(false);
      expect(row.owner_execute, row.proname).toBe(true);
      expect(row.runtime_execute, row.proname).toBe(runtime.includes(row.proname));
    }
    const anonymous = await rawPrisma.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT has_function_privilege(r.oid,p.oid,'EXECUTE') AS allowed FROM pg_roles r CROSS JOIN pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE r.rolname IN ('anon','anonymous','authenticated') AND n.nspname='public' AND p.proname LIKE 'luxia_%'`;
    expect(anonymous.every(row => !row.allowed)).toBe(true);
    const triggers = await rawPrisma.$queryRaw<Array<{ tgname: string; proname: string }>>`
      SELECT t.tgname,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname IN ('assignment_static_sod','review_campaign_immutable','review_item_immutable',
        'organization_slug_immutable','signup_code_guard','invitation_guard','organization_domain_guard',
        'organization_status_guard','organization_status_effects','session_guard','recovery_code_guard',
        'audit_append_only','audit_append_only_truncate','evidence_append_only','evidence_append_only_truncate',
        'provider_connection_guard','provider_connection_effects','session_guard_provider_connection',
        'provider_secret_reference_guard') ORDER BY t.tgname`;
    expect(triggers).toHaveLength(19);
    expect(triggers.filter(row => row.proname === 'luxia_audit_append_only')).toHaveLength(4);
    expect(triggers.filter(row => row.proname === 'luxia_review_immutable_guard')).toHaveLength(2);
    expect(triggers.filter(row => row.proname === 'luxia_sod_assignment_guard')).toHaveLength(1);
    for (const [trigger, fn] of [["organization_slug_immutable", "luxia_organization_slug_guard"], ["signup_code_guard", "luxia_signup_code_guard"],
      ["invitation_guard", "luxia_invitation_guard"], ["organization_domain_guard", "luxia_organization_domain_guard"],
      ["organization_status_guard", "luxia_organization_status_guard"], ["organization_status_effects", "luxia_organization_status_effects"],
      ["session_guard", "luxia_session_guard"], ["recovery_code_guard", "luxia_recovery_code_guard"],
      ["provider_connection_guard", "luxia_provider_connection_guard"], ["provider_connection_effects", "luxia_provider_connection_effects"],
      ["session_guard_provider_connection", "luxia_session_connection_guard"],
      ["provider_secret_reference_guard", "luxia_provider_secret_reference_guard"]])
      expect(triggers.find(row => row.tgname === trigger)?.proname, trigger).toBe(fn);
    // New runtime entry points are SECURITY DEFINER with a pinned search_path; so is the one trigger-only
    // definer listed above; nothing else is definer.
    const definer = await rawPrisma.$queryRaw<Array<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>>`
      SELECT p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`;
    for (const row of definer) {
      expect(row.prosecdef, row.proname).toBe((runtime.includes(row.proname) && row.proname !== "luxia_sod_scope_contains") || triggerDefiners.includes(row.proname));
      if (row.prosecdef) expect(row.proconfig, row.proname).toContain("search_path=public, pg_temp");
    }
  });
});
