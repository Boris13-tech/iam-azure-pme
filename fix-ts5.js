const fs = require('fs');

let f = 'lib/auth/backfill-service.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/ctx\.organizationId/g, 'organizationId');
c = c.replace(/ctx\.tenantId/g, 'tenantId');
fs.writeFileSync(f, c);

f = 'lib/auth/reconciliation-service.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/assignments\.filter\(\(a\) =>/g, 'assignments.filter((a: any) =>');
c = c.replace(/some\(\(ur\) =>/g, 'some((ur: any) =>');
fs.writeFileSync(f, c);

f = 'tests/cross-tenant-isolation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalObjectId: "subject1-oid" \}/g, 'externalObjectId: "subject1-oid", tenantId: tenantA.id }');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/createInputA\.tenant\.connect!\.organizationId_id/g, 'createInputA.tenant.connect!.organizationId_id!');
c = c.replace(/createInputB\.tenant\.connect!\.organizationId_id/g, 'createInputB.tenant.connect!.organizationId_id!');
fs.writeFileSync(f, c);

f = 'tests/security/rollback-drill.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ authorize \} from "\.\.\/\.\.\/lib\/auth\/authorization-gateway";/g, 'import { authorize } from "../../lib/auth/authorization-gateway";\nimport { recordObservation } from "../../lib/auth/shadow-observer";');
fs.writeFileSync(f, c);
