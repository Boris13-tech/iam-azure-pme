import { rawPrisma } from "../db/raw-prisma";
import crypto from "crypto";

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

    const session = await rawPrisma.session.create({
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

    return { session, rawToken };
  }

  /**
   * Validates and retrieves a session from the raw browser token.
   */
  static async getSession(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    const session = await rawPrisma.session.findUnique({
      where: { id: hashedToken }
    });

    if (!session) return null;
    
    if (session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    // Refresh lastSeenAt only if older than 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (!session.lastSeenAt || session.lastSeenAt < fiveMinutesAgo) {
      await rawPrisma.session.update({
        where: { id: hashedToken },
        data: { lastSeenAt: new Date() }
      });
    }

    return session;
  }

  /**
   * Revokes a specific session.
   */
  static async revokeSession(rawToken: string) {
    const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    await rawPrisma.session.update({
      where: { id: hashedToken },
      data: { revokedAt: new Date() }
    });
  }

  /**
   * Revokes all sessions for a given subject securely within their organization.
   */
  static async revokeAllForSubject(organizationId: string, subjectId: string) {
    await rawPrisma.session.updateMany({
      where: { organizationId, subjectId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
}
