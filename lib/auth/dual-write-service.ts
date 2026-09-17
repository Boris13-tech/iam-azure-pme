import { withTenantDb } from "../db/scoped-client";
import { AuthContext } from "./authorization-engine";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";
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

export async function dualWriteCreateRole(auth: AuthContext, name: string, description: string, permissions: string[]) {
  return await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Legacy Write
    const newRole = await tx.role.create({
      data: { name, description, isCustom: true }
    });

    if (permissions && Array.isArray(permissions)) {
      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await tx.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await tx.rolePermission.create({
          data: {
            roleId: newRole.id,
            permissionId: perm.id
          }
        });
      }
    }
    
    // 2. Native Write (No subjects have this role yet, so no assignments to sync, just return the role)
    return newRole;
  });
}

export async function dualWriteUpdateRolePermissions(auth: AuthContext, roleId: string, name: string, description: string, permissions: string[]) {
  return await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Legacy Write
    const role = await tx.role.update({
      where: { id: roleId },
      data: { name, description }
    });

    if (permissions && Array.isArray(permissions)) {
      await tx.rolePermission.deleteMany({
        where: { roleId: roleId }
      });

      for (const permStr of permissions) {
        const [action, resource] = permStr.split(":");
        const perm = await tx.permission.upsert({
          where: { action_resource: { action, resource } },
          update: {},
          create: { action, resource }
        });

        await tx.rolePermission.create({
          data: {
            roleId: role.id,
            permissionId: perm.id
          }
        });
      }
    }

    // 2. Native Write
    // We must sync assignments for all Subjects IN THIS TENANT that hold this role.
    const bridges = await tx.legacyUserBridge.findMany({
      where: {
        organizationId: auth.organizationId,
        status: "VALIDATED",
        legacyUser: {
          roles: {
            some: { roleId: roleId }
          }
        }
      },
      include: {
        subject: true
      }
    });

    for (const bridge of bridges) {
      if (bridge.subject) {
        await syncNativeAssignmentsForUser(auth, bridge.legacyUserId, roleId, tx);
      }
    }

    return role;
  });
}

export async function dualWriteDeleteRole(auth: AuthContext, roleId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 2. Native Write: Revoke all assignments sourced from this role in this tenant
    // (Doing Native first here since Legacy delete might cascade and we lose the ref, 
    // though we only need the roleId string).
    await tx.assignment.updateMany({
      where: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        source: "LEGACY_ROLE",
        sourceRef: roleId,
        status: "ACTIVE"
      },
      data: {
        status: "REVOKED",
        validUntil: new Date()
      }
    });

    // 1. Legacy Write
    await tx.role.delete({ where: { id: roleId } });
  });
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

  let keysToGrant = new Set<CatalogEntitlement>();

  if (role.name === "Administrateur") {
    ENTITLEMENT_CATALOG_V1.forEach(k => keysToGrant.add(k));
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
          key,
          name: key,
          description: `Auto-provisioned for ${key}`,
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
