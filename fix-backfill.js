const fs = require('fs');
let f = 'tests/security/backfill-idempotency.test.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'await rawPrisma.role.create({',
  'await adminPrisma.role.create({'
);

c = c.replace(
  'await rawPrisma.permission.create({',
  'await adminPrisma.permission.create({'
);

c = c.replace(
  'await rawPrisma.rolePermission.create({',
  'await adminPrisma.rolePermission.create({'
);

fs.writeFileSync(f, c);
