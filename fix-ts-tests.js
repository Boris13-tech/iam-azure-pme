const fs = require('fs');

// Fix cross-tenant-isolation.test.ts
let f = 'tests/cross-tenant-isolation.test.ts';
let c = fs.readFileSync(f, 'utf8');
c = c.replace(
  'organizationId: orgA.id,\n          subjectId: subjectA.id,',
  'organizationId: orgA.id,\n          tenantId: tenantA.id,\n          subjectId: subjectA.id,'
);
fs.writeFileSync(f, c);

// Fix rollback-drill.test.ts
let f2 = 'tests/security/rollback-drill.test.ts';
let c2 = fs.readFileSync(f2, 'utf8');
c2 = c2.replace(/import \{ recordObservation \} from "\.\.\/\.\.\/lib\/auth\/shadow-observer";\n?/g, '');
fs.writeFileSync(f2, c2);
