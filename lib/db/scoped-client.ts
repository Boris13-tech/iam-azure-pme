import { rawPrisma } from "./raw-prisma";

export type DataScope = {
  organizationId: string;
  tenantId?: string;
};

/**
 * Creates a Tenant-aware Prisma client that automatically injects data boundaries.
 */
export function createScopedDb(scope: DataScope) {
  if (!scope.organizationId) {
    throw new Error("organizationId is mandatory for the Tenant-aware Repository.");
  }

  // Using Prisma Client Extensions to automatically append organizationId
  // Note: For a fully strict RLS-like enforcement at the Prisma layer, 
  // query extensions override the default behavior.
  return rawPrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Add basic filtering based on the scope for models that have organizationId
          // This is a simplified version. A robust version would introspect Prisma models.
          const modelsWithOrg = ['Organization', 'Tenant', 'ProviderConnection', 'Subject', 'IdentityAccount', 'Resource'];
          
          if (modelsWithOrg.includes(model)) {
            // @ts-ignore
            args.where = { ...(args.where || {}), organizationId: scope.organizationId };
            
            if (scope.tenantId && ['Subject', 'Resource'].includes(model)) {
               // @ts-ignore
               args.where = { ...args.where, tenantId: scope.tenantId };
            }
          }
          
          return query(args);
        },
      },
    },
  });
}
