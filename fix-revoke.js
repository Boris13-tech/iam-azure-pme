const fs = require('fs');
let f = 'lib/auth/dual-write-service.ts';
let c = fs.readFileSync(f, 'utf8');

const revokeFunc = `
export async function dualWriteRevokeUserRole(auth: AuthContext, legacyUserId: string) {
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    // 1. Legacy Write
    await tx.userRole.deleteMany({
      where: { userId: legacyUserId }
    });
    
    // 2. Native Write (sync with no role)
    await syncNativeAssignmentsForUser(auth, legacyUserId, '', tx);
  });
}
`;

c = c.replace(
  'export async function dualWriteCreateRole',
  revokeFunc + '\nexport async function dualWriteCreateRole'
);

fs.writeFileSync(f, c);
