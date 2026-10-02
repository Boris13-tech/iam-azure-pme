const fs = require('fs');

let f = 'lib/auth/backfill-service.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/subjectId:\s*"system",?/g, '');
c = c.replace(/const subjects = \(?await withTenantDb\([\s\S]*?tx\.subject\.findMany\(\{[\s\S]*?\}\)\n?\s*\)\)?(\s*as\s*any\[\])?;/g, 'const subjects = (await withTenantDb({ organizationId: ctx.organizationId, tenantId: ctx.tenantId }, async (tx) => tx.subject.findMany({ where: { organizationId: ctx.organizationId, type: "HUMAN" }, include: { legacyBridge: true } }))) as any[];');
fs.writeFileSync(f, c);

f = 'lib/auth/reconciliation-service.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/subjectId:\s*"system",?/g, '');
c = c.replace(/const subjects = \(?await withTenantDb\([\s\S]*?tx\.subject\.findMany\(\{[\s\S]*?\}\)\n?\s*\)\)?(\s*as\s*any\[\])?;/g, 'const subjects = (await withTenantDb({ organizationId, tenantId }, async (tx) => tx.subject.findMany({ where: { organizationId, type: "HUMAN" }, include: { legacyBridge: true, Assignment: { include: { entitlement: true } } } }))) as any[];');
c = c.replace(/assignments\.filter\(\(a\) =>/g, 'assignments.filter((a: any) =>');
c = c.replace(/some\(\(ur\) =>/g, 'some((ur: any) =>');
fs.writeFileSync(f, c);

f = 'tests/cross-tenant-isolation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/externalObjectId: "subject2-oid" \}/g, 'externalObjectId: "subject2-oid", tenantId: tenantB.id }');
fs.writeFileSync(f, c);

f = 'tests/security/rollback-drill.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/import \{ authorize, recordObservation \} from "\.\.\/\.\.\/lib\/auth\/authorization-gateway";/g, 'import { authorize } from "../../lib/auth/authorization-gateway";');
fs.writeFileSync(f, c);

f = 'tests/security/entitlements-foundation.test.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/connect!: \{/g, 'connect: {');
fs.writeFileSync(f, c);
