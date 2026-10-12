import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// First Admin / Break-glass v1: static checks of the Organization.status / Session.scope migration
// against its approved design (docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md).
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const migration = read("prisma/migrations/20261011180000_organization_status_session_scope/migration.sql");
const hardened = read("prisma/migrations/20260917140000_session_resolver_hardening/migration.sql");
const rollback = read("docs/operations/ORGANIZATION-STATUS-SESSION-SCOPE-ROLLBACK.sql");
/** The text of one function, from its CREATE to the end of its body. */
function fn(sql: string, name: string) {
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`));
  if (start < 0) throw new Error(`missing ${name}`);
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2);
}
const signature = (definition: string) => definition.slice(definition.indexOf("RETURNS"), definition.indexOf("$$")).replace(/\s+/g, " ")
  .replace(/ (SECURITY DEFINER|SET search_path = public, pg_temp|LANGUAGE plpgsql|AS) /g, " ").trim();

describe("Organization.status / Session.scope migration architecture", () => {
  it("A2: resolve_session keeps its exact signature and only wraps the canonical resolver", () => {
    const wrapper = fn(migration, "resolve_session");
    expect(signature(wrapper)).toBe(signature(fn(hardened, "resolve_session")));
    expect(wrapper).toMatch(/SECURITY DEFINER/);
    expect(wrapper).toContain("FROM luxia_session_resolve(p_hash) r\n  WHERE r.scope = 'FULL';");
    expect(wrapper).not.toContain('"Session"');
    expect(wrapper).not.toContain('"Organization"');
    // CREATE OR REPLACE, never DROP: the Production EXECUTE grant comes from the activation workflow.
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION resolve_session\(p_hash TEXT\)/);
    expect(migration).not.toMatch(/DROP FUNCTION[^;]*resolve_session/);
  });

  it("A5: the canonical resolver is the only implementation and refuses non-ACTIVE organizations", () => {
    const canonical = fn(migration, "luxia_session_resolve");
    expect(canonical).toMatch(/SECURITY DEFINER SET search_path = public, pg_temp/);
    expect(canonical).toContain(`JOIN "Organization" o ON o."id" = s."organizationId"`);
    expect(canonical).toContain(`o."status" = 'ACTIVE'`);
    expect(canonical).toContain(`p_hash ~ '^[0-9a-f]{64}$'`);
    expect(fn(migration, "luxia_invitation_resolve")).toContain(`o."status" = 'ACTIVE'`);
  });

  it("A1, M3: the status guard checks the governance lock of every tenant, never takes it, and allows only the operator role", () => {
    const guard = fn(migration, "luxia_organization_status_guard");
    expect(guard).toContain("hashtextextended('resource-governance:' || NEW.\"id\" || ':' || t.\"id\", 0)");
    expect(guard).toContain("l.pid = pg_backend_pid()");
    expect(guard).toContain("GOVERNANCE_LOCK_REQUIRED");
    expect(guard).not.toMatch(/pg_advisory(_xact)?_lock/);
    expect(guard).toContain("rolbypassrls");
    expect(guard).toContain("IF OLD.\"status\" = 'CLOSED' THEN");
    expect(migration).toMatch(/CREATE CONSTRAINT TRIGGER organization_status_effects AFTER UPDATE OF "status" ON "Organization"\nDEFERRABLE INITIALLY DEFERRED/);
  });

  it("A3, A4: a revoked session is frozen and revokedAt changes once; no rule depends on clocks", () => {
    const guard = fn(migration, "luxia_session_guard");
    expect(guard).toContain(`IF OLD."revokedAt" IS NOT NULL THEN\n    RAISE EXCEPTION 'SESSION_REVOKED_IMMUTABLE'`);
    expect(guard).toContain("SESSION_REVOCATION_ONLY");
    expect(guard).not.toMatch(/now\(\)|clock_timestamp|"createdAt" *[<>]/);
  });

  it("is expand-only, and the rollback restores the previous bodies exactly", () => {
    expect(migration).not.toMatch(/DROP (TABLE|COLUMN|TYPE|FUNCTION)/);
    expect(migration.match(/DROP TRIGGER/g)).toEqual(["DROP TRIGGER"]); // organization_domain_guard, recreated on INSERT too
    expect(migration).toContain("SET lock_timeout = '5s';");
    expect(fn(rollback, "resolve_session")).toBe(fn(hardened, "resolve_session"));
    const selfOnboarding = read("prisma/migrations/20261011000000_customer_self_onboarding_v1/migration.sql");
    for (const name of ["luxia_invitation_resolve", "luxia_invitation_guard", "luxia_organization_domain_guard"])
      expect(fn(rollback, name).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION"), name).toBe(fn(selfOnboarding, name));
    expect(rollback).toContain("ROLLBACK_REFUSED_ORGANIZATION_STATUS_IN_USE");
  });

  it("grants the two runtime entry points in CI and in the Production activation gate", () => {
    const ci = read(".github/workflows/ci.yml");
    const gate = read(".github/workflows/production-activation-gate.yml");
    for (const fnName of ["luxia_session_resolve(TEXT)", "luxia_organization_lock_active(TEXT)"]) {
      expect(ci).toContain(`GRANT EXECUTE ON FUNCTION public.${fnName} TO app_user;`);
      expect(gate).toContain(`GRANT EXECUTE ON FUNCTION public.${fnName} TO app_user;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${fnName} TO app_user;`);
    }
    expect(gate).toContain("Runtime role cannot execute luxia_session_resolve");
  });
});
