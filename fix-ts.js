const fs = require('fs');

let f = 'lib/auth/session-store.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(/\{ organizationId: ctx.organizationId, tenantId: ctx.tenantId, subjectId: ctx.subjectId, identityAccountId: ctx.identityAccountId \}/g, '{ organizationId: ctx.organizationId, tenantId: ctx.tenantId }');
c = c.replace(/\{ organizationId: session.organizationId, tenantId: session.tenantId, subjectId: session.subjectId, identityAccountId: session.identityAccountId \}/g, '{ organizationId: session.organizationId, tenantId: session.tenantId }');
c = c.replace(/const scope = \{\s*organizationId: sessionBootstrap.organizationId,\s*tenantId: sessionBootstrap.tenantId,\s*subjectId: sessionBootstrap.subjectId,\s*identityAccountId: sessionBootstrap.identityAccountId\s*\};/g, 'const scope = { organizationId: sessionBootstrap.organizationId, tenantId: sessionBootstrap.tenantId };');
c = c.replace(/\{ organizationId, tenantId, subjectId, identityAccountId: "system" \}/g, '{ organizationId, tenantId }');
fs.writeFileSync(f, c);

f = 'lib/auth/backfill-service.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/withTenantDb\(\s*\{ organizationId: ctx\.organizationId, tenantId: ctx\.tenantId, subjectId: "system" \}/g, 'withTenantDb({ organizationId: ctx.organizationId, tenantId: ctx.tenantId }');
c = c.replace(/const subjects = await withTenantDb/g, 'const subjects = await withTenantDb');
fs.writeFileSync(f, c);

f = 'lib/auth/reconciliation-service.ts';
c = fs.readFileSync(f, 'utf8');
c = c.replace(/withTenantDb\(\s*\{\s*organizationId,\s*tenantId,\s*subjectId: "system"\s*\}/g, 'withTenantDb({ organizationId, tenantId }');
fs.writeFileSync(f, c);
