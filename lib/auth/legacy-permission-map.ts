import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";

export const LEGACY_PERMISSION_MAP: Record<string, CatalogEntitlement> = {
  "read:users": "users.read",
  "create:users": "users.create",
  "update:users": "users.update",
  "delete:users": "users.delete",

  "read:roles": "roles.read",
  "create:roles": "roles.create",
  "update:roles": "roles.update",
  "delete:roles": "roles.delete",
  "manage:roles": "roles.manage",
  
  "read:audit": "audit.read",

  "read:settings": "settings.read",
  "update:settings": "settings.update",
};

export function mapLegacyPermission(resource: string, action: string): CatalogEntitlement | undefined {
  const legacyKey = `${action}:${resource}`;
  return LEGACY_PERMISSION_MAP[legacyKey];
}
