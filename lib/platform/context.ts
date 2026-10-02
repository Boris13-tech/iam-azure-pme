import { withTenantDb } from "@/lib/db/scoped-client";
import type { AuthContext } from "@/lib/auth/auth-context";

export type PlatformContext = {
  organization: { id: string; name: string };
  tenant: { id: string; name: string };
  subject: { id: string; name: string; type: string; lifecycleState: string };
  identity: { id: string; providerType: string };
  entitlements: string[];
  capabilities: {
    localAuthentication: boolean;
    passkeys: boolean;
    offlineContinuity: boolean;
    providerManagement: boolean;
  };
};

export async function loadPlatformContext(auth: AuthContext): Promise<PlatformContext> {
  return withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    const [organization, tenant, subject, identity, assignments, localPasskeys, continuity] = await Promise.all([
      tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { id: true, name: true } }),
      tx.tenant.findUniqueOrThrow({ where: { organizationId_id: { organizationId: auth.organizationId, id: auth.tenantId } }, select: { id: true, name: true } }),
      tx.subject.findUniqueOrThrow({ where: { organizationId_tenantId_id: { organizationId: auth.organizationId, tenantId: auth.tenantId, id: auth.subjectId } }, select: { id: true, name: true, type: true, lifecycleState: true } }),
      tx.identityAccount.findUniqueOrThrow({ where: { organizationId_tenantId_id: { organizationId: auth.organizationId, tenantId: auth.tenantId, id: auth.identityAccountId } }, include: { providerConnection: { select: { providerType: true } } } }),
      tx.assignment.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, subjectId: auth.subjectId, status: "ACTIVE", OR: [{ validFrom: null }, { validFrom: { lte: new Date() } }], AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }] }, include: { entitlement: { select: { key: true } } } }),
      tx.localAuthenticator.count({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] } } }),
      tx.identityContinuityState.findUnique({ where: { organizationId_tenantId: { organizationId: auth.organizationId, tenantId: auth.tenantId } }, select: { mode: true } }),
    ]);
    const entitlements = assignments.map(row => row.entitlement.key).sort();
    return {
      organization,
      tenant,
      subject: { ...subject, type: String(subject.type), lifecycleState: String(subject.lifecycleState) },
      identity: { id: identity.id, providerType: String(identity.providerConnection.providerType) },
      entitlements,
      capabilities: {
        localAuthentication: identity.providerConnection.providerType === "LUXIA_LOCAL",
        passkeys: localPasskeys > 0,
        offlineContinuity: Boolean(continuity),
        providerManagement: entitlements.includes("providers.manage"),
      },
    };
  });
}
