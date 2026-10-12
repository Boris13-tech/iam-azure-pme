import { NextResponse } from "next/server";
import { withTenantDb } from "../../../../../lib/db/scoped-client";
import { getLuxiaLocalAdapter, localProviderContext } from "../../../../../lib/auth/providers/luxia-local";
import {
  anonymousPasskeyChallenge, normalizeOrganizationSlug, normalizePrincipalName, resolveLoginOrganization, withMinimumDuration,
} from "../../../../../lib/auth/organization-login";
import { allowRequest, clientNetworkKey } from "../../../../../lib/security/rate-limit";

export const runtime = "nodejs";
const MINIMUM_MS = 400;

// Anti-enumeration (requirement 2): a known or unknown organization, a known or unknown identifier,
// and a locked or passkey-less identity all get the same 200 answer: same fields, an empty
// allowCredentials list and a fresh challenge. No credential ID is sent before verification; the
// browser offers the discoverable passkeys of this site and completion checks that the key belongs to
// the identity the challenge was issued for. The organization, tenant and connection are resolved on
// the server from the organization identifier; the browser never chooses a connection or tenant.
export async function POST(request: Request) {
  const startedAt = Date.now();
  if (!await allowRequest("login-begin", clientNetworkKey(request)))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  const body = await request.json().catch(() => null) as { organization?: unknown; principalName?: unknown } | null;
  const slug = normalizeOrganizationSlug(body?.organization);
  const principalName = normalizePrincipalName(body?.principalName);
  if (!slug || !principalName) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  const rpId = new URL(request.url).hostname;
  try {
    const real = await realChallenge(slug, principalName, rpId);
    return withMinimumDuration(startedAt, MINIMUM_MS, NextResponse.json(real ?? anonymousPasskeyChallenge(rpId)));
  } catch {
    console.error("LOCAL_AUTH_BEGIN_FAILED");
    return withMinimumDuration(startedAt, MINIMUM_MS, NextResponse.json({ error: "LOCAL_AUTHENTICATION_FAILED" }, { status: 503 }));
  }
}

async function realChallenge(slug: string, principalName: string, rpId: string) {
  const organization = await resolveLoginOrganization(slug);
  if (!organization?.localConnectionId) return null;
  const { organizationId, tenantId, localConnectionId } = organization;
  const local = await withTenantDb({ organizationId, tenantId }, (tx) => tx.localIdentity.findFirst({
    where: { principalName, status: "ACTIVE", identityAccount: { providerConnectionId: localConnectionId } },
    select: { authenticators: { where: { status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] }, credentialId: { not: null } }, select: { id: true }, take: 1 } },
  }));
  if (!local?.authenticators.length) return null;
  try {
    const challenge = await getLuxiaLocalAdapter().beginAuthentication({
      context: localProviderContext({ organizationId, tenantId, providerConnectionId: localConnectionId }), loginHint: principalName,
    });
    if (!challenge.publicChallenge?.challenge) return null;
    // Same form as anonymousPasskeyChallenge: the identity's credential IDs are never listed.
    return { transactionId: challenge.transactionId, challenge: challenge.publicChallenge.challenge, allowCredentials: [] as string[], rpId };
  } catch {
    return null; // locked or unavailable identity: same answer as an unknown one
  }
}
