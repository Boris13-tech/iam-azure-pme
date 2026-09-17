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
          // Only inject for these tenant-aware models
          const modelsWithOrg = ['Tenant', 'ProviderConnection', 'Subject', 'IdentityAccount', 'Resource'];
          
          if (modelsWithOrg.includes(model)) {
            if (operation === 'create' || operation === 'createMany' || operation === 'update' || operation === 'updateMany') {
              // Inject into data for writes if applicable
              if (args.data) {
                // Not mutating data blindly because Prisma checks types, but enforcing scope on where for updates
                if (['update', 'updateMany', 'delete', 'deleteMany'].includes(operation)) {
                  // @ts-expect-error Prisma dynamic args typing is too strict
                  args.where = { ...(args.where || {}), organizationId: scope.organizationId };
                  if (scope.tenantId && ['Subject', 'Resource'].includes(model)) {
                    // @ts-expect-error Prisma dynamic args typing is too strict
                    args.where = { ...args.where, tenantId: scope.tenantId };
                  }
                }
              }
            }
            
            if (['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'].includes(operation)) {
              // @ts-expect-error Prisma dynamic args typing is too strict
              args.where = { ...(args.where || {}), organizationId: scope.organizationId };
              
              if (scope.tenantId && ['Subject', 'Resource'].includes(model)) {
                 // @ts-expect-error Prisma dynamic args typing is too strict
                 args.where = { ...args.where, tenantId: scope.tenantId };
              }
            }
          }
          
          return query(args);
        },
      },
    },
  });
}
