// Administrative setup confined to the explicit ephemeral certification database.
const { PrismaClient } = require('@prisma/client');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
async function main() {
  const url = new URL(process.env.DATABASE_MIGRATION_URL);
  if (url.hostname !== 'ep-shy-shape-ah9l8gm8.c-3.us-east-1.aws.neon.tech' || url.pathname !== '/luxia_provider_cert') throw new Error('SCOPE');
  const admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const password = randomBytes(32).toString('hex');
  try {
    const existing = await admin.$queryRawUnsafe("SELECT rolname FROM pg_roles WHERE rolname='app_user'");
    if (!existing.length) throw new Error('POSTURE');
    const role = await admin.$queryRawUnsafe("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='app_user'");
    if (Object.values(role[0]).some(Boolean)) throw new Error('POSTURE');
    await admin.$executeRawUnsafe(`ALTER ROLE app_user LOGIN PASSWORD '${password}'`);
    const memberships = await admin.$queryRawUnsafe("SELECT parent.rolname FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member WHERE member.rolname='app_user'");
    if (memberships.length) throw new Error('MEMBERSHIPS');
    const owned = await admin.$queryRawUnsafe("SELECT count(*)::int n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='app_user')");
    if (owned[0].n) throw new Error('OWNERSHIP');
    for (const sql of [
      'GRANT CONNECT ON DATABASE luxia_provider_cert TO app_user',
      'GRANT USAGE ON SCHEMA public TO app_user',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user',
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user',
      'GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user',
    ]) await admin.$executeRawUnsafe(sql);
    const tables = await admin.$queryRawUnsafe(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('ProviderConnectionTenantScope','ProviderSyncRun','ProviderIdentityCollision','CanonicalAdminAuditEvent')`);
    if (tables.length !== 4 || tables.some(t => !t.relrowsecurity || !t.relforcerowsecurity)) throw new Error('RLS');
    const history = await admin.$queryRawUnsafe('SELECT count(*)::int n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL');
    console.log(`Certification applied migrations: ${history[0].n}; scoped tables forced RLS: 4/4`);
    url.username = 'app_user'; url.password = password;
    url.hostname = 'ep-shy-shape-ah9l8gm8-pooler.c-3.us-east-1.aws.neon.tech';
    const runtime = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const rows = await runtime.$queryRawUnsafe("SELECT current_user,rolsuper,rolbypassrls,has_function_privilege(current_user,'resolve_session(text)','EXECUTE') allowed FROM pg_roles WHERE rolname=current_user");
      if (rows[0].current_user !== 'app_user' || rows[0].rolsuper || rows[0].rolbypassrls || !rows[0].allowed) throw new Error('POSTURE');
      console.log('Runtime posture: PASS; resolve_session execute: PASS; no ownership/memberships');
    } finally { await runtime.$disconnect(); }
    const secret = spawnSync('gh', ['secret','set','LUXIA_CERT_DATABASE_URL','--env','provider-certification','--repo','Boris13-tech/iam-azure-pme'], { input: url.toString(), encoding:'utf8' });
    if (secret.status !== 0) throw new Error('STORE');
    const tests = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs','run','tests/security/provider-management-rls.test.ts','tests/certification/provider-denial-audit-rls.test.ts','--testTimeout=30000','--hookTimeout=30000'], {
      env: { ...process.env, DATABASE_URL:url.toString() }, encoding:'utf8', timeout:180000,
    });
    console.log(`Certification provider RLS tests: ${tests.status === 0 ? 'PASS' : 'FAIL'} (raw output withheld)`);
    if (tests.status !== 0) {
      const diagnostic = (tests.stdout + tests.stderr).replace(/\u001b\[[0-9;]*m/g,'');
      for (const marker of ['timed out','Authentication failed','permission denied','AssertionError','Foreign key constraint','does not exist']) {
        if (diagnostic.includes(marker)) console.log(`Safe test diagnostic: ${marker}`);
      }
    }
    if (tests.status !== 0) throw new Error('TESTS');
    if (process.env.LUXIA_CERT_BUILD === 'true') {
      const buildEnv = { ...process.env, DATABASE_URL:url.toString() };
      delete buildEnv.DATABASE_MIGRATION_URL;
      const build = spawnSync(process.execPath, ['node_modules/next/dist/bin/next','build'], { env:buildEnv, encoding:'utf8', timeout:300000 });
      console.log(`Certification application build: ${build.status === 0 ? 'PASS' : 'FAIL'} (raw output withheld)`);
      if (build.status !== 0) throw new Error('BUILD');
    }
  } finally { await admin.$disconnect(); }
}
main().catch(error => {
  const safe = ['SCOPE','MEMBERSHIPS','OWNERSHIP','RLS','POSTURE','STORE','TESTS','BUILD'];
  console.error(`CERTIFICATION_SETUP_FAILED: ${safe.includes(error.message) ? error.message : /^P\d{4}$/.test(error.code || '') ? error.code : 'INTERNAL'}; SQLSTATE=${/^[0-9A-Z]{5}$/.test(error.meta?.code || '') ? error.meta.code : 'WITHHELD'} — sensitive diagnostics withheld`);
  process.exitCode=1;
});
