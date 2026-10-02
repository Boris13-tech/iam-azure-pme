const fs = require('fs');
let f = 'scripts/soak/run-soak.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  'tenantId: tenantA,',
  'organizationId: orgId,\n      tenantId: tenantA,'
);
fs.writeFileSync(f, c);
