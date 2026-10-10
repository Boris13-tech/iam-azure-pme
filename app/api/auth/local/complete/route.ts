import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { withTenantDb } from "../../../../../lib/db/scoped-client";
import { SessionCreationDeniedError, SessionStore } from "../../../../../lib/auth/session-store";
import { recordRejectedSignIn } from "../../../../../lib/auth/sign-in-evidence";
import { getLuxiaLocalAdapter, localProviderContext } from "../../../../../lib/auth/providers/luxia-local";
import { normalizeOrganizationSlug, resolveLoginOrganization } from "../../../../../lib/auth/organization-login";
import { ProviderAdapterError } from "../../../../../lib/provider-adapters";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";
// Every refusal is the same answer (anti-enumeration); the precise reason stays in server logs.
const failure = () => NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }, { status: 401 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    if (!await allowRequest("login-complete", clientNetworkKey(request)))
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const field = (name: string) => typeof body?.[name] === "string" ? body[name] as string : "";
    const slug = normalizeOrganizationSlug(body?.organization);
    if (!slug || !UUID.test(field("transactionId"))) return failure();
    // Organization, tenant and connection come from the server-side resolution, never the browser.
    const organization = await resolveLoginOrganization(slug);
    if (!organization?.localConnectionId) return failure();
    const provider = { id: organization.localConnectionId, organizationId: organization.organizationId };
    const tenantId = organization.tenantId;
    // The identity is the one the challenge was issued for; the browser does not name it.
    const pending = await withTenantDb({ organizationId: provider.organizationId, tenantId }, (tx) => tx.localAuthChallenge.findFirst({
      where: { id: field("transactionId"), purpose: "AUTHENTICATION" },
      select: { localIdentity: { select: { identityAccount: { select: { externalObjectId: true, providerConnectionId: true } } } } },
    }));
    const challengedAccount = pending?.localIdentity.identityAccount;
    if (!challengedAccount || challengedAccount.providerConnectionId !== provider.id) return failure();
    const context = localProviderContext({ organizationId: provider.organizationId, tenantId, providerConnectionId: provider.id });
    const verified = await getLuxiaLocalAdapter().completeAuthentication({
      context,
      transactionId: field("transactionId"),
      response: {
        credentialType: "PASSKEY", challenge: field("challenge"), externalObjectId: challengedAccount.externalObjectId,
        credentialId: field("credentialId"), clientDataJSON: field("clientDataJSON"),
        authenticatorData: field("authenticatorData"), signature: field("signature"),
      },
    });
    // Identity resolved regardless of status so that refusals of known identities are attributable (W3).
    const account = await withTenantDb({ organizationId: provider.organizationId, tenantId }, (tx) => tx.identityAccount.findFirst({
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
      created = await SessionStore.createSession({ organizationId: provider.organizationId, tenantId, subjectId: account.subjectId, identityAccountId: account.id },
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
    return failure();
  }
}
