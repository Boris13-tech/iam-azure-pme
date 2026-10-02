import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";
import { withTenantDb } from "@/lib/db/scoped-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const body = await request.json() as { principalName?: string };
    const principalName = body.principalName?.trim().toLowerCase();
    if (!principalName || principalName.length > 254) {
      return NextResponse.json({ error: "INVALID_LOCAL_IDENTIFIER" }, { status: 400 });
    }

    const prepared = await withTenantDb(
      { organizationId: auth.organizationId, tenantId: auth.tenantId },
      async (tx) => {
        const subject = await tx.subject.findUniqueOrThrow({
          where: { organizationId_tenantId_id: { organizationId: auth.organizationId, tenantId: auth.tenantId, id: auth.subjectId } },
          select: { id: true, name: true },
        });
        const grants = await tx.assignment.findMany({
          where: { subjectId: auth.subjectId, status: "ACTIVE" },
          include: { entitlement: { select: { key: true } } },
        });
        if (!grants.some((item) => item.entitlement.key === "providers.manage")) throw new Error("FORBIDDEN");

        let connection = await tx.providerConnection.findFirst({
          where: { organizationId: auth.organizationId, providerType: "LUXIA_LOCAL", tenantScopes: { some: { tenantId: auth.tenantId } } },
          select: { id: true },
        });
        if (!connection) {
          connection = await tx.providerConnection.create({ data: {
            organizationId: auth.organizationId,
            providerType: "LUXIA_LOCAL",
            externalScopeId: auth.tenantId,
            name: "LUXIA Local",
          }, select: { id: true } });
          await tx.providerConnectionTenantScope.create({ data: {
            organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: connection.id,
          } });
        }
        return { subject, connection };
      },
    );

    const context = localProviderContext({ organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: prepared.connection.id });
    const adapter = getLuxiaLocalAdapter();
    const identities = [];
    for await (const item of adapter.discoverUsers(context)) identities.push(item.identity);
    let identity = identities.find((item) => item.attributes.subjectId === auth.subjectId);
    if (!identity) {
      const result = await adapter.createIdentity(context, { subjectId: auth.subjectId, displayName: prepared.subject.name, principalName });
      identity = (await adapter.getUser(context, result.identity!)) ?? undefined;
    } else if (identity.principalName !== principalName) {
      return NextResponse.json({ error: "LOCAL_IDENTITY_ALREADY_EXISTS" }, { status: 409 });
    }
    if (!identity) throw new Error("LOCAL_IDENTITY_CREATION_FAILED");
    const identityAccountId = String(identity.attributes.identityAccountId);
    const challenge = await adapter.beginEnrollment(context, identityAccountId);
    return NextResponse.json({
      providerConnectionId: prepared.connection.id,
      identityAccountId,
      transactionId: challenge.transactionId,
      challenge: challenge.publicChallenge?.challenge,
      expiresAt: challenge.expiresAt,
      rp: { id: new URL(request.url).hostname, name: "LUXIA Identity" },
      user: { id: auth.subjectId, name: principalName, displayName: prepared.subject.name },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ENROLLMENT_FAILED";
    const status = message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 500;
    return NextResponse.json({ error: status === 500 ? "ENROLLMENT_FAILED" : message }, { status });
  }
}
