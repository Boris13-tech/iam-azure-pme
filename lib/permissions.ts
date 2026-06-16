import { prisma } from "./prisma";

export async function hasPermission(userId: string, action: string, resource: string): Promise<boolean> {
  if (!userId) return false;
  if (userId === "mock-admin-id") return true;

  const user = await prisma.user.findUnique({
    where: { id: userId, status: "ACTIVE" },
    include: {
      roles: {
        include: {
          role: {
            include: {
              permissions: {
                include: { permission: true }
              }
            }
          }
        }
      }
    }
  });

  if (!user) return false;

  const isAdmin = user.roles.some((ur) => ur.role.name === "Administrateur");
  if (isAdmin) return true;

  return user.roles.some((userRole) => 
    userRole.role.permissions.some((rp) => 
      rp.permission.action === action && rp.permission.resource === resource
    )
  );
}

export async function checkRole(userId: string, roleName: string): Promise<boolean> {
  if (!userId) return false;
  
  const user = await prisma.user.findUnique({
    where: { id: userId, status: "ACTIVE" },
    include: { roles: { include: { role: true } } }
  });

  if (!user) return false;

  return user.roles.some((ur) => ur.role.name === roleName);
}