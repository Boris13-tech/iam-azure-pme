import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { rawPrisma } from "@/lib/db/raw-prisma";
import { withTenantDb } from "@/lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "@/lib/auth/session-store";
import { recordRejectedSignIn } from "@/lib/auth/sign-in-evidence";
import { getLuxiaLocalAdapter, localProviderContext } from "@/lib/auth/providers/luxia-local";
import { ProviderAdapterError } from "@/lib/provider-adapters";

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
    // Identity resolved regardless of status so that refusals of known identities are attributable (W3).
    const account = await withTenantDb({ organizationId: provider.organizationId, tenantId: body.tenantId }, (tx) => tx.identityAccount.findFirst({
      where: { providerConnectionId: provider.id, externalObjectId: verified.identity.externalObjectId }, include: { subject: true },
    }));
    if (!account) return failure();

    const e = verified.evidence;
    const evidence = (outcome: "VERIFIED" | "REJECTED", reasonCode: string): Prisma.AuthenticationEvidenceUncheckedCreateInput => ({
      id: outcome === "VERIFIED" ? e.evidenceId : randomUUID(), organizationId: e.organizationId, tenantId: e.tenantId, subjectId: account.subjectId,
      identityAccountId: account.id, providerConnectionId: provider.id, schemaVersion: e.provenance.schemaVersion,
      method: e.method, outcome, assuranceLevel: e.assurance.level,
      assuranceProfile: e.assurance.profile, assuranceProfileVersion: e.assurance.profileVersion,
      phishingResistant: e.assurance.phishingResistant, hardwareBound: e.assurance.hardwareBound,
      userVerification: e.assurance.userVerification, source: e.provenance.source,
      sourceRef: e.provenance.sourceRef, verifierPolicyVersion: e.provenance.verifierPolicyVersion,
      operationId: e.provenance.operationId, reasonCode,
      algorithmId: e.provenance.algorithmId, algorithmVersion: e.provenance.algorithmVersion,
      keyId: e.provenance.keyId, keyVersion: e.provenance.keyVersion,
      trustAnchorId: e.provenance.trustAnchorId, trustAnchorVersion: e.provenance.trustAnchorVersion,
      evidenceDigest: e.provenance.evidenceDigest, offline: e.provenance.offline,
      partitionEpoch: e.provenance.partitionEpoch ? BigInt(e.provenance.partitionEpoch) : null,
      occurredAt: new Date(e.provenance.occurredAt),
    });
    if (account.status !== "ACTIVE") { await recordRejectedSignIn(evidence("REJECTED", "IDENTITY_ACCOUNT_DISABLED")); return failure(); }
    if (account.subject.lifecycleState !== "ACTIVE") { await recordRejectedSignIn(evidence("REJECTED", "SUBJECT_NOT_ACTIVE")); return failure(); }

    let created;
    try {
      // VERIFIED evidence is written in the session transaction: no evidence means no session.
      created = await SessionStore.createSession({ organizationId: provider.organizationId, tenantId: body.tenantId, subjectId: account.subjectId, identityAccountId: account.id },
        request.headers.get("x-forwarded-for") ?? undefined, request.headers.get("user-agent") ?? undefined, { evidence: evidence("VERIFIED", e.reasonCode) });
    } catch (error) {
      if (error instanceof SessionCreationDeniedError) { await recordRejectedSignIn(evidence("REJECTED", error.reason)); return failure(); }
      throw error;
    }
    const { session, rawToken } = created;
    const response = NextResponse.json({ status: "AUTHENTICATED", redirectTo: "/dashboard" });
    response.cookies.set("luxia_session", rawToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", expires: session.expiresAt, path: "/" });
    return response;
  } catch (error) {
    if (error instanceof SessionCreationDeniedError) return failure();
    const safeCode = error instanceof ProviderAdapterError
      ? `${error.code}${error.safeDetails.reason ? `_${error.safeDetails.reason}` : ""}`
      : "LOCAL_AUTH_COMPLETE_FAILED";
    console.error("LOCAL_AUTH_COMPLETE_FAILED", safeCode);
    return NextResponse.json({ error: safeCode }, { status: 401 });
  }
}
