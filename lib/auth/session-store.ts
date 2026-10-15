import type { Prisma } from "@prisma/client";
import { rawPrisma } from "../db/raw-prisma";
import { withTenantDb } from "../db/scoped-client";
import { lockOrganizationActive, lockProviderConnectionActive } from "../organizations/lifecycle";
import * as crypto from "crypto";

export type SessionContext = {
  organizationId: string;
  tenantId: string;
  subjectId: string;
  identityAccountId: string;
};

export class SessionCreationDeniedError extends Error {
  constructor(public readonly reason: "IDENTITY_ACCOUNT_DISABLED" | "SUBJECT_NOT_ACTIVE" | "ORGANIZATION_NOT_ACTIVE" | "PROVIDER_CONNECTION_NOT_ACTIVE") {
    super(reason);
    this.name = "SessionCreationDeniedError";
  }
}

/** One row of luxia_session_resolve, the canonical session resolver. */
type ResolvedSession = {
  id: string;
  organizationId: string;
  tenantId: string;
  subjectId: string;
  identityAccountId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  scope: "FULL" | "RECOVERY";
};

export class SessionStore {
  /**
   * Creates a new session.
   * Returns the unhashed token for the browser and the persisted session object.
   */
  static async createSession(ctx: SessionContext, ip?: string, userAgent?: string,
    options: { evidence?: Prisma.AuthenticationEvidenceUncheckedCreateInput } = {}) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const session = await withTenantDb(
      { organizationId: ctx.organizationId, tenantId: ctx.tenantId },
      async (tx) => {
        // B3: the organization row is share-locked first; a SUSPENDED or CLOSED organization gets no
        // session, and a status change waits until this transaction ends.
        if (!await lockOrganizationActive(tx, ctx.organizationId)) {
          throw new SessionCreationDeniedError("ORGANIZATION_NOT_ACTIVE");
        }
        // F2 kill switch: a session is opened only through an ACTIVE connection (share-locked, same as B3).
        if (!await lockProviderConnectionActive(tx, ctx.organizationId, ctx.identityAccountId)) {
          throw new SessionCreationDeniedError("PROVIDER_CONNECTION_NOT_ACTIVE");
        }
        const account = await tx.identityAccount.findFirst({
          where: { id: ctx.identityAccountId, subjectId: ctx.subjectId },
          include: { subject: { select: { lifecycleState: true } } },
        });
        if (!account || account.status !== "ACTIVE") {
          throw new SessionCreationDeniedError("IDENTITY_ACCOUNT_DISABLED");
        }
        if (account.subject.lifecycleState !== "ACTIVE") {
          throw new SessionCreationDeniedError("SUBJECT_NOT_ACTIVE");
        }
        // Security Journal v1 (W1): the sign-in evidence is written in the same transaction as the
        // session. If it cannot be written, the transaction fails and no session exists (fail closed).
        if (options.evidence) {
          if (options.evidence.outcome !== "VERIFIED" || options.evidence.subjectId !== ctx.subjectId ||
            options.evidence.identityAccountId !== ctx.identityAccountId) throw new Error("SIGN_IN_EVIDENCE_MISMATCH");
          await tx.authenticationEvidence.create({ data: options.evidence });
        }
        return tx.session.create({
        data: {
          id: hashedToken,
          organizationId: ctx.organizationId,
          tenantId: ctx.tenantId,
          subjectId: ctx.subjectId,
          identityAccountId: ctx.identityAccountId,
          expiresAt,
          ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex') : null,
          userAgentHash: userAgent ? crypto.createHash('sha256').update(userAgent).digest('hex') : null,
          lastSeenAt: new Date()
        }
        });
      }
    );

    return { session, rawToken };
  }

  /**
   * Validates and retrieves a session from the raw browser token.
   */
  static async getSession(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    // B3: the canonical resolver (database) returns nothing unless the organization and the subject
    // are ACTIVE and the identity account is ACTIVE. Only FULL sessions are accepted here; a RECOVERY
    // session is read only through getRecoverySession (B2 allow-list).
    const sessions = await rawPrisma.$queryRaw<Array<ResolvedSession>>`SELECT * FROM luxia_session_resolve(${hashedToken})`;

    if (!sessions || sessions.length === 0) return null;
    const session = sessions[0];
    
    if (session.scope !== "FULL" || session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    // Refresh lastSeenAt only if older than 5 minutes. Conditional: a session revoked in the
    // meantime is frozen, and the refresh then changes nothing instead of failing the request.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (!session.lastSeenAt || session.lastSeenAt < fiveMinutesAgo) {
      await SessionStore.touch(session.organizationId, session.tenantId, hashedToken);
    }

    return session;
  }

  /**
   * B2: a recovery-only session (scope RECOVERY), through the same canonical resolver. Only
   * getRecoveryContext calls it (architecture test). Never refreshed: nothing extends its 15 minutes.
   */
  static async getRecoverySession(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    const sessions = await rawPrisma.$queryRaw<Array<ResolvedSession>>`SELECT * FROM luxia_session_resolve(${hashedToken})`;
    const session = sessions?.[0];
    if (!session || session.scope !== "RECOVERY" || session.revokedAt || session.expiresAt <= new Date()) return null;
    return session;
  }

  /** Conditional lastSeenAt refresh: never touches a revoked session. Returns whether it updated. */
  static async touch(organizationId: string, tenantId: string, hashedToken: string): Promise<boolean> {
    const updated = await withTenantDb({ organizationId, tenantId }, (tx) => tx.session.updateMany({
      where: { id: hashedToken, revokedAt: null },
      data: { lastSeenAt: new Date() },
    }));
    return updated.count === 1;
  }

  /**
   * Revokes a specific session securely (idempotent).
   * Returns the revoked session if it existed, otherwise null.
   */
  static async revokeByToken(rawToken: string, options: { signOutAudit?: boolean } = {}) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    // Resolve first through the canonical resolver (any scope: sign-out is always allowed).
    const sessions = await rawPrisma.$queryRaw<Array<ResolvedSession>>`SELECT * FROM luxia_session_resolve(${hashedToken})`;

    if (!sessions || sessions.length === 0) return null;
    const sessionBootstrap = sessions[0];
    
    const scope = { organizationId: sessionBootstrap.organizationId, tenantId: sessionBootstrap.tenantId };
    
    return await withTenantDb(scope, async (tx) => {
      // We fetch it first to return it (useful for federated logout)
      const session = await tx.session.findUnique({
        where: { id: hashedToken },
        include: {
          identityAccount: {
            include: {
              providerConnection: true
            }
          }
        }
      });

      // Conditional: two concurrent sign-outs revoke once and record one event; the second is a no-op.
      const revoked = session && !session.revokedAt
        ? (await tx.session.updateMany({ where: { id: hashedToken, revokedAt: null }, data: { revokedAt: new Date() } })).count
        : 0;
      if (session && revoked === 1) {
        // Security Journal v1 (W4): sign-out recorded atomically with the revocation, once.
        if (options.signOutAudit) {
          await tx.canonicalAdminAuditEvent.create({ data: {
            organizationId: session.organizationId, tenantId: session.tenantId,
            actorSubjectId: session.subjectId, targetSubjectId: session.subjectId,
            operation: "SESSION.SIGN_OUT", result: "SUCCESS", changeId: `signout:${crypto.randomUUID()}`,
            metadata: { providerType: session.identityAccount?.providerConnection?.providerType ?? null },
          } });
        }
      }

      return session;
    });
  }

  /**
   * Revokes all sessions for a given subject securely within their organization.
   */
  static async revokeAllForSubject(organizationId: string, tenantId: string, subjectId: string) {
    await withTenantDb(
      { organizationId, tenantId },
      async (tx) => tx.session.updateMany({
        where: { organizationId, subjectId, revokedAt: null },
        data: { revokedAt: new Date() }
      })
    );
  }
}
