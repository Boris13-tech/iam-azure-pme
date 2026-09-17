import { rawPrisma } from "../db/raw-prisma";
import { withTenantDb } from "../db/scoped-client";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";
import { mapLegacyPermission } from "./legacy-permission-map";
import { Prisma } from "@prisma/client";

export interface BackfillOptions {
  organizationId: string;
  tenantId: string;
  mode: "dry-run" | "apply";
}

export interface BackfillReport {
  organizationId: string;
  tenantId: string;
  mode: string;
  metrics: {
    validatedBridges: number;
    legacyUsers: number;
    rolesDiscovered: number;
    permissionsDiscovered: number;
    entitlementsToCreate: number;
    assignmentsToCreate: number;
    administrateurExpansions: number;
    unmappedPermissions: number;
    invalidBridges: number;
    conflicts: number;
  };
  unmappedPermissionKeys: string[];
}

export async function runLegacyRbacBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const { organizationId, tenantId, mode } = options;

  const report: BackfillReport = {
    organizationId,
    tenantId,
    mode,
    metrics: {
      validatedBridges: 0,
      legacyUsers: 0,
      rolesDiscovered: 0,
      permissionsDiscovered: 0,
      entitlementsToCreate: 0,
      assignmentsToCreate: 0,
      administrateurExpansions: 0,
      unmappedPermissions: 0,
      invalidBridges: 0,
      conflicts: 0,
    },
    unmappedPermissionKeys: [],
  };

  // 1. Fetch Subjects in this tenant that have a VALIDATED LegacyBridge
  const subjects = await withTenantDb({ organizationId, tenantId, subjectId: "system", type: "SYSTEM" as any }, async (tx) => tx.subject.findMany({
    where: {
      organizationId,
      tenantId,
      legacyBridge: {
        status: "VALIDATED"
      }
    },
    include: {
      legacyBridge: {
        include: {
          legacyUser: {
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: {
                        include: {
                          permission: true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }));

  if (subjects.length === 0) {
    return report; // Nothing to backfill in this tenant
  }

  const seenRoles = new Set<string>();
  const seenPermissions = new Set<string>();
  
  // Track what needs to be created
  // Entitlement definitions we need to ensure exist
  const entitlementsToEnsure = new Map<CatalogEntitlement, { action: string, resource: string }>();
  // Assignments to create: SubjectID -> Array of { entitlementKey, roleId }
  const assignmentsToCreate = new Map<string, { key: CatalogEntitlement, roleId: string }[]>();

  for (const subject of subjects) {
    const bridge = subject.legacyBridge;
    if (!bridge || !bridge.legacyUser) {
      report.metrics.invalidBridges++;
      continue;
    }

    report.metrics.validatedBridges++;
    report.metrics.legacyUsers++;

    const user = bridge.legacyUser;
    
    // Track required assignments for this subject
    const subjectAssignments: { key: CatalogEntitlement, roleId: string }[] = [];

    for (const userRole of user.roles) {
      const role = userRole.role;
      seenRoles.add(role.name);

      if (role.name === "Administrateur") {
        // Explode into full V1 catalog
        report.metrics.administrateurExpansions++;
        for (const catKey of ENTITLEMENT_CATALOG_V1) {
          const [res, act] = catKey.split("."); // simplistic parsing for resource/action
          entitlementsToEnsure.set(catKey, { resource: res || catKey, action: act || "all" });
          subjectAssignments.push({ key: catKey, roleId: role.id });
        }
        continue;
      }

      // Normal permissions
      for (const rp of role.permissions) {
        const p = rp.permission;
        seenPermissions.add(`${p.action}:${p.resource}`);

        const mappedKey = mapLegacyPermission(p.resource, p.action);
        if (!mappedKey) {
          report.metrics.unmappedPermissions++;
          report.unmappedPermissionKeys.push(`${p.action}:${p.resource}`);
        } else {
          entitlementsToEnsure.set(mappedKey, { action: p.action, resource: p.resource });
          subjectAssignments.push({ key: mappedKey, roleId: role.id });
        }
      }
    }

    assignmentsToCreate.set(subject.id, subjectAssignments);
  }

  report.metrics.rolesDiscovered = seenRoles.size;
  report.metrics.permissionsDiscovered = seenPermissions.size;
  report.metrics.entitlementsToCreate = entitlementsToEnsure.size;
  
  // Count total assignments (ignoring duplicates within the same role for the same user)
  let totalAssignments = 0;
  for (const [subjId, assignments] of Array.from(assignmentsToCreate.entries())) {
    // deduplicate assignments per subject and role (user can't get same assignment twice from same role)
    const uniqueAssignments = new Set(assignments.map((a: any) => `${a.key}-${a.roleId}`));
    totalAssignments += uniqueAssignments.size;
  }
  report.metrics.assignmentsToCreate = totalAssignments;

  // FAIL CLOSED if any unmapped permissions exist
  if (report.metrics.unmappedPermissions > 0) {
    throw new Error(`Backfill failed: ${report.metrics.unmappedPermissions} unmapped permissions discovered. Check report.unmappedPermissionKeys`);
  }

  if (mode === "dry-run") {
    return report;
  }

  // APPLY MODE
  const scope = { organizationId, tenantId };
  await withTenantDb(scope, async (tx) => {
    
    // 1. Ensure all Entitlements exist
    const entitlementKeyToId = new Map<string, string>();
    for (const [key, details] of Array.from(entitlementsToEnsure.entries())) {
      // Find or create
      let ent = await tx.entitlement.findUnique({
        where: {
          organizationId_tenantId_key: {
            organizationId,
            tenantId,
            key
          }
        }
      });
      
      if (!ent) {
        ent = await tx.entitlement.create({
          data: {
            organizationId,
            tenantId,
            key,
            action: details.action,
            resource: details.resource,
            description: `Migrated from legacy: ${key}`
          }
        });
      }
      entitlementKeyToId.set(key, ent.id);
    }

    // 2. Create Assignments
    for (const [subjectId, assignments] of Array.from(assignmentsToCreate.entries())) {
      // Deduplicate by key + roleId
      const uniqueAssignments = Array.from(
        new Map(assignments.map((a: any) => [`${a.key}-${a.roleId}`, a])).values()
      );

      for (const assignment of uniqueAssignments as any[]) {
        const entitlementId = entitlementKeyToId.get(assignment.key);
        if (!entitlementId) continue;

        try {
          // Because of the partial index on ACTIVE grants, we must catch conflicts
          // Prisma's createMany with skipDuplicates might skip everything if the composite index fails.
          // Since we might have REVOKED grants in the future, upsert or catch is better.
          // For the initial backfill, create is fine with a catch for duplicates.
          await tx.assignment.create({
            data: {
              organizationId,
              tenantId,
              subjectId,
              entitlementId,
              source: "LEGACY_ROLE",
              sourceRef: assignment.roleId,
              status: "ACTIVE"
            }
          });
        } catch (error: any) {
          // Ignore unique constraint violations (P2002) for the partial index
          if (error.code === 'P2002') {
            report.metrics.conflicts++;
          } else {
            throw error;
          }
        }
      }
    }
  });

  return report;
}
