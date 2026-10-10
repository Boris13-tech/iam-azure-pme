import { randomUUID } from "node:crypto";
import {
  Prisma,
  ProviderType,
  ResourceType,
  SubjectLifecycleState,
  SubjectType,
} from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { ENTITLEMENT_CATALOG_V1 } from "../auth/entitlements-catalog";
import { withTenantDb } from "../db/scoped-client";
import { assertSubjectLifecycleTransition } from "../identity";

export class CanonicalAdminError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
    this.name = "CanonicalAdminError";
  }
}

type AuditInput = {
  operation: string;
  changeId: string;
  targetSubjectId?: string | null;
  roleKey?: string | null;
  roleVersion?: number | null;
  assignmentIds?: string[];
  result?: "SUCCESS" | "DENIED" | "FAILURE";
  metadata?: Prisma.InputJsonValue;
};

const sensitiveKey = /(secret|password|token|credential|private.?key|client.?secret)/i;

function validateAuditInput(input: AuditInput): void {
  if (!input.changeId.trim() || input.changeId.length > 128) {
    throw new CanonicalAdminError("INVALID_CHANGE_ID", 400);
  }
  if (!/^[A-Z][A-Z0-9_.:-]{2,127}$/.test(input.operation)) {
    throw new CanonicalAdminError("INVALID_ADMIN_OPERATION", 400);
  }
  if ((input.roleKey == null) !== (input.roleVersion == null)) {
    throw new CanonicalAdminError("ROLE_KEY_VERSION_PAIR_REQUIRED", 400);
  }
  if (input.roleVersion != null && input.roleVersion < 1) {
    throw new CanonicalAdminError("INVALID_ROLE_VERSION", 400);
  }
  if (new Set(input.assignmentIds ?? []).size !== (input.assignmentIds ?? []).length) {
    throw new CanonicalAdminError("DUPLICATE_ASSIGNMENT_ID", 400);
  }
  assertMetadataSafe(input.metadata);
}

function assertMetadataSafe(value: unknown, path = "metadata"): void {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertMetadataSafe(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveKey.test(key)) {
      throw new CanonicalAdminError(`SENSITIVE_AUDIT_METADATA:${path}.${key}`, 400);
    }
    assertMetadataSafe(nested, `${path}.${key}`);
  }
}

async function assertUnusedChangeId(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  changeId: string,
): Promise<void> {
  const existing = await tx.canonicalAdminAuditEvent.findUnique({
    where: {
      organizationId_tenantId_changeId: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        changeId,
      },
    },
    select: { id: true },
  });
  if (existing) throw new CanonicalAdminError("CHANGE_ALREADY_APPLIED", 409);
}

async function writeAudit(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  input: AuditInput,
) {
  validateAuditInput(input);
  await assertUnusedChangeId(tx, auth, input.changeId);
  return tx.canonicalAdminAuditEvent.create({
    data: {
      organizationId: auth.organizationId,
      tenantId: auth.tenantId,
      actorSubjectId: auth.subjectId,
      targetSubjectId: input.targetSubjectId ?? null,
      operation: input.operation,
      roleKey: input.roleKey ?? null,
      roleVersion: input.roleVersion ?? null,
      assignmentIds: input.assignmentIds ?? [],
      changeId: input.changeId,
      result: input.result ?? "SUCCESS",
      metadata: input.metadata,
    },
  });
}

export const newReadChangeId = (operation: string) =>
  `read:${operation.toLowerCase()}:${randomUUID()}`;

export async function recordDeniedAdminAccess(
  auth: AuthContext,
  resource: string,
  action: string,
): Promise<void> {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, {
      operation: "AUTHORIZATION.DENIED",
      changeId: `denied:${resource}.${action}:${randomUUID()}`,
      result: "DENIED",
      metadata: { resource, action },
    });
  });
}

export async function listCanonicalAdminAudit(
  auth: AuthContext,
  input: { skip?: number; take?: number; operation?: string; excludeReads?: boolean; changeId: string },
) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, {
      operation: "AUDIT.READ",
      changeId: input.changeId,
      metadata: { filterOperation: input.operation ?? null, excludeReads: input.excludeReads === true },
    });
    return tx.canonicalAdminAuditEvent.findMany({
      where: {
        ...(input.operation ? { operation: input.operation } : {}),
        ...(input.excludeReads ? { NOT: { operation: { endsWith: ".READ" } } } : {}),
      },
      // Display names only (tenant-scoped relations under RLS); no other subject fields.
      include: { actor: { select: { name: true } }, target: { select: { name: true } } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: Math.max(0, input.skip ?? 0),
      take: Math.min(100, Math.max(1, input.take ?? 50)),
    });
  });
}

export async function listSubjects(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "SUBJECT.READ", changeId });
    return tx.subject.findMany({ orderBy: { createdAt: "desc" } });
  });
}

export async function createSubject(
  auth: AuthContext,
  input: { name: string; type: SubjectType; lifecycleState?: SubjectLifecycleState },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const subject = await tx.subject.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        name: input.name.trim(),
        type: input.type,
        lifecycleState: input.lifecycleState ?? "ACTIVE",
      },
    });
    await writeAudit(tx, auth, {
      operation: "SUBJECT.CREATE",
      changeId,
      targetSubjectId: subject.id,
      metadata: { subjectType: subject.type },
    });
    return subject;
  });
}

export async function updateSubject(
  auth: AuthContext,
  subjectId: string,
  input: { name?: string; lifecycleState?: SubjectLifecycleState },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const existing = await tx.subject.findFirst({ where: { id: subjectId } });
    if (!existing) throw new CanonicalAdminError("SUBJECT_NOT_FOUND", 404);
    if (
      subjectId === auth.subjectId &&
      input.lifecycleState != null &&
      input.lifecycleState !== "ACTIVE"
    ) {
      throw new CanonicalAdminError("SELF_LIFECYCLE_DOWNGRADE_FORBIDDEN", 409);
    }
    const lifecycleChanged = input.lifecycleState != null && input.lifecycleState !== existing.lifecycleState;
    if (lifecycleChanged) {
      try {
        assertSubjectLifecycleTransition(existing.lifecycleState, input.lifecycleState!);
      } catch {
        throw new CanonicalAdminError(`INVALID_SUBJECT_LIFECYCLE_TRANSITION:${existing.lifecycleState}:${input.lifecycleState}`, 409);
      }
    }
    const subject = await tx.subject.update({
      where: {
        organizationId_tenantId_id: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          id: subjectId,
        },
      },
      data: {
        ...(input.name != null ? { name: input.name.trim() } : {}),
        ...(input.lifecycleState != null
          ? {
              lifecycleState: input.lifecycleState,
              ...(lifecycleChanged
                ? { lifecycleVersion: { increment: 1 }, lifecycleChangedAt: new Date() }
                : {}),
            }
          : {}),
      },
    });
    let revokedSessions = 0;
    let revokedAssignments = 0;
    if (lifecycleChanged && subject.lifecycleState !== "ACTIVE") {
      revokedSessions = (await tx.session.updateMany({
        where: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          subjectId: subject.id,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      })).count;
    }
    if (lifecycleChanged && (subject.lifecycleState === "DISABLED" || subject.lifecycleState === "RETIRED")) {
      revokedAssignments = (await tx.assignment.updateMany({
        where: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          subjectId: subject.id,
          status: "ACTIVE",
        },
        data: { status: "REVOKED", validUntil: new Date() },
      })).count;
    }
    await writeAudit(tx, auth, {
      operation: "SUBJECT.UPDATE",
      changeId,
      targetSubjectId: subject.id,
      metadata: {
        nameChanged: input.name != null,
        lifecycleFrom: existing.lifecycleState,
        lifecycleTo: subject.lifecycleState,
        revokedSessions,
        revokedAssignments,
      },
    });
    return subject;
  });
}

export async function listIdentityAccounts(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "IDENTITY_ACCOUNT.READ", changeId });
    return tx.identityAccount.findMany({
      include: { providerConnection: { select: { id: true, name: true, providerType: true } } },
      orderBy: { createdAt: "desc" },
    });
  });
}

export async function linkIdentityAccount(
  auth: AuthContext,
  input: { subjectId: string; providerConnectionId: string; externalObjectId: string },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const [subject, providerScope] = await Promise.all([
      tx.subject.findFirst({ where: { id: input.subjectId }, select: { id: true } }),
      tx.providerConnectionTenantScope.findUnique({
        where: {
          organizationId_tenantId_providerConnectionId: {
            organizationId: auth.organizationId,
            tenantId: auth.tenantId,
            providerConnectionId: input.providerConnectionId,
          },
        },
        select: { providerConnectionId: true },
      }),
    ]);
    if (!subject) throw new CanonicalAdminError("SUBJECT_NOT_FOUND", 404);
    if (!providerScope) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    const account = await tx.identityAccount.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        subjectId: input.subjectId,
        providerConnectionId: input.providerConnectionId,
        externalObjectId: input.externalObjectId.trim(),
      },
    });
    await writeAudit(tx, auth, {
      operation: "IDENTITY_ACCOUNT.LINK",
      changeId,
      targetSubjectId: account.subjectId,
      metadata: { identityAccountId: account.id, providerConnectionId: account.providerConnectionId },
    });
    return account;
  });
}

export async function disableIdentityAccount(
  auth: AuthContext,
  identityAccountId: string,
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const existing = await tx.identityAccount.findFirst({ where: { id: identityAccountId } });
    if (!existing) throw new CanonicalAdminError("IDENTITY_ACCOUNT_NOT_FOUND", 404);
    if (existing.subjectId === auth.subjectId) {
      throw new CanonicalAdminError("SELF_IDENTITY_DISABLE_FORBIDDEN", 409);
    }
    if (existing.status === "DISABLED") throw new CanonicalAdminError("IDENTITY_ACCOUNT_ALREADY_DISABLED", 409);
    const disabledAt = new Date();
    const account = await tx.identityAccount.update({
      where: {
        organizationId_tenantId_id: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          id: identityAccountId,
        },
      },
      data: { status: "DISABLED", disabledAt },
    });
    const revoked = await tx.session.updateMany({
      where: { identityAccountId, revokedAt: null },
      data: { revokedAt: disabledAt },
    });
    await writeAudit(tx, auth, {
      operation: "IDENTITY_ACCOUNT.DISABLE",
      changeId,
      targetSubjectId: account.subjectId,
      metadata: { identityAccountId: account.id, sessionsRevoked: revoked.count },
    });
    return account;
  });
}

export async function listAssignments(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "ASSIGNMENT.READ", changeId });
    return tx.assignment.findMany({
      include: { entitlement: true, subject: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
  });
}

export async function grantAssignment(
  auth: AuthContext,
  input: {
    subjectId: string;
    entitlementId: string;
    sourceRef?: string;
    roleKey?: string;
    roleVersion?: number;
    validFrom?: Date;
    validUntil?: Date;
  },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const [subject, entitlement] = await Promise.all([
      tx.subject.findFirst({ where: { id: input.subjectId }, select: { id: true } }),
      tx.entitlement.findFirst({ where: { id: input.entitlementId } }),
    ]);
    if (!subject) throw new CanonicalAdminError("SUBJECT_NOT_FOUND", 404);
    if (!entitlement) throw new CanonicalAdminError("ENTITLEMENT_NOT_FOUND", 404);
    if (entitlement.resourceScopeId || !(ENTITLEMENT_CATALOG_V1 as readonly string[]).includes(entitlement.key)) {
      throw new CanonicalAdminError("UNKNOWN_ENTITLEMENT", 400);
    }
    if (input.validFrom && input.validUntil && input.validUntil <= input.validFrom) {
      throw new CanonicalAdminError("INVALID_ASSIGNMENT_TIME_RANGE", 400);
    }
    const assignment = await tx.assignment.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        subjectId: subject.id,
        entitlementId: entitlement.id,
        source: "DIRECT",
        sourceRef: input.sourceRef ?? null,
        status: "ACTIVE",
        validFrom: input.validFrom ?? new Date(),
        validUntil: input.validUntil ?? null,
      },
    });
    await writeAudit(tx, auth, {
      operation: "ASSIGNMENT.GRANT",
      changeId,
      targetSubjectId: subject.id,
      roleKey: input.roleKey ?? null,
      roleVersion: input.roleVersion ?? null,
      assignmentIds: [assignment.id],
      metadata: { entitlementId: entitlement.id, entitlementKey: entitlement.key },
    });
    return assignment;
  });
}

export async function revokeAssignment(auth: AuthContext, assignmentId: string, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const existing = await tx.assignment.findFirst({ where: { id: assignmentId, status: "ACTIVE" } });
    if (!existing) throw new CanonicalAdminError("ACTIVE_ASSIGNMENT_NOT_FOUND", 404);
    if (existing.subjectId === auth.subjectId) {
      throw new CanonicalAdminError("SELF_ASSIGNMENT_REVOKE_FORBIDDEN", 409);
    }
    const assignment = await tx.assignment.update({
      where: {
        organizationId_tenantId_id: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          id: assignmentId,
        },
      },
      data: { status: "REVOKED", validUntil: new Date() },
    });
    await writeAudit(tx, auth, {
      operation: "ASSIGNMENT.REVOKE",
      changeId,
      targetSubjectId: assignment.subjectId,
      assignmentIds: [assignment.id],
      metadata: { entitlementId: assignment.entitlementId },
    });
    return assignment;
  });
}

export async function listSessions(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "SESSION.READ", changeId });
    // Explicit projection: ipHash / userAgentHash are unsalted SHA-256 values (an IPv4 address is
    // recoverable by brute force) and are never returned. `id` stays: it is the revocation handle.
    const sessions = await tx.session.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, organizationId: true, tenantId: true, subjectId: true, identityAccountId: true,
        recoveryEpoch: true, expiresAt: true, revokedAt: true, createdAt: true, lastSeenAt: true,
      },
    });
    return sessions.map((session) => ({
      ...session,
      recoveryEpoch: session.recoveryEpoch.toString(),
    }));
  });
}

export async function revokeSession(auth: AuthContext, sessionId: string, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const existing = await tx.session.findFirst({ where: { id: sessionId, revokedAt: null } });
    if (!existing) throw new CanonicalAdminError("ACTIVE_SESSION_NOT_FOUND", 404);
    const session = await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await writeAudit(tx, auth, {
      operation: "SESSION.REVOKE",
      changeId,
      targetSubjectId: session.subjectId,
      metadata: { sessionId: session.id },
    });
    return { ...session, recoveryEpoch: session.recoveryEpoch.toString() };
  });
}

export async function listProviderConnections(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "PROVIDER.READ", changeId });
    return tx.providerConnectionTenantScope.findMany({
      include: { providerConnection: true },
      orderBy: { createdAt: "desc" },
    });
  });
}

export async function createProviderConnection(
  auth: AuthContext,
  input: { providerType: ProviderType; externalScopeId: string; name: string },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const connection = await tx.providerConnection.create({
      data: {
        organizationId: auth.organizationId,
        providerType: input.providerType,
        externalScopeId: input.externalScopeId.trim(),
        name: input.name.trim(),
      },
    });
    await tx.providerConnectionTenantScope.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        providerConnectionId: connection.id,
        displayName: connection.name,
      },
    });
    await writeAudit(tx, auth, {
      operation: "PROVIDER.CREATE",
      changeId,
      metadata: { providerConnectionId: connection.id, providerType: connection.providerType },
    });
    return connection;
  });
}

export async function updateProviderConnection(
  auth: AuthContext,
  providerConnectionId: string,
  input: { name: string },
  changeId: string,
) {
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const scope = await tx.providerConnectionTenantScope.findUnique({
      where: {
        organizationId_tenantId_providerConnectionId: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          providerConnectionId,
        },
      },
    });
    if (!scope) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    const tenantScope = await tx.providerConnectionTenantScope.update({
      where: {
        organizationId_tenantId_providerConnectionId: {
          organizationId: auth.organizationId,
          tenantId: auth.tenantId,
          providerConnectionId,
        },
      },
      data: { displayName: input.name.trim() },
    });
    await writeAudit(tx, auth, {
      operation: "PROVIDER.UPDATE",
      changeId,
      metadata: { providerConnectionId: tenantScope.providerConnectionId, tenantLocalFields: ["displayName"] },
    });
    return tenantScope;
  });
}

export async function listResources(auth: AuthContext, changeId: string) {
  return withTenantDb(auth, async (tx) => {
    await writeAudit(tx, auth, { operation: "RESOURCE.READ", changeId });
    return tx.resource.findMany({ orderBy: { createdAt: "desc" } });
  });
}

export async function createResource(
  auth: AuthContext,
  input: {
    name: string;
    type: ResourceType;
    description?: string;
    providerConnectionId?: string;
    externalId?: string;
    metadata?: Prisma.InputJsonValue;
  },
  changeId: string,
) {
  assertMetadataSafe(input.metadata);
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    if (input.providerConnectionId) {
      const scope = await tx.providerConnectionTenantScope.findUnique({
        where: {
          organizationId_tenantId_providerConnectionId: {
            organizationId: auth.organizationId,
            tenantId: auth.tenantId,
            providerConnectionId: input.providerConnectionId,
          },
        },
      });
      if (!scope) throw new CanonicalAdminError("PROVIDER_NOT_IN_TENANT_SCOPE", 404);
    }
    const resource = await tx.resource.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        name: input.name.trim(),
        type: input.type,
        description: input.description?.trim(),
        providerConnectionId: input.providerConnectionId,
        externalId: input.externalId?.trim(),
        metadata: input.metadata,
      },
    });
    await writeAudit(tx, auth, {
      operation: "RESOURCE.CREATE",
      changeId,
      metadata: { resourceId: resource.id, resourceType: resource.type },
    });
    return resource;
  });
}

export async function updateResource(
  auth: AuthContext,
  resourceId: string,
  input: { name?: string; description?: string; metadata?: Prisma.InputJsonValue },
  changeId: string,
) {
  assertMetadataSafe(input.metadata);
  return withTenantDb(auth, async (tx) => {
    await assertUnusedChangeId(tx, auth, changeId);
    const existing = await tx.resource.findFirst({ where: { id: resourceId } });
    if (!existing) throw new CanonicalAdminError("RESOURCE_NOT_FOUND", 404);
    const resource = await tx.resource.update({
      where: {
        organizationId_id: { organizationId: auth.organizationId, id: resourceId },
      },
      data: {
        ...(input.name != null ? { name: input.name.trim() } : {}),
        ...(input.description != null ? { description: input.description.trim() } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    });
    await writeAudit(tx, auth, {
      operation: "RESOURCE.UPDATE",
      changeId,
      metadata: { resourceId: resource.id, resourceType: resource.type },
    });
    return resource;
  });
}
