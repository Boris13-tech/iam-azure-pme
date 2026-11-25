import type { Prisma } from "@prisma/client";
import type { AuthContext } from "./auth-context";
import { CanonicalAdminError } from "../admin/canonical-admin-error";

// G2-R04: step-up authentication verification for sensitive credential mutations (passkey enrollment and
// federated unlock of a LOCKED LocalIdentity). Follows the same session + AuthenticationEvidence binding
// pattern as B2 recovery-code generation (decision R2: <= 15 minutes).
export const ENROLLMENT_STEP_UP_WINDOW_MS = 15 * 60_000;

export type VerifiedStepUpMethod = "PASSKEY" | "SECURITY_KEY" | "FEDERATED_OIDC";

export async function requireRecentVerifiedAuthentication(
  tx: Prisma.TransactionClient,
  auth: AuthContext,
  now: Date = new Date(),
): Promise<{ method: VerifiedStepUpMethod }> {
  const since = new Date(now.getTime() - ENROLLMENT_STEP_UP_WINDOW_MS);
  const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };

  const session = await tx.session.findFirst({
    where: {
      ...scope,
      id: auth.sessionId,
      subjectId: auth.subjectId,
      identityAccountId: auth.identityAccountId,
      scope: "FULL",
      revokedAt: null,
      expiresAt: { gt: now },
      createdAt: { gte: since },
    },
    select: { createdAt: true },
  });

  const evidence = session
    ? await tx.authenticationEvidence.findFirst({
        where: {
          ...scope,
          subjectId: auth.subjectId,
          identityAccountId: auth.identityAccountId,
          outcome: "VERIFIED",
          method: { in: ["PASSKEY", "SECURITY_KEY", "FEDERATED_OIDC"] },
          occurredAt: {
            gte: new Date(Math.max(since.getTime(), session.createdAt.getTime() - 120_000)),
            lte: new Date(session.createdAt.getTime() + 5_000),
          },
        },
        orderBy: { occurredAt: "desc" },
        select: { method: true },
      })
    : null;

  if (!evidence) {
    throw new CanonicalAdminError("RECENT_AUTHENTICATION_REQUIRED", 403);
  }

  return { method: evidence.method as VerifiedStepUpMethod };
}
