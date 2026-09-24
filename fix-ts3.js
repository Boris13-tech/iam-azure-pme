const fs = require('fs');
let f = 'tests/cross-tenant-isolation.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/name: "Entra B"/g, 'name: "Entra B", providerType: "MICROSOFT_ENTRA", externalScopeId: "scope_b"');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/createInputA\.tenant\.connect\.organizationId_id/g, 'createInputA.tenant.connect!.organizationId_id');
c = c.replace(/createInputB\.tenant\.connect\.organizationId_id/g, 'createInputB.tenant.connect!.organizationId_id');
fs.writeFileSync(f, c);
