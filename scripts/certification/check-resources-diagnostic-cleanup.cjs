// Read-only post-process proof. Execute only after all owned test processes exit.
const {PrismaClient}=require('@prisma/client');
const assert=require('node:assert/strict');
let url;
try {
url=new URL(process.env.DATABASE_MIGRATION_URL);
assert.equal(url.hostname,'ep-weathered-grass-ah5vrehj.c-3.us-east-1.aws.neon.tech');
assert.equal(url.pathname,'/neondb');assert.equal(url.username,'neondb_owner');
} catch { console.error('DIAGNOSTIC_ENDPOINT_DENIED');process.exit(1); }
url.searchParams.set('connection_limit','1');
const db=new PrismaClient({datasources:{db:{url:url.toString()}}});
db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const databases=['neondb','luxia_reviews_cert','luxia_resources_diag_awake01','luxia_resources_diag_concurrency02','luxia_resources_diag_global01','luxia_resources_diag_ci02','luxia_resources_diag_ci03','luxia_resources_diag_ci04','luxia_resources_diag_ci05'];
  const activity=await tx.$queryRawUnsafe(`SELECT datname,usename,state,count(*)::int n,
    count(*) FILTER(WHERE xact_start IS NOT NULL)::int open_transactions,
    count(*) FILTER(WHERE cardinality(pg_blocking_pids(pid))>0)::int blocked
    FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND pid<>pg_backend_pid()
    GROUP BY datname,usename,state ORDER BY datname,usename,state`,databases);
  const locks=await tx.$queryRawUnsafe(`SELECT a.datname,count(*)::int n FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=ANY($1::text[]) AND l.locktype='advisory'
    GROUP BY a.datname`,databases);
  const counters=await tx.$queryRawUnsafe('SELECT datname,deadlocks,numbackends FROM pg_stat_database WHERE datname=ANY($1::text[]) ORDER BY datname',databases);
  const role=await tx.$queryRawUnsafe("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='app_user'");
  const ownership=await tx.$queryRawUnsafe("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname='app_user')");
  assert.deepEqual(role,[{rolname:'app_user',rolsuper:false,rolbypassrls:false}]);assert.equal(ownership[0].n,0);
  assert.ok(activity.every(r=>r.state==='idle'&&r.open_transactions===0&&r.blocked===0&&r.usename==='app_user'),'POST_TEST_CONNECTION_OR_TRANSACTION_LEFT_OPEN');
  assert.equal(locks.length,0,'POST_TEST_ADVISORY_LOCK_LEFT_OPEN');
  assert.ok(counters.every(r=>BigInt(r.deadlocks)===0n),'DATABASE_DEADLOCK_OBSERVED');
  return {environment:'CERTIFICATION_ONLY',branch:'br-misty-sun-ahs4b46j',utc:new Date().toISOString(),activity,locks,counters,role,ownership,result:'PASS',idlePooledBackends:'EXPECTED_SERVER_POOL_REUSE'};
},{timeout:30000}).then(proof=>console.log(JSON.stringify(proof,(_k,v)=>typeof v==='bigint'?v.toString():v)))
  .catch(()=>{console.error('DIAGNOSTIC_CLEANUP_PROOF_FAILED');process.exitCode=1;}).finally(()=>db.$disconnect());
