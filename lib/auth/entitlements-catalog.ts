export const LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 = [
  "users.read",
  "users.create",
  "users.update",
  "users.delete",
  "roles.read",
  "roles.create",
  "roles.update",
  "roles.delete",
  "roles.manage",
  "audit.read",
  "settings.read",
  "settings.update",
] as const;

export const ENTITLEMENT_CATALOG_V1 = [
  "users.read",
  "users.create",
  "users.update",
  "users.delete",

  "roles.read",
  "roles.create",
  "roles.update",
  "roles.delete",
  "roles.manage",

  "audit.read",

  "settings.read",
  "settings.update",
] as const;

export type CatalogEntitlement = typeof ENTITLEMENT_CATALOG_V1[number];

/**
 * Checks if an assignment is currently effective based on its temporal boundaries and status.
 */
export function isAssignmentEffective(assignment: { 
  status: "ACTIVE" | "REVOKED" | "EXPIRED", 
  validFrom: Date | null, 
  validUntil: Date | null 
}, now: Date = new Date()): boolean {
  if (assignment.status !== "ACTIVE") return false;
  
  if (assignment.validFrom && assignment.validFrom > now) {
    return false;
  }
  
  if (assignment.validUntil && assignment.validUntil <= now) {
    return false;
  }
  
  return true;
}
