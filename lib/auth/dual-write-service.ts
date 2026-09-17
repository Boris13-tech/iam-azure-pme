import { withTenantDb } from "../db/scoped-client";
import { AuthContext } from "./authorization-engine";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement, LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 } from "./entitlements-catalog";
import { mapLegacyPermission } from "./legacy-permission-map";

export async function dualWriteUpdateUserRole(auth: AuthContext, legacyUserId: string, roleId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Legacy Write
    await tx.userRole.deleteMany({
      where: { userId: legacyUserId }
    });
    
    await tx.userRole.create({
      data: { userId: legacyUserId, roleId: roleId }
    });

    // 2. Native Write
    await syncNativeAssignmentsForUser(auth, legacyUserId, roleId, tx);
  });
}


export async function dualWriteRevokeUserRole(auth: AuthContext, legacyUserId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Legacy Write
    await tx.userRole.deleteMany({
      where: { userId: legacyUserId }
    });
    
    // 2. Native Write (sync with no role)
    await syncNativeAssignmentsForUser(auth, legacyUserId, '', tx);
  });
}

export async function dualWriteCreateRole(auth: AuthContext, name: string, description: string, permissions: string[]) {
  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");
}

export async function dualWriteUpdateRolePermissions(auth: AuthContext, roleId: string, name: string, description: string, permissions: string[]) {
  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");
}

export async function dualWriteDeleteRole(auth: AuthContext, roleId: string) {
  throw new Error("Global role definitions are frozen during Phase 5E/5F cutover. Mutation rejected.");
}

async function syncNativeAssignmentsForUser(auth: AuthContext, legacyUserId: string, currentRoleId: string, tx: any) {
  const bridge = await tx.legacyUserBridge.findFirst({
    where: {
      legacyUserId: legacyUserId,
      organizationId: auth.organizationId,
      status: "VALIDATED"
    },
    include: { subject: true }
  });

  if (!bridge || !bridge.subject) return;

  const subjectId = bridge.subject.id;

  // Revoke old assignments from any LEGACY_ROLE
  await tx.assignment.updateMany({
    where: {
      organizationId: auth.organizationId,
      tenantId: auth.tenantId,
      subjectId: subjectId,
      source: "LEGACY_ROLE",
      status: "ACTIVE"
    },
    data: {
      status: "REVOKED",
      validUntil: new Date()
    }
  });

  // Get the new role with permissions
  const role = await tx.role.findUnique({
    where: { id: currentRoleId },
    include: { permissions: { include: { permission: true } } }
  });

  if (!role) return;

  const keysToGrant = new Set<CatalogEntitlement>();

  if (role.name === "Administrateur") {
    LEGACY_ADMIN_ENTITLEMENT_KEYS_V1.forEach(k => keysToGrant.add(k as CatalogEntitlement));
  } else {
    for (const rp of role.permissions) {
      const p = rp.permission;
      const mapped = mapLegacyPermission(p.resource, p.action);
      if (mapped) keysToGrant.add(mapped);
    }
  }

  // Ensure Entitlements exist and Create Assignments
  for (const key of Array.from(keysToGrant)) {
    const [resource, action] = key.split(".");
    
    // Ensure entitlement
    let entitlement = await tx.entitlement.findFirst({
      where: { organizationId: auth.organizationId, tenantId: auth.tenantId, key }
    });

    if (!entitlement) {
      entitlement = await tx.entitlement.create({
        data: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          key: key,
          description: `Legacy migrated: ${key}`,
          action: action || "all",
          resource: resource || key
        }
      });
    }

    // Create Assignment
    await tx.assignment.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        subjectId: subjectId,
        entitlementId: entitlement.id,
        source: "LEGACY_ROLE",
        sourceRef: role.id,
        status: "ACTIVE",
        validFrom: new Date()
      }
    });
  }
}
