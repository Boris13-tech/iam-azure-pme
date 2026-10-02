import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { withTenantDb } from "@/lib/db/scoped-client";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";
import { ProviderAdapterError } from "@/lib/provider-adapters";

export const runtime = "nodejs";
const failure = () => NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }, { status: 401 });

export async function POST(request: Request) {
  try {
    const body = await request.json() as { principalName?: string; providerConnectionId?: string; tenantId?: string };
    if (!body.principalName || !body.providerConnectionId || !body.tenantId) return failure();
    const provider = await rawPrisma.providerConnection.findFirst({
      where: { id: body.providerConnectionId, providerType: "LUXIA_LOCAL" },
      select: { id: true, organizationId: true },
    });
    if (!provider) return failure();
    const local = await withTenantDb({ organizationId: provider.organizationId, tenantId: body.tenantId }, async (tx) => {
      const scoped = await tx.providerConnectionTenantScope.findFirst({ where: { providerConnectionId: provider.id, tenantId: body.tenantId } });
      if (!scoped) return null;
      return tx.localIdentity.findFirst({
        where: { principalName: body.principalName!.trim().toLowerCase(), status: "ACTIVE", identityAccount: { providerConnectionId: provider.id } },
        include: { identityAccount: true, authenticators: { where: { status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] } }, select: { credentialId: true } } },
      });
    });
    if (!local) return failure();
    const context = localProviderContext({ organizationId: provider.organizationId, tenantId: body.tenantId, providerConnectionId: provider.id });
    const challenge = await getLuxiaLocalAdapter().beginAuthentication({ context, loginHint: body.principalName.trim().toLowerCase() });
    return NextResponse.json({
      transactionId: challenge.transactionId,
      challenge: challenge.publicChallenge?.challenge,
      externalObjectId: local.identityAccount.externalObjectId,
      allowCredentials: local.authenticators.map((item) => item.credentialId).filter(Boolean),
      rpId: new URL(request.url).hostname,
    });
  } catch (error) {
    const safeCode = error instanceof ProviderAdapterError
      ? `${error.code}${error.safeDetails.reason ? `_${error.safeDetails.reason}` : ""}`
      : "LOCAL_AUTH_BEGIN_FAILED";
    console.error("LOCAL_AUTH_BEGIN_FAILED", safeCode);
    return NextResponse.json({ error: safeCode }, { status: 401 });
  }
}
