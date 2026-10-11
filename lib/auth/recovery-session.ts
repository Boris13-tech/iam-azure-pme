import { cookies } from "next/headers";
import { SessionStore } from "./session-store";

// First Admin / Break-glass v1, B2: the recovery-only session (design section 5).
// getAuthContext / requireAuth never return a RECOVERY session (FULL only). This is the only way to
// read one, and only the allow-listed entry points call it (architecture test): passkey enrolment
// begin and complete, and the /recovery page. Sign-out revokes any scope through SessionStore.

declare const recoveryOnly: unique symbol;

/**
 * A recovery-only session. Deliberately not an AuthContext: its fields are nested under `recovery`
 * and branded, so it cannot be passed to a permission check, requireNative, operation() or any
 * administration function. It satisfies no permission, even for an administrator.
 */
export type RecoveryContext = Readonly<{
  [recoveryOnly]: true;
  recovery: Readonly<{
    sessionId: string;
    organizationId: string;
    tenantId: string;
    subjectId: string;
    identityAccountId: string;
    expiresAt: Date;
  }>;
}>;

export async function getRecoveryContext(): Promise<RecoveryContext | null> {
  const token = (await cookies()).get("luxia_session")?.value;
  if (!token) return null;
  const session = await SessionStore.getRecoverySession(token);
  if (!session) return null;
  return { recovery: {
    sessionId: session.id, organizationId: session.organizationId, tenantId: session.tenantId,
    subjectId: session.subjectId, identityAccountId: session.identityAccountId, expiresAt: session.expiresAt,
  } } as RecoveryContext;
}
