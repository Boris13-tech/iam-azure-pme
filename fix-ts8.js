const fs = require('fs');

let f = 'tests/cross-tenant-isolation.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalObjectId: "subject2-oid" \}/g, 'externalObjectId: "subject2-oid", tenantId: tenantB.id }');
c = c.replace(/externalObjectId: "subject1-oid" \}/g, 'externalObjectId: "subject1-oid", tenantId: tenantA.id }');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/organizationId_id!/g, 'organizationId_id');
fs.writeFileSync(f, c);

f = 'tests/security/rollback-drill.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ authorize \} from "\.\.\/\.\.\/lib\/auth\/authorization-gateway";\nimport \{ recordObservation \} from "\.\.\/\.\.\/lib\/auth\/shadow-observer";/g, 'import { authorize } from "../../lib/auth/authorization-gateway";\nimport { recordObservation } from "../../lib/auth/shadow-observer";');
fs.writeFileSync(f, c);
