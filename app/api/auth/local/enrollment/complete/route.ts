import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";
import { withTenantDb } from "@/lib/db/scoped-client";
import { ProviderAdapterError } from "@/lib/provider-adapters";

export const runtime = "nodejs";

function spkiPem(value: string): string {
  const base64 = Buffer.from(value, "base64url").toString("base64");
  return `-----BEGIN PUBLIC KEY-----\n${base64.match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END PUBLIC KEY-----`;
}

export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const body = await request.json() as Record<string, string>;
    const connection = await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
      const account = await tx.identityAccount.findFirst({ where: { id: body.identityAccountId, subjectId: auth.subjectId, tenantId: auth.tenantId }, select: { id: true } });
      if (!account) return null;
      return tx.providerConnection.findFirst({ where: { id: body.providerConnectionId, providerType: "LUXIA_LOCAL", tenantScopes: { some: { tenantId: auth.tenantId } } }, select: { id: true } });
    });
    if (!connection) return NextResponse.json({ error: "INVALID_PROVIDER_SCOPE" }, { status: 403 });
    const context = localProviderContext({ organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: connection.id });
    const id = await getLuxiaLocalAdapter().enrollPasskey(context, {
      identityAccountId: body.identityAccountId,
      enrollmentTransactionId: body.transactionId,
      enrollmentChallenge: body.challenge,
      credentialId: body.credentialId,
      publicKey: spkiPem(body.publicKey),
      relyingPartyId: new URL(request.url).hostname,
      allowedOrigin: new URL(request.url).origin,
      hardwareBound: true,
      userVerificationRequired: true,
    });
    return NextResponse.json({ authenticatorId: id, status: "ENROLLED" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ENROLLMENT_FAILED";
    const safeCode = error instanceof ProviderAdapterError
      ? `${error.code}${error.safeDetails.reason ? `_${error.safeDetails.reason}` : ""}`
      : message === "UNAUTHORIZED" ? message : "ENROLLMENT_COMPLETE_FAILED";
    console.error("LOCAL_ENROLLMENT_COMPLETE_FAILED", safeCode);
    return NextResponse.json({ error: safeCode }, { status: message === "UNAUTHORIZED" ? 401 : 400 });
  }
}
