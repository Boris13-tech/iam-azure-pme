// Checks that a restored LUXIA database BEHAVES like Production, on its real data: row-level security isolates
// every organization for the runtime role, and the journal and sign-in evidence stay append-only. Every write
// attempt runs in a transaction that is rolled back. Prints counts and verdicts only, never row content.
//
//   LUXIA_RESTORE_TARGET_URL=<owner>  LUXIA_RESTORE_APP_URL=<app_user>  node scripts/backup/verify-restored.mjs [report.json]
import { writeFileSync } from "node:fs";
import { fail, pgEnv, psql } from "./pg.mjs";

if (!process.env.LUXIA_RESTORE_TARGET_URL || !process.env.LUXIA_RESTORE_APP_URL) fail("set LUXIA_RESTORE_TARGET_URL and LUXIA_RESTORE_APP_URL");
const owner = pgEnv(process.env.LUXIA_RESTORE_TARGET_URL, "luxia-verify-restored");
const app = pgEnv(process.env.LUXIA_RESTORE_APP_URL, "luxia-verify-restored-app");
const ro = (env, sql) => psql(env, `BEGIN READ ONLY;\n${sql}\nCOMMIT;\n`).stdout.trim();
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); };
const quote = name => `"${name.replace(/"/g, '""')}"`;

const [appUser, appBypass] = ro(app, "SELECT current_user, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user;").split("|");
check("runtime role", appUser === "app_user" && appBypass === "f", `${appUser}, bypassrls=${appBypass}`);

// Every tenant table carries both scope columns and forced RLS.
const tenantTables = ro(owner, `SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'organizationId' AND NOT a.attisdropped)
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
  AND has_table_privilege('app_user', c.oid, 'SELECT');`).split(",").filter(Boolean);
const scopes = ro(owner, `SELECT "organizationId" || '|' || id FROM "Tenant" ORDER BY "organizationId", id;`).split("\n").filter(Boolean).map(line => line.split("|"));
check("scope inventory", tenantTables.length > 20 && scopes.length > 0, `${tenantTables.length} tenant tables, ${scopes.length} organization/tenant scopes`);

// Without a scope, the runtime role sees nothing.
const unscoped = ro(app, tenantTables.map(t => `SELECT ${quote(t).replace(/"/g, "'")} || '=' || count(*) FROM ${quote(t)};`).join("\n"))
  .split("\n").filter(line => !line.endsWith("=0"));
check("no scope, no row", unscoped.length === 0, unscoped.length ? unscoped.join(", ") : `0 rows in all ${tenantTables.length} tables`);

// In each real scope, the runtime role sees exactly that scope's rows, as the owner counts them. Both setting names
// are set: the Phase 5D shadow-observation policy reads app.current_organization_id / app.current_tenant_id.
let compared = 0; let rows = 0; const mismatches = [];
for (const [organizationId, tenantId] of scopes) {
  const scoped = psql(app, `BEGIN READ ONLY;\nSELECT set_config('app.organization_id', '${organizationId}', true), set_config('app.tenant_id', '${tenantId}', true), set_config('app.current_organization_id', '${organizationId}', true), set_config('app.current_tenant_id', '${tenantId}', true);\n`
    + tenantTables.map(t => `SELECT count(*) FROM ${quote(t)};`).join("\n") + "\nCOMMIT;\n").stdout.trim().split("\n").slice(1);
  const expected = ro(owner, tenantTables.map(t => `SELECT count(*) FROM ${quote(t)} WHERE "organizationId" = '${organizationId}' AND "tenantId" = '${tenantId}';`).join("\n")).split("\n");
  tenantTables.forEach((table, i) => {
    compared += 1; rows += Number(expected[i]);
    if (scoped[i] !== expected[i]) mismatches.push(`${table}@scope${scopes.findIndex(s => s[1] === tenantId)}: app ${scoped[i]} vs owner ${expected[i]}`);
  });
}
check("each organization sees exactly its own rows", mismatches.length === 0 && rows > 0,
  mismatches.length ? mismatches.slice(0, 5).join("; ") : `${compared} table×scope pairs, ${rows} rows, all identical`);

// Append-only: real rows of the journal and of the sign-in evidence cannot be changed or erased.
for (const table of ["CanonicalAdminAuditEvent", "AuthenticationEvidence"]) {
  const [organizationId, tenantId, id] = ro(owner, `SELECT "organizationId" || '|' || "tenantId" || '|' || id FROM ${quote(table)} ORDER BY id LIMIT 1;`).split("|");
  if (!id) { check(`${table} append-only`, false, "no row to test"); continue; }
  const scope = `SELECT set_config('app.organization_id', '${organizationId}', true), set_config('app.tenant_id', '${tenantId}', true), set_config('app.current_organization_id', '${organizationId}', true), set_config('app.current_tenant_id', '${tenantId}', true);`;
  const attempts = [
    [app, `UPDATE ${quote(table)} SET "organizationId" = "organizationId" WHERE id = '${id}'`, /permission denied/],
    [app, `DELETE FROM ${quote(table)} WHERE id = '${id}'`, /permission denied/],
    [owner, `UPDATE ${quote(table)} SET "organizationId" = "organizationId" WHERE id = '${id}'`, /AUDIT_APPEND_ONLY/],
    [owner, `DELETE FROM ${quote(table)} WHERE id = '${id}'`, /AUDIT_APPEND_ONLY/],
  ];
  const outcomes = attempts.map(([env, sql, expected]) => {
    const r = psql(env, `BEGIN;\n${scope}\n${sql};\nROLLBACK;\n`, { allowFailure: true });
    return !r.ok && expected.test(r.stderr);
  });
  check(`${table} append-only`, outcomes.every(Boolean), `${outcomes.filter(Boolean).length}/4 refused (app_user: no right; owner: AUDIT_APPEND_ONLY)`);
}

const facts = ro(owner, `SELECT json_build_object(
  'organizationsByStatus', (SELECT json_object_agg(status, n) FROM (SELECT status::text, count(*) AS n FROM "Organization" GROUP BY 1) s),
  'activePasskeys', (SELECT count(*) FROM "LocalAuthenticator" WHERE status::text = 'ACTIVE'),
  'recoveryCodes', (SELECT count(*) FROM "LocalRecoveryCode"),
  'journalEvents', (SELECT count(*) FROM "CanonicalAdminAuditEvent"),
  'signInEvidence', (SELECT count(*) FROM "AuthenticationEvidence"),
  'sessions', (SELECT count(*) FROM "Session"));`);
console.log(`facts: ${facts}`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ results, facts: JSON.parse(facts) }, null, 2));
if (results.some(r => !r.ok)) process.exit(1);
