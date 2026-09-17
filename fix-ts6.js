const fs = require('fs');

let f = 'lib/auth/reconciliation-service.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/assignments\.filter\(\(a\) =>/g, 'assignments.filter((a: any) =>');
c = c.replace(/some\(\(ur\) =>/g, 'some((ur: any) =>');
fs.writeFileSync(f, c);

f = 'tests/cross-tenant-isolation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalObjectId: "subject2-oid"\n\s*\}/g, 'externalObjectId: "subject2-oid",\n          tenantId: tenantB.id\n        }');
c = c.replace(/externalObjectId: "subject1-oid"\n\s*\}/g, 'externalObjectId: "subject1-oid",\n          tenantId: tenantA.id\n        }');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/createInputA\.tenant\.connect!\.organizationId_id!/g, '(createInputA.tenant.connect as any).organizationId_id');
c = c.replace(/createInputB\.tenant\.connect!\.organizationId_id!/g, '(createInputB.tenant.connect as any).organizationId_id');
fs.writeFileSync(f, c);

f = 'tests/security/rollback-drill.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ authorize \} from "\.\.\/\.\.\/lib\/auth\/authorization-gateway";\nimport \{ recordObservation \} from "\.\.\/\.\.\/lib\/auth\/shadow-observer";\nimport \{ recordObservation \} from "\.\.\/\.\.\/lib\/auth\/shadow-observer";/g, 'import { authorize } from "../../lib/auth/authorization-gateway";\nimport { recordObservation } from "../../lib/auth/shadow-observer";');
fs.writeFileSync(f, c);
