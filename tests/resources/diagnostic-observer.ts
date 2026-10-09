import { PrismaClient } from '@prisma/client';
import { pendingDiagnosticSteps } from './diagnostic-step';

// Test-only, independent direct connection, read-only sampling, no SQL/parameters output.
export function createDiagnosticObserver(ownerUrl: string, runtimeUrl: string) {
  const owner = new URL(ownerUrl), runtime = new URL(runtimeUrl);
  if (runtime.hostname !== 'ep-solitary-wildflower-ahcqqg5r-pooler.c-3.us-east-1.aws.neon.tech' ||
      !['/luxia_reviews_cert','/luxia_resources_diag_awake01','/luxia_resources_diag_concurrency02','/luxia_resources_diag_global01','/luxia_resources_diag_ci02','/luxia_resources_diag_ci03'].includes(runtime.pathname) ||
      runtime.username !== 'app_user' || owner.hostname !== runtime.hostname.replace('-pooler.', '.') ||
      owner.pathname !== runtime.pathname || owner.username !== 'neondb_owner') throw new Error('DIAGNOSTIC_CLONE_ONLY');
  owner.searchParams.set('connection_limit','1');
  const db = new PrismaClient({datasources:{db:{url:owner.toString()}}});
  let flight: Promise<void> | undefined;
  let failures = 0;
  const sample = (phase: string) => {
    if (flight) return flight;
    flight = db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const activity = await tx.$queryRaw`SELECT pid,usename,state,wait_event_type,wait_event,
        xact_start,query_start,state_change,pg_blocking_pids(pid) AS blockers,md5(query) AS query_fingerprint,
        CASE WHEN query LIKE '%pg_advisory_xact_lock%' THEN 'ADVISORY_XACT_LOCK'
             WHEN query LIKE '%pg_advisory_lock(%' THEN 'ADVISORY_SESSION_LOCK'
             WHEN ltrim(query) ~* '^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK|SET) ' THEN upper(split_part(ltrim(query),' ',1))
             ELSE 'OTHER' END AS query_kind
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid`;
      const locks = await tx.$queryRaw`SELECT l.pid,l.locktype,l.mode,l.granted,count(*)::int n FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory'
        GROUP BY l.pid,l.locktype,l.mode,l.granted ORDER BY l.pid`;
      const counters = await tx.$queryRaw`SELECT deadlocks,numbackends,xact_commit,xact_rollback FROM pg_stat_database WHERE datname=current_database()`;
      console.log(JSON.stringify({diagnostic:'RESOURCE_DB_SAMPLE',phase,utc:new Date().toISOString(),activity,locks,counters,pendingSteps:pendingDiagnosticSteps()},
        (_key,value)=>typeof value==='bigint'?value.toString():value));
    },{timeout:10000,maxWait:5000}).catch(error=>{
      failures++;
      const code=typeof error.code==='string' && /^[A-Z0-9_]+$/.test(error.code)?error.code:'OBSERVER_FAILED';
      console.log(JSON.stringify({diagnostic:'RESOURCE_DB_SAMPLE_ERROR',phase,utc:new Date().toISOString(),code}));
    }).finally(()=>{flight=undefined;});
    return flight;
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  return { sample,
    async start() { await sample('START'); timer=setInterval(()=>void sample('PERIODIC'),2000); timer.unref(); },
    async stop() { if(timer)clearInterval(timer); if(flight)await flight; await sample('CLEANUP'); await db.$disconnect();
      if(failures)throw new Error('DIAGNOSTIC_OBSERVER_FAILED'); }
  };
}
