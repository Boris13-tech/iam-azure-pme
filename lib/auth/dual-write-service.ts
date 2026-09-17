import { withTenantDb } from "../db/scoped-client";
import { AuthContext } from "./authorization-engine";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement, LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 } from "./entitlements-catalog";
import { mapLegacyPermission } from "./legacy-permission-map";

export async function dualWriteUpdateUserRole(auth: AuthContext, legacyUserId: string, roleId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Transactional Serialization
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('dualwrite'), hashtext($1))`, legacyUserId);

    // 2. Validate isolation constraints BEFORE any mutation
    const bridge = await tx.legacyUserBridge.findFirst({
      where: { legacyUserId },
      include: { subject: true }
    });

    if (!bridge || bridge.status !== "VALIDATED") {
      throw new Error(`LegacyUserBridge invalid or not found for user ${legacyUserId}`);
    }
    if (bridge.organizationId !== auth.organizationId) {
      throw new Error(`Cross-organization boundary violation for legacy user ${legacyUserId}`);
    }
    if (!bridge.subject || bridge.subject.tenantId !== auth.tenantId) {
      throw new Error(`Cross-tenant boundary violation for legacy user ${legacyUserId}`);
    }

    // 3. Legacy Write
    await tx.userRole.deleteMany({
      where: { userId: legacyUserId }
    });
    
    await tx.userRole.create({
      data: { userId: legacyUserId, roleId: roleId }
    });

    // 4. Native Write
    await syncNativeAssignmentsForUser(auth, bridge.subject.id, roleId, tx);
  });
}

export async function dualWriteRevokeUserRole(auth: AuthContext, legacyUserId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Transactional Serialization
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('dualwrite'), hashtext($1))`, legacyUserId);

    // 2. Validate isolation constraints BEFORE any mutation
    const bridge = await tx.legacyUserBridge.findFirst({
      where: { legacyUserId },
      include: { subject: true }
    });

    if (!bridge || bridge.status !== "VALIDATED") {
      throw new Error(`LegacyUserBridge invalid or not found for user ${legacyUserId}`);
    }
    if (bridge.organizationId !== auth.organizationId) {
      throw new Error(`Cross-organization boundary violation for legacy user ${legacyUserId}`);
    }
    if (!bridge.subject || bridge.subject.tenantId !== auth.tenantId) {
      throw new Error(`Cross-tenant boundary violation for legacy user ${legacyUserId}`);
    }

    // 3. Legacy Write
    await tx.userRole.deleteMany({
      where: { userId: legacyUserId }
    });
    
    // 4. Native Write (sync with no role)
    await syncNativeAssignmentsForUser(auth, bridge.subject.id, '', tx);
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

async function syncNativeAssignmentsForUser(auth: AuthContext, subjectId: string, currentRoleId: string, tx: any) {
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

  if (!currentRoleId) return; // Revoked completely

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
