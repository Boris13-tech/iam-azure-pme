const fs = require('fs');
let f = 'lib/auth/dual-write-service.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";',
  'import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement, LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 } from "./entitlements-catalog";'
);

c = c.replace(
  'ENTITLEMENT_CATALOG_V1.forEach(k => keysToGrant.add(k));',
  'LEGACY_ADMIN_ENTITLEMENT_KEYS_V1.forEach(k => keysToGrant.add(k as CatalogEntitlement));'
);

fs.writeFileSync(f, c);
