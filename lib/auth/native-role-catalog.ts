import type { CatalogEntitlement } from "./entitlements-catalog";

export const LUXIA_ORG_ADMIN_V1 = Object.freeze({
  key: "LUXIA_ORG_ADMIN",
  version: 1,
  sourceRef: "native-role:LUXIA_ORG_ADMIN:v1",
  entitlements: Object.freeze([
    "subjects.read",
    "subjects.create",
    "subjects.update",
    "identity_accounts.read",
    "identity_accounts.link",
    "identity_accounts.disable",
    "assignments.read",
    "assignments.manage",
    "sessions.read",
    "sessions.revoke",
    "providers.read",
    "providers.manage",
    "resources.read",
    "resources.manage",
    "audit.read",
  ] satisfies readonly CatalogEntitlement[]),
});

export type NativeRoleBundle = typeof LUXIA_ORG_ADMIN_V1;
