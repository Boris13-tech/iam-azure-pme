import { randomBytes } from "node:crypto";
import { Prisma, type ProviderConnectionStatus } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { getAuthContext } from "../auth/auth-context";
import { beginGenericOidcAuthentication, completeGenericOidcAuthentication } from "../auth/providers/oidc-generic";
import { withTenantDb } from "../db/scoped-client";
import { ProviderAdapterError } from "../provider-adapters";
import { operation, requireNative } from "../resources/service";
import { CanonicalAdminError } from "./canonical-admin-error";

// F4, slice S5 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 4, "Proof sign-in"): an administrator
// signs in once at the provider of a TESTING connection, to prove the whole flow (redirect, client secret, token,
// signature, claims) before it can be activated. What a proof is NOT:
//   * not a sign-in: it opens no session, creates no account, links nobody, and keeps no subject (`sub`) or claim;
//   * not a proof of the administrator's identity at the provider (that account is linked to nothing before slice S6).
// A proof is bound to the administrator who started it (same FULL session in the same browser at the callback), to the
// connection, to its configuration hash and to the secret version in force; any change in between refuses it. The
// network calls run outside any transaction; every outcome is recorded (ProviderTestRun, kind PROOF) and journaled.
export const PROOF_RETURN_PATH = "/dashboard";
const PROOF_LIFETIME_MINUTES = 10;

type ProofTarget = Readonly<{ id: string; organizationId: string; status: ProviderConnectionStatus; configurationHash: string;
  issuerHost: string; secretVersion: string }>;
export type ProofStart = Readonly<{ providerConnectionId: string; authorizationUrl: string; expiresAt: string }>;
export type ProofResult = Readonly<{ providerConnectionId: string; outcome: "PASSED" | "FAILED"; reasonCode: string; testRunId: string }>;
export type ProofDependencies = Readonly<{
  begin: typeof beginGenericOidcAuthentication;
  complete: typeof completeGenericOidcAuthentication;
}>;
const DEFAULT_DEPENDENCIES: ProofDependencies = { begin: beginGenericOidcAuthentication, complete: completeGenericOidcAuthentication };

/** A TESTING generic connection of the administrator's scope, configured and with a live secret reference. */
async function proofTarget(tx: Prisma.TransactionClient, auth: Pick<AuthContext, "organizationId" | "tenantId">, id: string, lock: boolean): Promise<ProofTarget> {
  const rows = await tx.$queryRaw<Array<{ id: string; organizationId: string; providerType: string; status: ProviderConnectionStatus }>>`
    SELECT pc."id", pc."organizationId", pc."providerType"::text AS "providerType", pc."status"::text AS status
    FROM "ProviderConnection" pc
    JOIN "ProviderConnectionTenantScope" s ON s."organizationId" = pc."organizationId" AND s."providerConnectionId" = pc."id"
    WHERE pc."organizationId" = ${auth.organizationId} AND s."tenantId" = ${auth.tenantId} AND pc."id" = ${id}
    ${lock ? Prisma.sql`FOR UPDATE OF pc` : Prisma.empty}`;
  const target = rows[0];
  if (!target) throw new CanonicalAdminError("PROVIDER_NOT_FOUND", 404);
  if (target.providerType !== "OIDC_GENERIC") throw new CanonicalAdminError("CONNECTION_PROOF_UNSUPPORTED", 409);
  if (target.status !== "TESTING") throw new CanonicalAdminError("CONNECTION_PROOF_NOT_ALLOWED", 409);
  const configuration = await tx.providerOidcConfiguration.findFirst({
    where: { organizationId: auth.organizationId, providerConnectionId: target.id },
    select: { issuer: true, configurationHash: true },
  });
  if (!configuration) throw new CanonicalAdminError("CONNECTION_NOT_CONFIGURED", 409);
  const secret = await tx.providerSecretReference.findFirst({
    where: { organizationId: auth.organizationId, providerConnectionId: target.id, purpose: "OIDC_CLIENT", revokedAt: null },
    select: { activeVersion: true },
  });
  if (!secret) throw new CanonicalAdminError("CONNECTION_SECRET_MISSING", 409);
  return { id: target.id, organizationId: target.organizationId, status: target.status, configurationHash: configuration.configurationHash,
    issuerHost: new URL(configuration.issuer).hostname, secretVersion: secret.activeVersion };
}

/** Journals a refusal decided before any network call (and checks the permission again, as every operation does). */
const denied = <T>(auth: AuthContext, changeId: string, name: string, error: CanonicalAdminError): Promise<T> =>
  operation(auth, changeId, name, "providers.manage", async () => { throw error; });

/** Starts a proof: returns the provider's authorization URL for the administrator's browser. */
export async function startConnectionProof(auth: AuthContext, changeId: string, providerConnectionId: string,
  dependencies: ProofDependencies = DEFAULT_DEPENDENCIES): Promise<ProofStart> {
  const NAME = "PROVIDER.CONNECTION.PROOF.START";
  let before: ProofTarget;
  try {
    // The permission first: nobody without providers.manage makes the server call an outside host.
    before = await withTenantDb(auth, async (tx) => {
      await requireNative(tx, auth, "providers.manage");
      return proofTarget(tx, auth, providerConnectionId, false);
    });
  } catch (error) {
    if (!(error instanceof CanonicalAdminError)) throw error;
    return denied(auth, changeId, NAME, error);
  }
  // Outside any transaction: discovery reaches the provider (through the SSRF guard).
  let challenge: Awaited<ReturnType<ProofDependencies["begin"]>>;
  try {
    challenge = await dependencies.begin({ providerConnection: { id: before.id, organizationId: before.organizationId, providerType: "OIDC_GENERIC" },
      tenantId: auth.tenantId, returnTo: PROOF_RETURN_PATH });
  } catch {
    return denied(auth, changeId, NAME, new CanonicalAdminError("PROVIDER_UNAVAILABLE", 503));
  }
  const { nonce, codeVerifier, configurationHash } = challenge.continuation ?? {};
  const authorizationUrl = challenge.redirectUrl;
  if (!authorizationUrl || !nonce || !codeVerifier || !configurationHash) throw new Error("Invalid proof challenge");

  return operation(auth, changeId, NAME, "providers.manage", async (tx) => {
    const current = await proofTarget(tx, auth, providerConnectionId, true);
    // The challenge was built on this exact configuration and nothing changed since.
    if (current.configurationHash !== before.configurationHash || configurationHash !== current.configurationHash) {
      throw new CanonicalAdminError("CONNECTION_CONFIGURATION_CHANGED", 409);
    }
    const expiresAt = new Date(Date.now() + PROOF_LIFETIME_MINUTES * 60_000);
    await tx.authTransaction.create({ data: {
      id: randomBytes(16).toString("hex"), stateHash: challenge.transactionId, nonce, codeVerifier,
      expectedOrganizationId: auth.organizationId, expectedTenantId: auth.tenantId, expectedProviderConnectionId: current.id,
      purpose: "ACTIVATION_PROOF", subjectId: auth.subjectId, expectedConfigurationHash: current.configurationHash,
      returnTo: PROOF_RETURN_PATH, expiresAt,
    } });
    return {
      value: { providerConnectionId: current.id, authorizationUrl, expiresAt: expiresAt.toISOString() },
      metadata: { providerConnectionId: current.id, configurationHash: current.configurationHash, issuerHost: current.issuerHost },
    };
  });
}

type ProofTransaction = Readonly<{ id: string; expectedOrganizationId: string; expectedTenantId: string; expectedProviderConnectionId: string;
  subjectId: string | null; nonce: string; codeVerifier: string; expectedConfigurationHash: string | null }>;

/**
 * Completes a proof at /auth/callback, after the transaction (purpose ACTIVATION_PROOF) was consumed. Returns the only
 * two answers the browser gets. The administrator's session in this browser must be the one that started the proof;
 * otherwise nothing is called and nothing is recorded.
 */
export async function completeConnectionProof(input: { transaction: ProofTransaction; state: string; currentUrl: string },
  dependencies: ProofDependencies = DEFAULT_DEPENDENCIES): Promise<"passed" | "failed"> {
  const { transaction } = input;
  const auth = await getAuthContext();
  if (!auth || !transaction.subjectId || auth.subjectId !== transaction.subjectId
    || auth.organizationId !== transaction.expectedOrganizationId || auth.tenantId !== transaction.expectedTenantId
    || !transaction.expectedConfigurationHash) {
    console.warn(`OIDC_PROOF_REJECTED ${JSON.stringify({ providerConnectionId: transaction.expectedProviderConnectionId, reason: "PROOF_SESSION_MISMATCH" })}`);
    return "failed";
  }
  try {
    const result = await recordProof(auth, transaction, input, dependencies);
    return result.outcome === "PASSED" ? "passed" : "failed";
  } catch (error) {
    if (!(error instanceof CanonicalAdminError)) throw error;
    return "failed";
  }
}

async function recordProof(auth: AuthContext, transaction: ProofTransaction, input: { state: string; currentUrl: string },
  dependencies: ProofDependencies): Promise<ProofResult> {
  const NAME = "PROVIDER.CONNECTION.PROOF";
  const changeId = `proof:${transaction.id}`;
  const id = transaction.expectedProviderConnectionId;
  let before: ProofTarget;
  try {
    before = await withTenantDb(auth, async (tx) => {
      await requireNative(tx, auth, "providers.manage");
      const target = await proofTarget(tx, auth, id, false);
      if (target.configurationHash !== transaction.expectedConfigurationHash) throw new CanonicalAdminError("CONNECTION_CONFIGURATION_CHANGED", 409);
      return target;
    });
  } catch (error) {
    if (!(error instanceof CanonicalAdminError)) throw error;
    return denied(auth, changeId, NAME, error);
  }

  // Outside any transaction: the F1 core verifies the provider's answer exactly as for a sign-in. The verified subject
  // is dropped here: a proof keeps no identity.
  let outcome: "PASSED" | "FAILED" = "PASSED";
  let reasonCode = "PROOF_PASSED";
  let details: Record<string, string> = {};
  try {
    await dependencies.complete({
      providerConnection: { id: before.id, organizationId: before.organizationId, providerType: "OIDC_GENERIC" }, tenantId: auth.tenantId,
      state: input.state, nonce: transaction.nonce, codeVerifier: transaction.codeVerifier,
      expectedConfigurationHash: transaction.expectedConfigurationHash!, currentUrl: input.currentUrl,
    });
  } catch (error) {
    outcome = "FAILED";
    ({ reasonCode, details } = proofFailure(error));
  }

  return operation(auth, changeId, NAME, "providers.manage", async (tx) => {
    const current = await proofTarget(tx, auth, id, true);
    if (current.configurationHash !== before.configurationHash) throw new CanonicalAdminError("CONNECTION_CONFIGURATION_CHANGED", 409);
    // A secret rotated during the round trip: what was proven is no longer what is in force.
    if (current.secretVersion !== before.secretVersion) throw new CanonicalAdminError("CONNECTION_SECRET_CHANGED", 409);
    const run = await tx.providerTestRun.create({ data: {
      organizationId: auth.organizationId, providerConnectionId: current.id, kind: "PROOF", outcome, reasonCode,
      configurationHash: current.configurationHash, actorSubjectId: auth.subjectId,
      metadata: { issuerHost: current.issuerHost, secretVersion: current.secretVersion, ...details },
    } });
    const result = { providerConnectionId: current.id, outcome, reasonCode, testRunId: run.id };
    return {
      value: result,
      metadata: { ...result, configurationHash: current.configurationHash },
      auditResult: outcome === "PASSED" ? "SUCCESS" : "DENIED",
    };
  });
}

/** Safe constants only: the core's reason or the library's error code, the failed claim's name, the provider's error code. */
function proofFailure(error: unknown): { reasonCode: string; details: Record<string, string> } {
  if (!(error instanceof ProviderAdapterError)) return { reasonCode: "PROOF_FAILED", details: {} };
  const { reason, protocolCode, claim, providerError } = error.safeDetails;
  const candidate = [reason, protocolCode, error.code].find((value): value is string => typeof value === "string" && /^[A-Z0-9_]{1,64}$/.test(value));
  const details: Record<string, string> = {};
  if (typeof claim === "string") details.claim = claim;
  if (typeof providerError === "string") details.providerError = providerError;
  return { reasonCode: candidate ?? "PROOF_FAILED", details };
}
