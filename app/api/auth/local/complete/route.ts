import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { withTenantDb } from "@/lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "@/lib/auth/session-store";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";

export const runtime = "nodejs";
const failure = () => NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }, { status: 401 });

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, string>;
    const provider = await rawPrisma.providerConnection.findFirst({ where: { id: body.providerConnectionId, providerType: "LUXIA_LOCAL" }, select: { id: true, organizationId: true } });
    if (!provider || !body.tenantId) return failure();
    const context = localProviderContext({ organizationId: provider.organizationId, tenantId: body.tenantId, providerConnectionId: provider.id });
    const verified = await getLuxiaLocalAdapter().completeAuthentication({
      context,
      transactionId: body.transactionId,
      response: {
        credentialType: "PASSKEY", challenge: body.challenge, externalObjectId: body.externalObjectId,
        credentialId: body.credentialId, clientDataJSON: body.clientDataJSON,
        authenticatorData: body.authenticatorData, signature: body.signature,
      },
    });
    const account = await withTenantDb({ organizationId: provider.organizationId, tenantId: body.tenantId }, (tx) => tx.identityAccount.findFirst({
      where: { providerConnectionId: provider.id, externalObjectId: verified.identity.externalObjectId, status: "ACTIVE" }, include: { subject: true },
    }));
    if (!account || account.subject.lifecycleState !== "ACTIVE") return failure();

    const e = verified.evidence;
    await withTenantDb({ organizationId: provider.organizationId, tenantId: body.tenantId }, (tx) => tx.authenticationEvidence.create({ data: {
      id: e.evidenceId, organizationId: e.organizationId, tenantId: e.tenantId, subjectId: account.subjectId,
      identityAccountId: account.id, providerConnectionId: provider.id, schemaVersion: e.provenance.schemaVersion,
      method: e.method, outcome: e.outcome, assuranceLevel: e.assurance.level,
      assuranceProfile: e.assurance.profile, assuranceProfileVersion: e.assurance.profileVersion,
      phishingResistant: e.assurance.phishingResistant, hardwareBound: e.assurance.hardwareBound,
      userVerification: e.assurance.userVerification, source: e.provenance.source,
      sourceRef: e.provenance.sourceRef, verifierPolicyVersion: e.provenance.verifierPolicyVersion,
      operationId: e.provenance.operationId, reasonCode: e.reasonCode,
      algorithmId: e.provenance.algorithmId, algorithmVersion: e.provenance.algorithmVersion,
      keyId: e.provenance.keyId, keyVersion: e.provenance.keyVersion,
      trustAnchorId: e.provenance.trustAnchorId, trustAnchorVersion: e.provenance.trustAnchorVersion,
      evidenceDigest: e.provenance.evidenceDigest, offline: e.provenance.offline,
      partitionEpoch: e.provenance.partitionEpoch ? BigInt(e.provenance.partitionEpoch) : null,
      occurredAt: new Date(e.provenance.occurredAt),
    } }));

    const { session, rawToken } = await SessionStore.createSession({ organizationId: provider.organizationId, tenantId: body.tenantId, subjectId: account.subjectId, identityAccountId: account.id }, request.headers.get("x-forwarded-for") ?? undefined, request.headers.get("user-agent") ?? undefined);
    const response = NextResponse.json({ status: "AUTHENTICATED", redirectTo: "/dashboard" });
    response.cookies.set("luxia_session", rawToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", expires: session.expiresAt, path: "/" });
    return response;
  } catch (error) {
    if (error instanceof SessionCreationDeniedError) return failure();
    return failure();
  }
}
