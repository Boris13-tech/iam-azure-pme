const fs = require('fs');
let f = 'tests/security/global-role-safety.test.ts';
let c = fs.readFileSync(f, 'utf8');

c = c.replace(
  'await adminPrisma.user.delete({ where: { id: userId } });',
  'await adminPrisma.user.deleteMany({ where: { id: userId } });'
);
c = c.replace(
  'await adminPrisma.role.delete({ where: { id: roleId } });',
  'await adminPrisma.role.deleteMany({ where: { id: roleId } });'
);

fs.writeFileSync(f, c);
