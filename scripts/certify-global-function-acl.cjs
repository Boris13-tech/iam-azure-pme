/* Separate hardening certification; never accepts the Production endpoint. */
const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const url = new URL(process.env.LUXIA_ACL_CLONE_URL);
assert(['ep-ancient-base-ahfygu4z.c-3.us-east-1.aws.neon.tech', 'ep-delicate-boat-ahnvfj7w.c-3.us-east-1.aws.neon.tech'].includes(url.hostname));
assert.equal(url.pathname, '/neondb');
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
const snapshot = () => db.$queryRawUnsafe(`SELECT p.oid::text, p.proname, p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.oid`);
const tableSnapshot = () => db.$queryRawUnsafe(`SELECT oid::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY oid`);
async function main() {
  const [creator] = await db.$queryRawUnsafe('SELECT current_user, session_user');
  assert.equal(creator.current_user, creator.session_user);
  assert.equal(creator.current_user, 'neondb_owner');
  console.log(JSON.stringify({ migrationCreator: creator }));
  const before = await snapshot();
  const tablesBefore = await tableSnapshot();
  const resolver = await db.$queryRawUnsafe(`SELECT p.oid::text,p.proacl::text,p.prosrc,has_function_privilege('app_user',p.oid,'EXECUTE') AS runtime_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='resolve_session'`);
  const oldResult = await db.$queryRawUnsafe("SELECT * FROM resolve_session('acl-certification-invalid-session')");
  await db.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
  await db.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await tableSnapshot(), tablesBefore);
  assert.deepEqual(await db.$queryRawUnsafe("SELECT * FROM resolve_session('acl-certification-invalid-session')"), oldResult);
  await db.$executeRawUnsafe('CREATE FUNCTION public.luxia_acl_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  try {
    const [probe] = await db.$queryRawUnsafe(`SELECT has_function_privilege('public','public.luxia_acl_probe()','EXECUTE') AS public_execute,has_function_privilege(current_user,'public.luxia_acl_probe()','EXECUTE') AS owner_execute,has_function_privilege('app_user','public.luxia_acl_probe()','EXECUTE') AS runtime_execute`);
    assert.deepEqual(probe, {public_execute:false,owner_execute:true,runtime_execute:false});
    console.log(JSON.stringify({ probe }));
  } finally { await db.$executeRawUnsafe('DROP FUNCTION public.luxia_acl_probe()'); }
  const defaults = await db.$queryRawUnsafe(`SELECT defaclrole::regrole::text AS creator,coalesce(n.nspname,'GLOBAL') AS scope,defaclobjtype,defaclacl::text AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY creator,scope,defaclobjtype`);
  const leaks = await db.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclobjtype='f' AND a.grantee=0 AND a.privilege_type='EXECUTE'`);
  assert.equal(leaks[0].n,0);
  console.log(JSON.stringify({defaultAcls:defaults,existingFunctionAclChanges:'NONE',resolveSessionInvalidSessionRegression:'NONE'}));
  const result = spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{...process.env,DATABASE_URL:url.toString(),DATABASE_MIGRATION_URL:url.toString()},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,'CANDIDATE_MIGRATIONS_FAILED');
  const matrix = await db.$queryRawUnsafe(`SELECT p.proname,has_function_privilege('public',p.oid,'EXECUTE') AS public_execute,has_function_privilege('app_user',p.oid,'EXECUTE') AS runtime_execute,has_function_privilege(current_user,p.oid,'EXECUTE') AS owner_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`);
  assert.equal(matrix.length,3);
  for(const row of matrix){assert.equal(row.public_execute,false);assert.equal(row.owner_execute,true);assert.equal(row.runtime_execute,row.proname==='luxia_sod_scope_contains');}
  const after = await snapshot();
  assert.deepEqual(after.filter(row=>before.some(old=>old.oid===row.oid)),before);
  assert.deepEqual(await db.$queryRawUnsafe(`SELECT p.oid::text,p.proacl::text,p.prosrc,has_function_privilege('app_user',p.oid,'EXECUTE') AS runtime_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='resolve_session'`),resolver);
  assert.deepEqual(await db.$queryRawUnsafe("SELECT * FROM resolve_session('acl-certification-invalid-session')"),oldResult);
  console.log(JSON.stringify({candidateFunctionMatrix:matrix,migrations:'PASS',existingFunctionAclChanges:'NONE',productionModified:'NO'}));
  const tablePrivileges = await db.$queryRawUnsafe(`SELECT c.relname,has_table_privilege('app_user',c.oid,'SELECT') AS read,has_table_privilege('app_user',c.oid,'INSERT') AS insert,has_table_privilege('app_user',c.oid,'UPDATE') AS update,has_table_privilege('app_user',c.oid,'DELETE') AS delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('ResourceScope','ResourceScopeMember','SoDPolicy','SoDRule','AccessReviewCampaign','AccessReviewItem') ORDER BY c.relname`);
  assert.equal(tablePrivileges.length,6);
  for(const row of tablePrivileges){assert(row.read&&row.insert);assert.equal(row.delete,false);assert.equal(row.update,!['ResourceScope','ResourceScopeMember'].includes(row.relname));}
  console.log(JSON.stringify({tableLeastPrivilege:'PASS',tablePrivileges}));
  const rls = await db.$queryRawUnsafe(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)='app_user' AS runtime_owner FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('ResourceScope','ResourceScopeMember','SoDPolicy','SoDRule','AccessReviewCampaign','AccessReviewItem')`);
  assert.equal(rls.length,6); for(const row of rls) assert(row.relrowsecurity&&row.relforcerowsecurity&&!row.runtime_owner);
  const [role] = await db.$queryRawUnsafe("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='app_user'");
  assert(role&&!role.rolsuper&&!role.rolbypassrls&&!role.rolcreatedb&&!role.rolcreaterole);
  assert.deepEqual((await tableSnapshot()).filter(row=>tablesBefore.some(old=>old.oid===row.oid)),tablesBefore);
  console.log('Copied database RLS/posture: PASS; existing table ACL changes: NONE');
}
main().catch(()=>{console.error('ISOLATED_ACL_CERTIFICATION_FAILED');process.exitCode=1;}).finally(()=>db.$disconnect());
