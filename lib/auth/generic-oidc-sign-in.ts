import type { ProviderConnection } from "@prisma/client";
import { ProviderAdapterError } from "../provider-adapters";
import { withTenantDb } from "../db/scoped-client";
import { completeGenericOidcAuthentication } from "./providers/oidc-generic";
import { SessionCreationDeniedError, SessionStore } from "./session-store";
import { genericOidcSignInEvidence, recordRejectedSignIn } from "./sign-in-evidence";

// F4, slice S4: the end of a generic OIDC sign-in, after /auth/callback has consumed the single-use transaction, checked
// its purpose (SIGN_IN) and found the connection ACTIVE. Invariants:
//   * the connection, the scope and the configuration come from the AuthTransaction found by `state`, never from the
//     browser: the transaction binds connection + purpose + configurationHash, and a changed configuration is refused
//     before any request to the provider;
//   * the identity is found by (connection, sub) only: never by e-mail, UPN, username or any other claim, and never
//     created on the fly (no just-in-time account);
//   * no claim becomes a role, an assignment or an entitlement (the provider passes on the issuer only);
//   * the browser only ever gets one of two generic answers; what failed goes to the sign-in evidence (known identity)
//     or to a log line of constants (no token, claim value, subject, address or user agent).
export type GenericSignInOutcome =
  | Readonly<{ kind: "SESSION"; rawToken: string; expiresAt: Date }>
  | Readonly<{ kind: "REFUSED"; answer: "signin" | "unavailable" }>;

type SignInTransaction = Readonly<{ expectedOrganizationId: string; expectedTenantId: string; nonce: string; codeVerifier: string;
  expectedConfigurationHash: string | null }>;

export async function completeGenericOidcSignIn(input: {
  transaction: SignInTransaction;
  provider: Pick<ProviderConnection, "id" | "organizationId" | "providerType">;
  state: string;
  currentUrl: string;
  ip: string;
  userAgent: string;
}): Promise<GenericSignInOutcome> {
  const { transaction, provider } = input;
  const scope = { organizationId: transaction.expectedOrganizationId, tenantId: transaction.expectedTenantId };
  const refuse = (answer: "signin" | "unavailable", details: Record<string, unknown>): GenericSignInOutcome => {
    console.warn(`OIDC_SIGN_IN_REJECTED ${JSON.stringify({ providerConnectionId: provider.id, ...details })}`);
    return { kind: "REFUSED", answer };
  };

  // A generic round trip always starts bound to a configuration; one without it is not ours to complete.
  if (!transaction.expectedConfigurationHash) return refuse("signin", { stage: "TRANSACTION", reason: "CONFIGURATION_BINDING_MISSING" });

  // 1. The F1 core verifies the provider's answer (state, PKCE, token, issuer, audience, signature, algorithm, times, nonce).
  let subject: string;
  try {
    const verified = await completeGenericOidcAuthentication({
      providerConnection: provider, tenantId: transaction.expectedTenantId, state: input.state,
      nonce: transaction.nonce, codeVerifier: transaction.codeVerifier,
      expectedConfigurationHash: transaction.expectedConfigurationHash, currentUrl: input.currentUrl,
    });
    subject = verified.identity.externalObjectId;
  } catch (error) {
    if (!(error instanceof ProviderAdapterError)) return refuse("unavailable", { stage: "VERIFY", reason: "UNEXPECTED" });
    return refuse(providerUnavailable(error) ? "unavailable" : "signin", { stage: "VERIFY", code: error.code, ...error.safeDetails });
  }

  // 2. The identity: exactly this connection's account for this subject, in the expected organization and tenant.
  const account = await withTenantDb(scope, (tx) => tx.identityAccount.findUnique({
    where: { organizationId_providerConnectionId_externalObjectId: {
      organizationId: transaction.expectedOrganizationId, providerConnectionId: provider.id, externalObjectId: subject } },
    select: { id: true, tenantId: true, subjectId: true },
  }));
  // Unknown here: the same answer whether or not this subject exists on another connection or organization.
  if (!account) return refuse("signin", { stage: "IDENTITY", reason: "IDENTITY_NOT_LINKED" });
  if (account.tenantId !== transaction.expectedTenantId) return refuse("signin", { stage: "IDENTITY", reason: "TENANT_BOUNDARY" });

  // 3. The session, with its VERIFIED evidence in the same transaction (W1); a refusal for a known identity is recorded (W2).
  const identity = { ...scope, subjectId: account.subjectId, identityAccountId: account.id, providerConnectionId: provider.id };
  try {
    const { session, rawToken } = await SessionStore.createSession(
      { ...scope, subjectId: account.subjectId, identityAccountId: account.id }, input.ip, input.userAgent,
      { evidence: genericOidcSignInEvidence(identity, "VERIFIED", "OIDC_GENERIC_VERIFIED") });
    return { kind: "SESSION", rawToken, expiresAt: session.expiresAt };
  } catch (error) {
    if (!(error instanceof SessionCreationDeniedError)) throw error;
    await recordRejectedSignIn(genericOidcSignInEvidence(identity, "REJECTED", error.reason));
    return refuse("signin", { stage: "SESSION", reason: error.reason });
  }
}

/** The provider or the secret store could not answer: a temporary condition, not a refused person. */
function providerUnavailable(error: ProviderAdapterError): boolean {
  const { reason, protocolCode, providerError } = error.safeDetails;
  return ["MISCONFIGURED", "SECRET_UNAVAILABLE", "TIMEOUT", "UNAVAILABLE"].includes(error.code)
    || (typeof reason === "string" && reason.startsWith("OUTBOUND_"))
    || ["OAUTH_RESPONSE_IS_NOT_CONFORM", "OAUTH_RESPONSE_IS_NOT_JSON", "OAUTH_TIMEOUT"].includes(String(protocolCode))
    || ["server_error", "temporarily_unavailable"].includes(String(providerError));
}
