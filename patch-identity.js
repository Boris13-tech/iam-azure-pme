const fs = require('fs');
const tests = [
  'tests/security/auth-context.test.ts',
  'tests/security/logout.test.ts',
  'tests/security/oidc-callback.test.ts',
  'tests/security/session-store.test.ts',
  'tests/cross-tenant-isolation.test.ts'
];
for (const f of tests) {
  if (fs.existsSync(f)) {
    let c = fs.readFileSync(f, 'utf8');
    c = c.replace(/organizationId: orgId,\s*subjectId/g, 'organizationId: orgId, tenantId, subjectId');
    c = c.replace(/organizationId: orgId,\s*name: "Entra[^\"]*"/g, 'organizationId: orgId, providerType: "MICROSOFT_ENTRA", externalScopeId: "scope", name: "Entra"');
    c = c.replace(/rawPrisma\.session\.deleteMany/g, 'adminPrisma.session.deleteMany');
    
    fs.writeFileSync(f, c);
    console.log('Fixed IdentityAccount in', f);
  }
}
