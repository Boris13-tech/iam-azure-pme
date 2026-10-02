const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');

const replacement = 
  let globalRole = await adminPrisma.role.findFirst({ where: { name: "Global Administrator" } });
  if (!globalRole) {
    globalRole = await adminPrisma.role.create({ data: { name: "Global Administrator", description: "E2E Global Admin", isGlobal: true } });
    const perm1 = await adminPrisma.permission.create({ data: { name: "VIEW_ROLES", description: "E2E Perm" } }).catch(e => adminPrisma.permission.findFirst({ where: { name: "VIEW_ROLES" } }));
    const perm2 = await adminPrisma.permission.create({ data: { name: "VIEW_USERS", description: "E2E Perm" } }).catch(e => adminPrisma.permission.findFirst({ where: { name: "VIEW_USERS" } }));
    const perm3 = await adminPrisma.permission.create({ data: { name: "UPDATE_USERS", description: "E2E Perm" } }).catch(e => adminPrisma.permission.findFirst({ where: { name: "UPDATE_USERS" } }));
    const perm4 = await adminPrisma.permission.create({ data: { name: "DELETE_USERS", description: "E2E Perm" } }).catch(e => adminPrisma.permission.findFirst({ where: { name: "DELETE_USERS" } }));
    
    await adminPrisma.rolePermission.createMany({
      data: [
        { roleId: globalRole.id, permissionId: perm1.id },
        { roleId: globalRole.id, permissionId: perm2.id },
        { roleId: globalRole.id, permissionId: perm3.id },
        { roleId: globalRole.id, permissionId: perm4.id },
      ]
    });
  }
  await adminPrisma.userRole.create({ data: { userId: user.id, roleId: globalRole.id } }).catch(() => {});
;

ts = ts.replace(/const globalRole = await adminPrisma\.role\.findFirst\(\{\s*where:\s*\{\s*name:\s*"Global Administrator"\s*\}\s*\}\);\s*if\s*\(globalRole\)\s*await adminPrisma\.userRole\.create\(\{ data: \{ userId: user\.id, roleId: globalRole\.id \} \}\)\.catch\(\(\) => \{\}\);/m, replacement);

fs.writeFileSync('scripts/e2e-http.ts', ts);
