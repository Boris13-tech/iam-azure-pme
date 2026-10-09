// Fail before tests if a regression database contains any prior fixtures.
// The real Production copy (neondb) is deliberately not accepted here.
const {PrismaClient}=require('@prisma/client');
const assert=require('node:assert/strict');
let url;
try {
url=new URL(process.env.DATABASE_MIGRATION_URL);
assert.equal(url.hostname,'ep-solitary-wildflower-ahcqqg5r.c-3.us-east-1.aws.neon.tech');
assert.equal(url.username,'neondb_owner');
assert.ok(['/luxia_reviews_cert','/luxia_resources_diag_awake01','/luxia_resources_diag_concurrency02','/luxia_resources_diag_global01','/luxia_resources_diag_ci02','/luxia_resources_diag_ci03'].includes(url.pathname));
} catch { console.error('DIAGNOSTIC_ENDPOINT_DENIED');process.exit(1); }
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const [role]=await tx.$queryRawUnsafe('SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname=current_user');
  assert.ok(role.rolbypassrls||role.rolsuper,'FIXTURE_FRESHNESS_VISIBILITY_UNPROVEN');
  const [migrations]=await tx.$queryRawUnsafe('SELECT count(*)::int n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
  assert.equal(migrations.n,19,'DIAGNOSTIC_MIGRATION_STATE_MISMATCH');
  const counts={};
  for(const table of ['Organization','Tenant','Subject','IdentityAccount','Session','Resource','ResourceScope','Entitlement','Assignment','SoDPolicy','AccessReviewCampaign','CanonicalAdminAuditEvent','User','Role','Permission','LegacyUserBridge']) {
    const [row]=await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "${table}"`);counts[table]=row.n;
  }
  assert.ok(Object.values(counts).every(n=>n===0),'DIAGNOSTIC_FIXTURE_DATABASE_NOT_EMPTY');
  return {database:url.pathname.slice(1),migrations:migrations.n,fixtures:'EMPTY',result:'PASS'};
},{timeout:30000}).then(proof=>console.log('FRESH_FIXTURE_PREFLIGHT '+JSON.stringify(proof)))
  .catch(error=>{const code=['FIXTURE_FRESHNESS_VISIBILITY_UNPROVEN','DIAGNOSTIC_MIGRATION_STATE_MISMATCH','DIAGNOSTIC_FIXTURE_DATABASE_NOT_EMPTY'].find(x=>error.message.includes(x));console.error(code??'FRESH_FIXTURE_PREFLIGHT_FAILED');process.exitCode=1;})
  .finally(()=>db.$disconnect());
