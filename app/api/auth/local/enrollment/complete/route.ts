import { NextResponse } from "next/server";
import { CanonicalAdminError } from "@/lib/admin/canonical-admin-error";
import { mutationChangeId } from "@/lib/admin/http";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireRecentVerifiedAuthentication } from "@/lib/auth/step-up";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";
import { withTenantDb } from "@/lib/db/scoped-client";
import { ProviderAdapterError } from "@/lib/provider-adapters";
import { verifyMutationOrigin } from "@/lib/security/csrf-origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = await requireAuth();
    const originCheck = verifyMutationOrigin(request);
    if (!originCheck.ok) {
      return NextResponse.json({ error: "CSRF_ORIGIN_INVALID" }, { status: 403 });
    }
    // Validate x-luxia-change-id correlation header (not a standalone CSRF check).
    mutationChangeId(request);

    const body = await request.json() as Record<string, string>;
    const connection = await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
      await requireRecentVerifiedAuthentication(tx, auth);
      const account = await tx.identityAccount.findFirst({ where: { id: body.identityAccountId, subjectId: auth.subjectId, tenantId: auth.tenantId }, select: { id: true } });
      if (!account) return null;
      return tx.providerConnection.findFirst({ where: { id: body.providerConnectionId, providerType: "LUXIA_LOCAL", tenantScopes: { some: { tenantId: auth.tenantId } } }, select: { id: true } });
    });
    if (!connection) return NextResponse.json({ error: "INVALID_PROVIDER_SCOPE" }, { status: 403 });
    const trustedUrl = new URL(originCheck.expectedOrigin);
    const context = localProviderContext({ organizationId: auth.organizationId, tenantId: auth.tenantId, providerConnectionId: connection.id });
    const id = await getLuxiaLocalAdapter().enrollPasskey(context, {
      identityAccountId: body.identityAccountId,
      enrollmentTransactionId: body.transactionId,
      enrollmentChallenge: body.challenge,
      // The whole registration ceremony is verified by the adapter; the stored key is the one it proves.
      registration: { credentialId: body.credentialId, clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData, publicKey: body.publicKey },
      relyingPartyId: trustedUrl.hostname,
      allowedOrigin: trustedUrl.origin,
      enrolledBySubjectId: auth.subjectId,
    });
    return NextResponse.json({ authenticatorId: id, status: "ENROLLED" });
  } catch (error) {
    if (error instanceof CanonicalAdminError) {
      return NextResponse.json({ error: error.code }, { status: error.httpStatus });
    }
    const message = error instanceof Error ? error.message : "ENROLLMENT_FAILED";
    const safeCode = error instanceof ProviderAdapterError
      ? `${error.code}${error.safeDetails.reason ? `_${error.safeDetails.reason}` : ""}`
      : message === "UNAUTHORIZED" ? message : "ENROLLMENT_COMPLETE_FAILED";
    console.error("LOCAL_ENROLLMENT_COMPLETE_FAILED", safeCode);
    return NextResponse.json({ error: safeCode }, { status: message === "UNAUTHORIZED" ? 401 : 400 });
  }
}
