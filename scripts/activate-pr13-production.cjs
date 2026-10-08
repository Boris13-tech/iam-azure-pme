/* Explicit operator-authorized PR13 activation. No credentials in outputs. */
const { PrismaClient } = require('@prisma/client');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const candidate=process.env.LUXIA_PRODUCTION_CANDIDATE_SHA;
assert.match(candidate ?? '',/^[0-9a-f]{40}$/);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidate);
const u=new URL(process.env.LUXIA_PRODUCTION_OWNER_URL);
assert.equal(u.hostname,'ep-restless-thunder-ah18c37v.c-3.us-east-1.aws.neon.tech');
assert.equal(u.pathname,'/neondb'); assert.equal(u.username,'neondb_owner');
const p=new PrismaClient({datasources:{db:{url:u.toString()}}});
const expected=['20261004120000_resource_governance_foundation','20261004160000_static_sod_v1','20261004180000_access_reviews_v1'];
const tables=['Subject','IdentityAccount','Assignment','Session','ProviderConnection','Organization','Tenant','User','Role','Permission','UserRole','AccessPolicy','AuditLog','LegacyUserBridge'];
async function identity(t){const out={};for(const name of tables){const exists=await t.$queryRawUnsafe(`SELECT to_regclass('public."${name}"') IS NOT NULL AS present`);if(exists[0].present)out[name]=await t.$queryRawUnsafe(`SELECT count(*)::int AS n,md5(coalesce(string_agg(to_jsonb(r)::text,'|' ORDER BY to_jsonb(r)::text),'')) AS digest FROM "${name}" r`);}return out;}
const acls=t=>t.$queryRawUnsafe(`SELECT p.oid::text,p.proname,p.proacl::text,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.oid`);
async function main(){
 const mode=process.env.LUXIA_PRODUCTION_STEP;
 assert(['HARDEN','HARDEN_TABLES','MIGRATE'].includes(mode));
 const [runtimeRole]=await p.$queryRawUnsafe("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='app_user'");
 assert(runtimeRole&&!runtimeRole.rolsuper&&!runtimeRole.rolbypassrls&&!runtimeRole.rolcreatedb&&!runtimeRole.rolcreaterole);
 if(mode==='HARDEN_TABLES') {
  await p.$transaction(async t=>{
   const [r]=await t.$queryRawUnsafe('SELECT current_user,session_user');assert.equal(r.current_user,'neondb_owner');assert.equal(r.session_user,r.current_user);
   const before=await identity(t), functions=await acls(t);
   const tablesBefore=await t.$queryRawUnsafe(`SELECT oid::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY oid`);
   await t.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_user');
   const extra=await t.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='neondb_owner') AND d.defaclobjtype='r' AND a.grantee IN (0,(SELECT oid FROM pg_roles WHERE rolname='app_user'))`);assert.equal(extra[0].n,0);
   assert.deepEqual(await identity(t),before);assert.deepEqual(await acls(t),functions);
   assert.deepEqual(await t.$queryRawUnsafe(`SELECT oid::text,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY oid`),tablesBefore);
  },{isolationLevel:'RepeatableRead',timeout:60000});
  console.log('Future table hardening: PASS; existing table/function ACL changes: NONE; identity changes: NONE');return;
 }
 if(mode==='HARDEN'){
  await p.$transaction(async t=>{
   const [r]=await t.$queryRawUnsafe('SELECT current_user,session_user');assert.equal(r.current_user,'neondb_owner');assert.equal(r.session_user,r.current_user);
   const before=await acls(t), ids=await identity(t);const resolution=await t.$queryRawUnsafe("SELECT * FROM resolve_session('pr13-invalid-session-hardening-check')");
   await t.$executeRawUnsafe('ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
   const leaks=await t.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole=(SELECT oid FROM pg_roles WHERE rolname='neondb_owner') AND d.defaclobjtype='f' AND a.grantee=0 AND a.privilege_type='EXECUTE'`);assert.equal(leaks[0].n,0);
   const defaults=await t.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclrole=(SELECT oid FROM pg_roles WHERE rolname='neondb_owner') AND defaclnamespace=0 AND defaclobjtype='f'`);assert.equal(defaults[0].n,1);
   assert.deepEqual(await acls(t),before);assert.deepEqual(await identity(t),ids);assert.deepEqual(await t.$queryRawUnsafe("SELECT * FROM resolve_session('pr13-invalid-session-hardening-check')"),resolution);
   console.log('Hardening assertions: PASS; existing ACL changes: NONE; identity mutations: NONE; resolve_session invalid-session regression: NONE');
  },{isolationLevel:'RepeatableRead',timeout:60000});
  console.log('Production hardening committed: YES');return;
 }
 assert.equal(process.env.LUXIA_PRODUCTION_BACKUP_VERIFIED,'true');
 const applied=await p.$queryRawUnsafe('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
 const pending=readdirSync('prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).filter(x=>!applied.some(a=>a.migration_name===x)).sort();assert.deepEqual(pending,expected);
 const before=await identity(p), oldAcls=await acls(p);
 const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{...process.env,DATABASE_URL:u.toString(),DATABASE_MIGRATION_URL:u.toString()},encoding:'utf8',windowsHide:true});assert.equal(result.status,0,'MIGRATION_DEPLOY_FAILED');
 assert.deepEqual(await identity(p),before);
 const afterAcls=await acls(p);assert.deepEqual(afterAcls.filter(x=>oldAcls.some(y=>y.oid===x.oid)),oldAcls);
 const matrix=await p.$queryRawUnsafe(`SELECT p.proname,has_function_privilege('public',p.oid,'EXECUTE') AS public_execute,has_function_privilege('app_user',p.oid,'EXECUTE') AS runtime_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'luxia_%' ORDER BY p.proname`);assert.equal(matrix.length,3);for(const r of matrix){assert.equal(r.public_execute,false);assert.equal(r.runtime_execute,r.proname==='luxia_sod_scope_contains');}
 const rls=await p.$queryRawUnsafe(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)='app_user' AS runtime_owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('ResourceScope','ResourceScopeMember','SoDPolicy','SoDRule','AccessReviewCampaign','AccessReviewItem') ORDER BY c.relname`);assert.equal(rls.length,6);for(const r of rls){assert(r.relrowsecurity&&r.relforcerowsecurity&&!r.runtime_owner);}
 const counts=await p.$queryRawUnsafe('SELECT (SELECT count(*)::int FROM "SoDPolicy") AS policies,(SELECT count(*)::int FROM "AccessReviewCampaign") AS campaigns,(SELECT count(*)::int FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrations');assert.deepEqual(counts,[{policies:0,campaigns:0,migrations:18}]);
 const privileges=await p.$queryRawUnsafe(`SELECT c.relname,has_table_privilege('app_user',c.oid,'DELETE') AS delete,has_table_privilege('app_user',c.oid,'UPDATE') AS update FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('ResourceScope','ResourceScopeMember','SoDPolicy','SoDRule','AccessReviewCampaign','AccessReviewItem')`);assert.equal(privileges.length,6);for(const r of privileges){assert.equal(r.delete,false);assert.equal(r.update,!['ResourceScope','ResourceScopeMember'].includes(r.relname));}
 console.log(JSON.stringify({migrationResult:'PASS',migrations:expected,identityPreservation:'PASS',legacyMutations:'NONE',providerChanges:'NONE',functionMatrix:matrix,rls,counts}));
}
main().catch(()=>{console.error('PRODUCTION_ACTIVATION_STEP_FAILED — STOP');process.exitCode=1;}).finally(()=>p.$disconnect());
