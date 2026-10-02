const fs = require('fs');
let ts = fs.readFileSync('scripts/e2e-http.ts', 'utf8');

const replacement = 
  let globalRole = await adminPrisma.role.findFirst({ where: { name: "Global Administrator" } });
  if (!globalRole) {
    globalRole = await adminPrisma.role.create({ data: { name: "Global Administrator", description: "E2E Global Admin", isCustom: false } });
    const perm1 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "read", resource: "roles" } }, create: { action: "read", resource: "roles" }, update: {} });
    const perm2 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "read", resource: "users" } }, create: { action: "read", resource: "users" }, update: {} });
    const perm3 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "update", resource: "users" } }, create: { action: "update", resource: "users" }, update: {} });
    const perm4 = await adminPrisma.permission.upsert({ where: { action_resource: { action: "delete", resource: "users" } }, create: { action: "delete", resource: "users" }, update: {} });
    
    await adminPrisma.rolePermission.createMany({
      data: [
        { roleId: globalRole.id, permissionId: perm1.id },
        { roleId: globalRole.id, permissionId: perm2.id },
        { roleId: globalRole.id, permissionId: perm3.id },
        { roleId: globalRole.id, permissionId: perm4.id },
      ],
      skipDuplicates: true
    });
  }
  await adminPrisma.userRole.create({ data: { userId: user.id, roleId: globalRole.id } }).catch(() => {});
;

// It's easier to just use Python to replace it precisely
