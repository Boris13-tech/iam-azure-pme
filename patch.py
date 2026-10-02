import sys

with open('scripts/e2e-http.ts', 'r', encoding='utf-8') as f:
    ts = f.read()

import re
pattern = r'const globalRole = await adminPrisma\.role\.findFirst\(\{ where: \{ name: "Global Administrator" \} \}\);\s*if \(globalRole\) await adminPrisma\.userRole\.create\(\{ data: \{ userId: user\.id, roleId: globalRole\.id \} \}\)\.catch\(\(\) => \{\}\);'

replacement = """
  let globalRole = await adminPrisma.role.findFirst({ where: { name: "Global Administrator" } });
  if (!globalRole) {
    globalRole = await adminPrisma.role.create({ data: { name: "Global Administrator", description: "E2E Global Admin", isGlobal: true } });
    const perm1 = await adminPrisma.permission.upsert({ where: { name: "VIEW_ROLES" }, create: { name: "VIEW_ROLES", description: "E2E Perm" }, update: {} });
    const perm2 = await adminPrisma.permission.upsert({ where: { name: "VIEW_USERS" }, create: { name: "VIEW_USERS", description: "E2E Perm" }, update: {} });
    const perm3 = await adminPrisma.permission.upsert({ where: { name: "UPDATE_USERS" }, create: { name: "UPDATE_USERS", description: "E2E Perm" }, update: {} });
    const perm4 = await adminPrisma.permission.upsert({ where: { name: "DELETE_USERS" }, create: { name: "DELETE_USERS", description: "E2E Perm" }, update: {} });
    
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

ts = re.sub(pattern, replacement, ts, flags=re.MULTILINE)

with open('scripts/e2e-http.ts', 'w', encoding='utf-8') as f:
    f.write(ts)
