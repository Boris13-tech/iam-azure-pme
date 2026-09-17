const fs = require('fs');
const path = require('path');
const tests = [
  'tests/security/auth-context.test.ts',
  'tests/security/logout.test.ts',
  'tests/security/oidc-callback.test.ts',
  'tests/security/session-store.test.ts',
  'tests/security/tenant-boundaries.test.ts',
  'tests/security/dual-write-ghost-grants.test.ts',
  'tests/security/backfill-idempotency.test.ts',
  'tests/cross-tenant-isolation.test.ts'
];

for (const f of tests) {
  if (!fs.existsSync(f)) {
      console.log('Skipping', f);
      continue;
  }
  let c = fs.readFileSync(f, 'utf8');

  // Add import if not present
  if (!c.includes('adminPrisma')) {
    const depth = f.split('/').length - 1;
    const rel = depth === 2 ? '../../' : '../';
    c = `import { adminPrisma } from "${rel}helpers/admin-prisma";\n` + c;
  }

  // Replace rawPrisma setup logic with adminPrisma
  c = c.replace(/rawPrisma\.organization\.(create|delete)/g, 'adminPrisma.organization.$1');
  c = c.replace(/rawPrisma\.tenant\.(create|delete)/g, 'adminPrisma.tenant.$1');
  c = c.replace(/rawPrisma\.subject\.(create|delete)/g, 'adminPrisma.subject.$1');
  c = c.replace(/rawPrisma\.identityAccount\.(create|delete)/g, 'adminPrisma.identityAccount.$1');
  c = c.replace(/rawPrisma\.providerConnection\.(create|delete)/g, 'adminPrisma.providerConnection.$1');
  c = c.replace(/rawPrisma\.legacyUserBridge\.(create|delete)/g, 'adminPrisma.legacyUserBridge.$1');
  c = c.replace(/rawPrisma\.role\.(create|delete)/g, 'adminPrisma.role.$1');
  c = c.replace(/rawPrisma\.permission\.(create|delete)/g, 'adminPrisma.permission.$1');
  c = c.replace(/rawPrisma\.rolePermission\.(createMany|deleteMany)/g, 'adminPrisma.rolePermission.$1');
  c = c.replace(/rawPrisma\.user\.(create|delete)/g, 'adminPrisma.user.$1');
  
  // Clean up undefined filtering issue in tenant-boundaries
  if (f.includes('tenant-boundaries.test.ts')) {
    c = c.replace(/const orgIds = \[orgA, orgB\];/g, 'const orgIds = [orgA, orgB].filter((id): id is string => Boolean(id));');
    c = c.replace(/const orgIds = \[orgA, orgB\]\.filter\(Boolean\);/g, 'const orgIds = [orgA, orgB].filter((id): id is string => Boolean(id));');
  }

  // Specific fix for backfill-idempotency.test.ts
  if (f.includes('backfill-idempotency.test.ts')) {
    // Remove old props from Organization create
    c = c.replace(/providerType:\s*"AZURE_AD",\s*externalScopeId:\s*"tenant-123",?\s*/g, '');
    
    // Insert ProviderConnection create right after Organization create
    if (!c.includes('adminPrisma.providerConnection.create')) {
        const orgCreate = 'await adminPrisma.organization.create({ data: { id: orgId, name: "Test Org" } });';
        const replaceWith = `${orgCreate}\n    await adminPrisma.providerConnection.create({ data: { organizationId: orgId, providerType: "MICROSOFT_ENTRA", externalScopeId: "tenant-123", name: "Entra" } });`;
        c = c.replace(orgCreate, replaceWith);
    }
  }

  // Same ProviderConnection issue in cross-tenant-isolation, session-store, oidc-callback, etc.
  // Actually, any test trying to create an IdentityAccount will need a ProviderConnection.
  // Let's globally find Organization creations that had AZURE_AD and fix them.
  c = c.replace(/providerType:\s*"(AZURE_AD|MICROSOFT_ENTRA)",\s*externalScopeId:\s*"[^"]+",?\s*/g, '');

  fs.writeFileSync(f, c);
  console.log('Fixed', f);
}
