const fs = require('fs');

let f = 'app/auth/callback/route.ts';
let c = fs.readFileSync(f, 'utf8');

if (!c.includes('withTenantDb')) {
  c = c.replace('import { rawPrisma } from "../../../lib/db/raw-prisma";', 'import { rawPrisma } from "../../../lib/db/raw-prisma";\nimport { withTenantDb } from "../../../lib/db/scoped-client";');
}

c = c.replace(/const identityAccount = await rawPrisma\.identityAccount\.findUnique\(\{[\s\S]*?\}\);/m, 
`const identityAccount = await withTenantDb(
      { organizationId: transaction.expectedOrganizationId, tenantId: transaction.expectedTenantId },
      async (tx) => tx.identityAccount.findUnique({
        where: {
          organizationId_providerConnectionId_externalObjectId: {
            organizationId: transaction.expectedOrganizationId,
            providerConnectionId: provider.id,
            externalObjectId: oid,
          }
        },
        include: {
          subject: true
        }
      })
    );`);

fs.writeFileSync(f, c);
