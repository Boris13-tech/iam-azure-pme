/* Clone-only operator ceremony. Runtime URL is injected in memory, never printed. */
const { spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');
function stop(code) { console.error(code); process.exit(2); }
let url;
try { url = new URL(process.env.DATABASE_URL); } catch { stop('CERTIFICATION_RUNTIME_URL_REQUIRED'); }
if (url.protocol !== 'postgresql:' || url.hostname !== 'ep-delicate-bar-ahz7cosb-pooler.c-3.us-east-1.aws.neon.tech' ||
    url.pathname !== '/neondb' || url.username !== 'app_user' ||
    process.env.LUXIA_BOOTSTRAP_BRANCH !== 'br-flat-dream-ahgvk9x6' ||
    process.env.LUXIA_BOOTSTRAP_ENVIRONMENT !== 'CERTIFICATION_ONLY') stop('EXACT_CERTIFICATION_CLONE_REQUIRED');
if (Date.now() < Date.parse('2026-10-08T03:00:00Z') || Date.now() >= Date.parse('2026-10-08T04:00:00Z')) stop('APPROVAL_WINDOW_CLOSED');
const env = { ...process.env, LUXIA_APPROVED_BOOTSTRAP_RLS: 'true', AUTHZ_MODE: 'native' };
delete env.DATABASE_MIGRATION_URL;
delete env.LUXIA_RESOURCE_OWNER_URL;
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
console.log(`Certification SHA: ${sha}`);
console.log(`Certification started UTC: ${new Date().toISOString()}`);
const result = spawnSync(process.execPath, [path.join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run',
  'tests/resources/bootstrap-certification.test.ts', '--no-file-parallelism', '--testTimeout=240000', '--hookTimeout=120000'],
  { env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
// Raw child output is kept private: Prisma diagnostics can carry credentials.
const output = (result.stdout ?? '') + (result.stderr ?? '');
console.log(`Approved clone bootstrap certification: ${result.status === 0 ? 'PASS' : 'FAIL'}`);
if (result.status !== 0) {
  const clean = output.replace(/\x1B\[[0-9;]*m/g, '');
  for (const match of clean.matchAll(/bootstrap-certification\.test\.ts:\d+:\d+/g)) console.log(`Safe assertion location: ${match[0]}`);
  const numeric = clean.match(/AssertionError: expected \d+ to be \d+/)?.[0];
  if (numeric) console.log(numeric);
  console.log(`Safe diagnostics: timeout=${/timed out|timeout/i.test(clean)}, foreignKey=${/P2003|foreign key/i.test(clean)}, metadata=${/metadata/i.test(clean)}, window=${/APPROVAL_WINDOW_CLOSED/.test(clean)}`);
}
console.log('Production mutations: NONE');
process.exitCode = result.status === 0 ? 0 : 1;
