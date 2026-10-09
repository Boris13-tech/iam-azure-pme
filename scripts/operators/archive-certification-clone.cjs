// Read-only, redacted evidence export before operator-approved ephemeral clone cleanup.
const { PrismaClient } = require('@prisma/client');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const url = new URL(process.env.DATABASE_URL);
const profiles = {'ep-lingering-bird-ah4pwsn2-pooler.c-3.us-east-1.aws.neon.tech':'br-bitter-bread-ahptkj1r',
  'ep-empty-hill-ahbgk7xs-pooler.c-3.us-east-1.aws.neon.tech':'br-ancient-unit-ahy064za',
  'ep-solitary-wildflower-ahcqqg5r-pooler.c-3.us-east-1.aws.neon.tech':'br-small-mountain-ahs8b0nr'};
assert.ok(profiles[url.hostname], 'CERTIFICATION_CLONE_ONLY');
assert.equal(url.pathname, '/neondb');
assert.equal(decodeURIComponent(url.username), 'app_user');
const db = new PrismaClient();
async function main() {
  const evidence = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SELECT set_config('app.organization_id','4841428a-80b4-4f07-bb3f-c94612dfd4a2',true)");
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id','c68ae9ee-11a8-42f9-bc9c-b19c42ec7914',true)");
    const audits = await tx.$queryRawUnsafe(`SELECT id,operation,result,"occurredAt",metadata->>'manifestBinding' AS "manifestBinding",metadata->>'reasonCode' AS "reasonCode" FROM "CanonicalAdminAuditEvent" WHERE operation LIKE '%BOOTSTRAP%' ORDER BY "occurredAt",id`);
    const posture = await tx.$queryRawUnsafe('SELECT current_user,current_database(),rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    const preserved = {};
    for (const table of ['Subject','IdentityAccount','ProviderConnection','Assignment','Resource','ResourceScope','Entitlement','User','Role','Permission','UserRole','LegacyUserBridge']) {
      preserved[table] = await tx.$queryRawUnsafe(`SELECT count(*)::int n,md5(coalesce(string_agg(to_jsonb(r)::text,'|' ORDER BY to_jsonb(r)::text),'')) digest FROM "${table}" r`);
    }
    return { branch:profiles[url.hostname],project:'hidden-leaf-91460552',environment:'CERTIFICATION_ONLY',exportedAt:new Date().toISOString(),posture,audits,preserved };
  }, {timeout:120000});
  const bytes = JSON.stringify(evidence,null,2);
  console.log(JSON.stringify({evidence,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}));
}
main().catch(()=>{console.error('SAFE_EVIDENCE_EXPORT_FAILED');process.exitCode=1;}).finally(()=>db.$disconnect());
