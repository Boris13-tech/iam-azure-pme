import { rawPrisma } from "../db/raw-prisma";
import { AuthContext } from "./auth-context";

/**
 * Resolves the legacy User model tied to the current AuthContext.
 * Requires a VALIDATED bridge in the current organization.
 */
export async function resolveLegacyUser(auth: AuthContext) {
  const bridge = await rawPrisma.legacyUserBridge.findFirst({
    where: {
      organizationId: auth.organizationId,
      subjectId: auth.subjectId,
      status: "VALIDATED",
    },
    include: {
      legacyUser: {
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
      }
    },
  });

  return bridge?.legacyUser || null;
}

/**
 * Checks legacy permissions utilizing the current AuthContext and LegacyUserBridge.
 * Evaluates legacy RBAC rules (Roles and Permissions).
 */
export async function hasLegacyPermission(auth: AuthContext, action: string, resource: string): Promise<boolean> {
  const legacyUser = await resolveLegacyUser(auth);
  if (!legacyUser) return false;

  const isAdmin = legacyUser.roles.some((ur) => ur.role.name === "Administrateur");
  if (isAdmin) return true;

  return legacyUser.roles.some((userRole) =>
    userRole.role.permissions.some((rp) =>
      rp.permission.action === action && rp.permission.resource === resource
    )
  );
}

/**
 * Checks legacy role utilizing the current AuthContext and LegacyUserBridge.
 */
export async function hasLegacyRole(auth: AuthContext, roleName: string): Promise<boolean> {
  const legacyUser = await resolveLegacyUser(auth);
  if (!legacyUser) return false;

  return legacyUser.roles.some((ur) => ur.role.name === roleName);
}
