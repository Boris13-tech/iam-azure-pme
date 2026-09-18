const fs = require('fs');
let f = 'scripts/soak/run-soak.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  'await runLegacyRbacBackfill(orgId, tenantA, true);',
  'await runLegacyRbacBackfill({ organizationId: orgId, tenantId: tenantA, mode: "EXECUTE" });'
);
fs.writeFileSync(f, c);
