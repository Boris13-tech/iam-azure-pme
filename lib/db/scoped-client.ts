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

  return rawPrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const modelsWithOrg = ['Tenant', 'ProviderConnection', 'Subject', 'IdentityAccount', 'Resource'];
          
          if (!modelsWithOrg.includes(model)) {
            return query(args);
          }

          // @ts-expect-error dynamic args
          args.where = args.where || {};
          
          const applyScopeToData = (data: any) => {
            if (!data) return;
            data.organizationId = scope.organizationId;
            if (scope.tenantId && ['Subject', 'Resource'].includes(model)) {
              data.tenantId = scope.tenantId;
            }
          };

          const applyScopeToWhere = (where: any) => {
            if (!where) return;
            where.organizationId = scope.organizationId;
            if (scope.tenantId && ['Subject', 'Resource'].includes(model)) {
              where.tenantId = scope.tenantId;
            }
          };

          if (['create'].includes(operation)) {
            // @ts-expect-error dynamic args
            applyScopeToData(args.data);
          } 
          else if (['createMany'].includes(operation)) {
            // @ts-expect-error dynamic args
            if (Array.isArray(args.data)) {
              // @ts-expect-error dynamic args
              args.data.forEach(applyScopeToData);
            } else {
              // @ts-expect-error dynamic args
              applyScopeToData(args.data);
            }
          }
          else if (['update', 'updateMany'].includes(operation)) {
            // @ts-expect-error dynamic args
            applyScopeToWhere(args.where);
            // @ts-expect-error dynamic args
            applyScopeToData(args.data);
          }
          else if (['upsert'].includes(operation)) {
            // @ts-expect-error dynamic args
            applyScopeToWhere(args.where);
            // @ts-expect-error dynamic args
            applyScopeToData(args.create);
            // @ts-expect-error dynamic args
            applyScopeToData(args.update);
          }
          else if (['delete', 'deleteMany'].includes(operation)) {
            // @ts-expect-error dynamic args
            applyScopeToWhere(args.where);
          }
          else if (['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy'].includes(operation)) {
            // @ts-expect-error dynamic args
            applyScopeToWhere(args.where);
          }
          
          return query(args);
        },
      },
    },
  });
}
