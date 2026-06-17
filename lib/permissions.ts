import { prisma } from "./prisma";
import { getGraphClient } from "./graph";

async function getOrCreateUser(userId: string) {
  if (!userId) return null;

  // Try to find the user by ID or by Azure ID
  let user = await prisma.user.findFirst({
    where: {
      OR: [
        { id: userId },
        { azureId: userId }
      ],
      status: "ACTIVE"
    },
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

  // Onboard user if they exist in Azure AD but not in our local DB
  if (!user && userId !== "mock-admin-id" && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_ID !== "dummy_client_id") {
    try {
      const client = await getGraphClient();
      const graphUser = await client.api(`/users/${userId}`)
        .select('id,displayName,mail,userPrincipalName,accountEnabled')
        .get();

      if (graphUser && graphUser.accountEnabled !== false) {
        const email = (graphUser.mail || graphUser.userPrincipalName || "").toLowerCase();
        const name = graphUser.displayName || email.split('@')[0];

        // Create user locally
        const newUser = await prisma.user.create({
          data: {
            azureId: graphUser.id,
            name: name,
            email: email,
            status: "ACTIVE"
          }
        });

        // Assign default role (Utilisateur Standard)
        await prisma.userRole.create({
          data: {
            userId: newUser.id,
            roleId: "user-id"
          }
        });

        // Re-query user details
        user = await prisma.user.findUnique({
          where: { id: newUser.id },
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
      }
    } catch (e) {
      console.error("On-the-fly user onboarding failed:", e);
    }
  }

  return user;
}

export async function hasPermission(userId: string, action: string, resource: string): Promise<boolean> {
  if (!userId) return false;
  if (userId === "mock-admin-id") return true;

  const user = await getOrCreateUser(userId);
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
  if (userId === "mock-admin-id") return roleName === "Administrateur";
  
  const user = await getOrCreateUser(userId);
  if (!user) return false;

  return user.roles.some((ur) => ur.role.name === roleName);
}
