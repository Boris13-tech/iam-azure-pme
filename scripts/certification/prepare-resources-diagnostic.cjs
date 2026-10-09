const { PrismaClient } = require('@prisma/client');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
let u;
try {
u = new URL(process.env.DATABASE_MIGRATION_URL);
assert.equal(u.hostname,'ep-still-morning-ah7s0usw.c-3.us-east-1.aws.neon.tech');
assert.equal(u.username,'neondb_owner');
assert.ok(['/luxia_resources_diag_awake01','/luxia_resources_diag_concurrency02','/luxia_resources_diag_global01','/luxia_resources_diag_ci02','/luxia_resources_diag_ci03'].includes(u.pathname));
} catch { console.error('DIAGNOSTIC_ENDPOINT_DENIED');process.exit(1); }
const name = u.pathname.slice(1);
const migration = spawnSync(process.execPath,[path.resolve('node_modules/prisma/build/index.js'),'migrate','deploy'],
  {env:{...process.env,DATABASE_URL:u.toString()},windowsHide:true,encoding:'utf8'});
if (migration.status!==0) { console.error('DIAGNOSTIC_SCHEMA_FAILED');process.exit(1); }
const db = new PrismaClient({datasources:{db:{url:u.toString()}}});
db.$transaction(async tx=>{
  for(const sql of [
    `GRANT CONNECT ON DATABASE "${name}" TO app_user`,
    'GRANT USAGE ON SCHEMA public TO app_user',
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_user',
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user',
    'GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user',
    'GRANT EXECUTE ON FUNCTION public.luxia_sod_scope_contains(TEXT,TEXT,TEXT,TEXT) TO app_user'])await tx.$executeRawUnsafe(sql);
},{timeout:120000}).then(()=>console.log('FRESH_DIAGNOSTIC_SCHEMA_READY'))
  .catch(error=>{console.error('DIAGNOSTIC_SCHEMA_FAILED',JSON.stringify({code:error.code,sqlstate:error.meta?.code}));process.exitCode=1;})
  .finally(()=>db.$disconnect());
