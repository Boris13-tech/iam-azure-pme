const fs = require('fs');
let f = 'lib/auth/entitlements-catalog.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'export const ENTITLEMENT_CATALOG_V1 = [',
  'export const LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 = [\n  "users.read",\n  "users.create",\n  "users.update",\n  "users.delete",\n  "roles.read",\n  "roles.create",\n  "roles.update",\n  "roles.delete",\n  "roles.manage",\n  "audit.read",\n  "settings.read",\n  "settings.update",\n] as const;\n\nexport const ENTITLEMENT_CATALOG_V1 = ['
);

fs.writeFileSync(f, c);
