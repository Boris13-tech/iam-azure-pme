/* Isolated runner only. URL and generated password stay in process memory. */
const { PrismaClient } = require('@prisma/client');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const certUrl = process.env.LUXIA_RESOURCE_OWNER_URL;
const endpoint = certUrl && new URL(certUrl);
if (!endpoint || !['ep-dark-king-ah402c68.c-3.us-east-1.aws.neon.tech', 'ep-holy-forest-ah3ser8s.c-3.us-east-1.aws.neon.tech'].includes(endpoint.hostname) || !['/luxia_resources_cert', '/luxia_sod_cert', '/luxia_reviews_cert'].includes(endpoint.pathname)) {
  console.error('ISOLATED_RESOURCES_DB_REQUIRED'); process.exit(2);
}
const owner = new PrismaClient({ datasources: { db: { url: certUrl } } });
function run(label, bin, args, env) {
  const result = spawnSync(process.execPath, [path.join(process.cwd(), bin), ...args], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  // Never emit raw subprocess output: a Prisma error could include URL credentials.
  console.log(`${label}: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
  if (result.status !== 0) {
    const names = (result.stdout + result.stderr).split(/\r?\n/).filter(line => /^( FAIL |Error:|.*error TS\d)/.test(line));
    for (const line of names.filter(line => /^ FAIL /.test(line))) console.log(line.replace(/\x1B\[[0-9;]*m/g, '').slice(0, 300));
    console.log(`Safe failure classes: ${names.map(line => /TS\d+/.exec(line)?.[0] ?? (/FAIL/.test(line) ? 'TEST_FAILURE' : 'PROCESS_FAILURE')).join(',')}`);
    const output = result.stdout + result.stderr;
    const clean = output.replace(/\x1B\[[0-9;]*m/g, '');
    for (const location of clean.matchAll(/tests\/resources\/[A-Za-z0-9_.-]+\.test\.ts:\d+:\d+/g)) console.log(`Safe assertion location: ${location[0]}`);
    const numericAssertion = clean.match(/AssertionError: expected \d+ to be \d+/)?.[0];
    if (numericAssertion) console.log(numericAssertion);
    const lengthAssertion = clean.match(/to have a length of (\d+) but got (\d+)/);
    if (lengthAssertion) console.log(`Safe length assertion: expected=${lengthAssertion[1]}, actual=${lengthAssertion[2]}`);
    console.log(`Safe diagnostics: unique=${/Unique constraint|P2002/.test(output)}, foreignKey=${/Foreign key|P2003/.test(output)}, timeout=${/timed out|timeout/i.test(output)}, sodConflict=${/SOD_CONFLICT/.test(output)}`);
    throw new Error('CERTIFICATION_STEP_FAILED');
  }
}
async function main() {
  const migrationEnv = { ...process.env, DATABASE_URL: certUrl, DATABASE_MIGRATION_URL: certUrl };
  run('Migrations', 'node_modules/prisma/build/index.js', ['migrate', 'deploy'], migrationEnv);
  const password = randomBytes(32).toString('hex');
  const rows = await owner.$queryRawUnsafe("SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='app_user'");
  if (!rows.length) await owner.$executeRawUnsafe(`CREATE ROLE app_user LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
  else {
    if (rows[0].rolsuper || rows[0].rolbypassrls || rows[0].rolcreatedb || rows[0].rolcreaterole || rows[0].rolreplication) throw new Error('RUNTIME_ROLE_POSTURE_REVIEW_REQUIRED');
    await owner.$executeRawUnsafe(`ALTER ROLE app_user LOGIN PASSWORD '${password}'`);
  }
  console.log('Runtime posture: PASS');
  const memberships = await owner.$queryRawUnsafe("SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='app_user')");
  if (memberships[0].n !== 0) throw new Error('RUNTIME_ROLE_MEMBERSHIP_REVIEW_REQUIRED');
  await owner.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${endpoint.pathname.slice(1)} TO app_user`);
  await owner.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_user');
  // Existing CI suites need their existing tables. New production privileges must be separately approved.
  await owner.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user');
  await owner.$executeRawUnsafe('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user');
  await owner.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.resolve_session(TEXT) TO app_user');
  // Only the nested invoker helper needs runtime EXECUTE, not trigger entry points.
  await owner.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION public.luxia_sod_scope_contains(TEXT,TEXT,TEXT,TEXT) TO app_user');
  const runtime = new URL(certUrl);
  runtime.username = 'app_user'; runtime.password = password;
  runtime.hostname = endpoint.hostname.replace('.c-3.', '-pooler.c-3.');
  const env = { ...process.env, DATABASE_URL: runtime.toString(), DATABASE_MIGRATION_URL: certUrl, LUXIA_RESOURCE_RLS: 'true', NEXT_PUBLIC_APP_URL: 'http://localhost:3193', AUTHZ_MODE: 'native' };
  delete env.LUXIA_RESOURCE_OWNER_URL;
  if (process.env.LUXIA_RESOURCE_REMAINING !== 'true') {
    if (process.env.LUXIA_RESOURCE_PRIVILEGES_ONLY === 'true') run('SQL privilege PostgreSQL probes', 'node_modules/vitest/vitest.mjs', ['run', 'tests/resources/function-privileges.test.ts', 'tests/resources/sod-postgres.test.ts', '--no-file-parallelism', '--testTimeout=120000', '--hookTimeout=120000'], env);
    else if (process.env.LUXIA_RESOURCE_HTTP_ONLY === 'true') run('Persisted-session Resources/SoD/Reviews HTTP only', 'node_modules/vitest/vitest.mjs', ['run', 'tests/resources/postgres-rls.test.ts', '--testNamePattern=real HTTP APIs', '--testTimeout=120000', '--hookTimeout=120000'], env);
    else run('Resources PostgreSQL/RLS + unit/architecture', 'node_modules/vitest/vitest.mjs', ['run', 'tests/resources', '--no-file-parallelism', '--testTimeout=120000', '--hookTimeout=120000'], env);
  }
  if (process.env.LUXIA_RESOURCE_FULL === 'true') {
    if (process.env.LUXIA_RESOURCE_REMAINING !== 'true') run('Existing security', 'node_modules/vitest/vitest.mjs', ['run', 'tests/security', '--testTimeout=120000', '--hookTimeout=120000'], env);
    run('Provider contracts', 'node_modules/vitest/vitest.mjs', ['run', 'tests/provider-adapters', '--testTimeout=120000', '--hookTimeout=120000'], env);
    run('Identity', 'node_modules/vitest/vitest.mjs', ['run', 'tests/identity', '--testTimeout=120000', '--hookTimeout=120000'], env);
    run('Operations', 'node_modules/vitest/vitest.mjs', ['run', 'tests/operations', '--testTimeout=120000', '--hookTimeout=120000'], env);
    run('Operational certification', 'node_modules/tsx/dist/cli.mjs', ['scripts/certify-identity-v1.ts'], env);
    run('Cutover readiness', 'node_modules/tsx/dist/cli.mjs', ['scripts/generate-cutover-report.ts'], env);
    run('TypeScript', 'node_modules/typescript/bin/tsc', ['--noEmit'], env);
    run('Lint', 'node_modules/next/dist/bin/next', ['lint'], env);
    const buildEnv = { ...env }; delete buildEnv.DATABASE_MIGRATION_URL;
    run('Production build (local only)', 'node_modules/next/dist/bin/next', ['build'], buildEnv);
  }
  console.log('Production modified: NO');
}
main().catch(error => { console.error('ISOLATED_CERTIFICATION_FAILED — no raw errors emitted');
  const safe = /^[A-Z_]{3,80}$/.test(error.message) ? error.message : error.code ?? 'UNKNOWN';
  console.error(`Safe error code: ${safe}; SQLSTATE: ${/^[0-9A-Z]{5}$/.test(error.meta?.code ?? '') ? error.meta.code : 'NONE'}`); process.exitCode = 1;
}).finally(() => owner.$disconnect());
