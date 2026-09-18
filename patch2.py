import sys
import re

with open('scripts/e2e-http.ts', 'r', encoding='utf-8') as f:
    ts = f.read()

pattern = r'  let globalRole = await adminPrisma\.role\.findFirst.*?\.catch\(\(\) => \{\}\);'

replacement = """
  let globalRole = await adminPrisma.role.findFirst({ where: { name: "Global Administrator" } });
  if (!globalRole) {
    globalRole = await adminPrisma.role.create({ data: { name: "Global Administrator", description: "E2E", isCustom: false } });
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
"""

ts = re.sub(pattern, replacement, ts, flags=re.MULTILINE | re.DOTALL)

with open('scripts/e2e-http.ts', 'w', encoding='utf-8') as f:
    f.write(ts)
