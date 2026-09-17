const fs = require('fs');

let f = 'tests/cross-tenant-isolation.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ adminPrisma \} from "\.\.\/helpers\/admin-prisma";/g, 'import { adminPrisma } from "./helpers/admin-prisma";');
c = c.replace(/name: "Entra"/g, 'name: "Entra", providerType: "MICROSOFT_ENTRA", externalScopeId: "scope"');
c = c.replace(/externalObjectId: "subject2-oid" \}/g, 'externalObjectId: "subject2-oid", tenantId: tenant2 }');
c = c.replace(/externalObjectId: "subject1-oid" \}/g, 'externalObjectId: "subject1-oid", tenantId: tenant1 }');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/organization: \{ connect: \{ id: orgA \} \},/g, '');
fs.writeFileSync(f, c);

f = 'tests/security/rollback-drill.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ authorize, recordObservation \} from "\.\.\/\.\.\/lib\/auth\/authorization-gateway";/g, 'import { authorize } from "../../lib/auth/authorization-gateway";');
fs.writeFileSync(f, c);
