const fs = require('fs');

let f = 'tests/cross-tenant-isolation.test.ts';
let c = fs.readFileSync(f, 'utf8');

const regex = /organizationId:\s*orgA\.id,\s*subjectId:\s*subjectA\.id,/g;
c = c.replace(regex, 'organizationId: orgA.id,\n          tenantId: tenantA.id,\n          subjectId: subjectA.id,');

fs.writeFileSync(f, c);
