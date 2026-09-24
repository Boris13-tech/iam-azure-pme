const fs = require('fs');
let f = 'lib/auth/reconciliation-service.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/a =>/g, '(a: any) =>');
c = c.replace(/ur =>/g, '(ur: any) =>');
fs.writeFileSync(f, c);

f = 'tests/cross-tenant-isolation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalObjectId: "subject2-oid"/g, 'externalObjectId: "subject2-oid", tenantId: tenantB.id');
c = c.replace(/externalObjectId: "subject1-oid"/g, 'externalObjectId: "subject1-oid", tenantId: tenantA.id');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/organizationId_id/g, 'organizationId_id!');
fs.writeFileSync(f, c);
