import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { CURRENT_WEBAUTHN_CRYPTO } from "../identity";
import { LUXIA_ORG_ADMIN_V1 } from "../auth/native-role-catalog";
import { GOVERNANCE_ADMIN_V2 } from "../resources/admin-bundle";

// Shared by signup (founder) and invitation acceptance. Called inside a transaction that already
// set app.organization_id / app.tenant_id. Nothing here reads authority from the request.
type Tx = Prisma.TransactionClient;
type Scope = { organizationId: string; tenantId: string };

/** LUXIA_LOCAL identity with one verified passkey for an existing subject. */
export async function createPasskeyIdentity(tx: Tx, scope: Scope, input: {
  subjectId: string; connectionId: string; principalName: string;
  passkey: { credentialId: string; publicKeyPem: string }; rpId: string; origin: string; actorSubjectId: string;
}) {
  const account = await tx.identityAccount.create({ data: { ...scope, subjectId: input.subjectId, providerConnectionId: input.connectionId, externalObjectId: randomUUID() } });
  await tx.localIdentity.create({ data: { ...scope, identityAccountId: account.id, principalName: input.principalName } });
  const authenticatorId = randomUUID();
  await tx.localAuthenticator.create({ data: {
    id: authenticatorId, ...scope, identityAccountId: account.id, type: "PASSKEY", status: "ACTIVE",
    credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", credentialFormatVersion: 1,
    ...CURRENT_WEBAUTHN_CRYPTO, keyId: authenticatorId, keyVersion: 1, verifierPolicyVersion: 1,
    // Attestation "none": the hardware cannot be proven, so it is not claimed.
    hardwareBound: false, userVerificationRequired: true,
    credentialId: input.passkey.credentialId, publicKey: input.passkey.publicKeyPem,
    relyingPartyId: input.rpId, allowedOrigin: input.origin, signCount: 0,
  } });
  await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: input.actorSubjectId, targetSubjectId: input.subjectId,
    operation: "LOCAL_AUTHENTICATOR.ENROLL", changeId: `enroll:${authenticatorId}`, result: "SUCCESS", metadata: { type: "PASSKEY" } } });
  return { identityAccountId: account.id, authenticatorId };
}

/**
 * Administrator access: LUXIA_ORG_ADMIN v1 and the governance bundle v2, with entitlement keys from
 * the server catalog only. Entitlements are reused when they already exist in the tenant.
 */
export async function grantAdministrator(tx: Tx, scope: Scope, input: { subjectId: string; actorSubjectId: string; changePrefix: string; metadata: Prisma.InputJsonObject }) {
  const grant = async (keys: readonly string[], sourceRef: string) => {
    const ids: string[] = [];
    for (const key of keys) {
      const [resource, action] = key.split(".");
      const entitlement = await tx.entitlement.findUnique({ where: { organizationId_tenantId_key: { ...scope, key } } })
        ?? await tx.entitlement.create({ data: { ...scope, key, resource, action, description: `${sourceRef}:${key}` } });
      if (!entitlement.active || entitlement.resourceScopeId !== null || entitlement.resource !== resource || entitlement.action !== action)
        throw new Error("ENTITLEMENT_COLLISION");
      ids.push((await tx.assignment.create({ data: { ...scope, subjectId: input.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef, validFrom: new Date() } })).id);
    }
    return ids;
  };
  const adminIds = await grant(LUXIA_ORG_ADMIN_V1.entitlements, LUXIA_ORG_ADMIN_V1.sourceRef);
  const governanceIds = await grant(GOVERNANCE_ADMIN_V2, "native-role:LUXIA_ORG_ADMIN:v2");
  const audit = { ...scope, actorSubjectId: input.actorSubjectId, targetSubjectId: input.subjectId, result: "SUCCESS" as const };
  await tx.canonicalAdminAuditEvent.create({ data: { ...audit, operation: "ROLE_BUNDLE.GRANT", changeId: `${input.changePrefix}:admin`,
    roleKey: LUXIA_ORG_ADMIN_V1.key, roleVersion: LUXIA_ORG_ADMIN_V1.version, assignmentIds: adminIds,
    metadata: { ...input.metadata, sourceRef: LUXIA_ORG_ADMIN_V1.sourceRef } } });
  await tx.canonicalAdminAuditEvent.create({ data: { ...audit, operation: "ROLE.GOVERNANCE.GRANT", changeId: `${input.changePrefix}:governance`,
    roleKey: "LUXIA_ORG_ADMIN", roleVersion: 2, assignmentIds: governanceIds,
    metadata: { ...input.metadata, entitlementKeys: [...GOVERNANCE_ADMIN_V2] } } });
  return [...adminIds, ...governanceIds];
}

/** The tenant's single LUXIA_LOCAL connection; zero or several is refused (never a first result). */
export async function localConnection(tx: Tx, scope: Scope): Promise<string | null> {
  const rows = await tx.providerConnection.findMany({ where: { organizationId: scope.organizationId, providerType: "LUXIA_LOCAL",
    tenantScopes: { some: { organizationId: scope.organizationId, tenantId: scope.tenantId } } }, select: { id: true }, take: 2 });
  return rows.length === 1 ? rows[0].id : null;
}
