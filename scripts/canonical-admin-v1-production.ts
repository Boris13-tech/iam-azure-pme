import { readFile } from "node:fs/promises";
import { rawPrisma } from "../lib/db/raw-prisma";
import { withTenantDb } from "../lib/db/scoped-client";

type Bundle = {
  role: { key: string; version: number; sourceRef: string };
  scope: { organizationId: string; tenantId: string; subjectId: string };
  providerConnectionTenantScope: {
    organizationId: string;
    tenantId: string;
    providerConnectionId: string;
    displayName: string;
  };
  grants: Array<{ key: string; entitlementId: string; assignmentId: string }>;
};

const mode = process.argv[2];
const confirmation = process.env.CANONICAL_ADMIN_CONFIRMATION;

if (!process.env.DATABASE_URL?.startsWith("postgresql://app_user:")) {
  throw new Error("DATABASE_URL must use app_user");
}
if (mode === "apply" && confirmation !== "APPLY_LUXIA_ORG_ADMIN_V1_PRODUCTION") {
  throw new Error("Missing apply confirmation");
}
if (mode === "rollback" && confirmation !== "ROLLBACK_LUXIA_ORG_ADMIN_V1_PRODUCTION") {
  throw new Error("Missing rollback confirmation");
}
if (mode !== "apply" && mode !== "rollback") {
  throw new Error("Usage: canonical-admin-v1-production.ts <apply|rollback>");
}

async function main() {
  const bundle = JSON.parse(
    await readFile("docs/operations/canonical-administration-v1-bundle.json", "utf8"),
  ) as Bundle;
  const { organizationId, tenantId, subjectId } = bundle.scope;

  const result = await withTenantDb({ organizationId, tenantId }, async (tx) => {
    const [organization, tenant, subject, providerScope, bridge] = await Promise.all([
      tx.organization.findUnique({ where: { id: organizationId }, select: { id: true } }),
      tx.tenant.findUnique({ where: { organizationId_id: { organizationId, id: tenantId } }, select: { id: true } }),
      tx.subject.findUnique({
        where: { organizationId_tenantId_id: { organizationId, tenantId, id: subjectId } },
        select: { id: true, type: true, lifecycleState: true },
      }),
      tx.providerConnectionTenantScope.findUnique({
        where: {
          organizationId_tenantId_providerConnectionId: {
            organizationId,
            tenantId,
            providerConnectionId: bundle.providerConnectionTenantScope.providerConnectionId,
          },
        },
        select: { providerConnectionId: true },
      }),
      tx.legacyUserBridge.findFirst({ where: { organizationId, subjectId }, select: { id: true } }),
    ]);

    if (!organization || !tenant) throw new Error("Canonical organization/tenant scope missing");
    if (!subject || subject.type !== "HUMAN" || subject.lifecycleState !== "ACTIVE") {
      throw new Error("Target Subject is missing or not an ACTIVE HUMAN");
    }
    if (!providerScope) throw new Error("Entra ProviderConnection is not scoped to the target tenant");
    if (bridge) throw new Error("Target Subject unexpectedly has a LegacyUserBridge");

    if (mode === "apply") {
      const unexpected = await tx.assignment.count({
        where: {
          sourceRef: bundle.role.sourceRef,
          OR: [
            { subjectId: { not: subjectId } },
            { entitlementId: { notIn: bundle.grants.map((grant) => grant.entitlementId) } },
          ],
        },
      });
      if (unexpected !== 0) throw new Error("Unexpected assignment already uses the role sourceRef");

      for (const grant of bundle.grants) {
        const [resource, action] = grant.key.split(".");
        const entitlement = await tx.entitlement.upsert({
          where: { organizationId_tenantId_key: { organizationId, tenantId, key: grant.key } },
          create: {
            id: grant.entitlementId,
            organizationId,
            tenantId,
            key: grant.key,
            resource,
            action,
            description: `${bundle.role.sourceRef}:${grant.key}`,
          },
          update: { resource, action, description: `${bundle.role.sourceRef}:${grant.key}` },
          select: { id: true },
        });
        if (entitlement.id !== grant.entitlementId) {
          throw new Error(`Entitlement key collision: ${grant.key}`);
        }
        await tx.assignment.upsert({
          where: { organizationId_tenantId_id: { organizationId, tenantId, id: grant.assignmentId } },
          create: {
            id: grant.assignmentId,
            organizationId,
            tenantId,
            subjectId,
            entitlementId: grant.entitlementId,
            source: "DIRECT",
            sourceRef: bundle.role.sourceRef,
            status: "ACTIVE",
            validFrom: new Date(),
          },
          update: { status: "ACTIVE", validUntil: null },
        });
      }
      await tx.canonicalAdminAuditEvent.upsert({
        where: {
          organizationId_tenantId_changeId: {
            organizationId,
            tenantId,
            changeId: "production-luxia-org-admin-v1-apply",
          },
        },
        create: {
          organizationId,
          tenantId,
          actorSubjectId: subjectId,
          targetSubjectId: subjectId,
          operation: "ROLE_BUNDLE.GRANT",
          roleKey: bundle.role.key,
          roleVersion: bundle.role.version,
          assignmentIds: bundle.grants.map((grant) => grant.assignmentId),
          changeId: "production-luxia-org-admin-v1-apply",
          result: "SUCCESS",
          metadata: { sourceRef: bundle.role.sourceRef, environment: "production" },
        },
        update: {},
      });
    } else {
      await tx.assignment.updateMany({
        where: { id: { in: bundle.grants.map((grant) => grant.assignmentId) }, sourceRef: bundle.role.sourceRef },
        data: { status: "REVOKED", validUntil: new Date() },
      });
      await tx.canonicalAdminAuditEvent.upsert({
        where: {
          organizationId_tenantId_changeId: {
            organizationId,
            tenantId,
            changeId: "production-luxia-org-admin-v1-rollback",
          },
        },
        create: {
          organizationId,
          tenantId,
          actorSubjectId: subjectId,
          targetSubjectId: subjectId,
          operation: "ROLE_BUNDLE.REVOKE",
          roleKey: bundle.role.key,
          roleVersion: bundle.role.version,
          assignmentIds: bundle.grants.map((grant) => grant.assignmentId),
          changeId: "production-luxia-org-admin-v1-rollback",
          result: "SUCCESS",
          metadata: { sourceRef: bundle.role.sourceRef, environment: "production" },
        },
        update: {},
      });
    }

    const [entitlementCount, activeAssignmentCount, auditCount] = await Promise.all([
      tx.entitlement.count({ where: { id: { in: bundle.grants.map((grant) => grant.entitlementId) } } }),
      tx.assignment.count({
        where: { id: { in: bundle.grants.map((grant) => grant.assignmentId) }, status: "ACTIVE" },
      }),
      tx.canonicalAdminAuditEvent.count({
        where: { changeId: mode === "apply" ? "production-luxia-org-admin-v1-apply" : "production-luxia-org-admin-v1-rollback" },
      }),
    ]);
    return { entitlementCount, activeAssignmentCount, auditCount };
  });

  const expectedActive = mode === "apply" ? 15 : 0;
  if (result.entitlementCount !== 15 || result.activeAssignmentCount !== expectedActive || result.auditCount !== 1) {
    throw new Error("Postcondition verification failed");
  }
  console.log(JSON.stringify({ mode, ...result, status: "PASS" }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => rawPrisma.$disconnect());
