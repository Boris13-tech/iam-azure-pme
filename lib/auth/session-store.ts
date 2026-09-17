import { rawPrisma } from "../db/raw-prisma";
import { withTenantDb } from "../db/scoped-client";
import * as crypto from "crypto";

export type SessionContext = {
  organizationId: string;
  tenantId: string;
  subjectId: string;
  identityAccountId: string;
};

export class SessionStore {
  /**
   * Creates a new session.
   * Returns the unhashed token for the browser and the persisted session object.
   */
  static async createSession(ctx: SessionContext, ip?: string, userAgent?: string) {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    const session = await withTenantDb(
      { organizationId: ctx.organizationId, tenantId: ctx.tenantId },
      async (tx) => tx.session.create({
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
      })
    );

    return { session, rawToken };
  }

  /**
   * Validates and retrieves a session from the raw browser token.
   */
  static async getSession(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    // Resolve session securely bypassing RLS via DB primitive
    const sessions = await rawPrisma.$queryRaw<Array<{
      id: string;
      organizationId: string;
      tenantId: string;
      subjectId: string;
      identityAccountId: string;
      expiresAt: Date;
      revokedAt: Date | null;
      lastSeenAt: Date | null;
    }>>`SELECT * FROM resolve_session(${hashedToken})`;

    if (!sessions || sessions.length === 0) return null;
    const session = sessions[0];
    
    if (session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    // Refresh lastSeenAt only if older than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (!session.lastSeenAt || session.lastSeenAt < fiveMinutesAgo) {
      // Re-enter Tenant DB with correct scope to update
      await withTenantDb(
        { organizationId: session.organizationId, tenantId: session.tenantId },
        async (tx) => tx.session.update({
          where: { id: hashedToken },
          data: { lastSeenAt: new Date() }
        })
      );
    }

    return session;
  }

  /**
   * Revokes a specific session securely (idempotent).
   * Returns the revoked session if it existed, otherwise null.
   */
  static async revokeByToken(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    
    // Resolve first using primitive
    const sessions = await rawPrisma.$queryRaw<Array<{
      id: string;
      organizationId: string;
      tenantId: string;
      subjectId: string;
      identityAccountId: string;
      revokedAt: Date | null;
    }>>`SELECT * FROM resolve_session(${hashedToken})`;

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

      if (session && !session.revokedAt) {
        await tx.session.update({
          where: { id: hashedToken },
          data: { revokedAt: new Date() }
        });
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
