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
   * Creates a new session in the database.
   */
  static async createSession(ctx: SessionContext, ip?: string, userAgent?: string) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    
    // Sessions usually expire after some time (e.g., 24 hours)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    return await rawPrisma.session.create({
      data: {
        id: sessionId,
        organizationId: ctx.organizationId,
        tenantId: ctx.tenantId,
        subjectId: ctx.subjectId,
        identityAccountId: ctx.identityAccountId,
        expiresAt,
        ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex') : null,
        userAgentHash: userAgent ? crypto.createHash('sha256').update(userAgent).digest('hex') : null,
      }
    });
  }

  /**
   * Validates and retrieves a session.
   * Updates lastSeenAt implicitly to keep session fresh.
   */
  static async getSession(sessionId: string) {
    const session = await rawPrisma.session.findUnique({
      where: { id: sessionId }
    });

    if (!session) return null;
    
    if (session.revokedAt || session.expiresAt < new Date()) {
      return null;
    }

    // Refresh lastSeenAt in the background (fire and forget)
    rawPrisma.session.update({
      where: { id: sessionId },
      data: { lastSeenAt: new Date() }
    }).catch(console.error);

    return session;
  }

  /**
   * Revokes a specific session.
   */
  static async revokeSession(sessionId: string) {
    await rawPrisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() }
    });
  }

  /**
   * Revokes all sessions for a given subject.
   */
  static async revokeAllForSubject(subjectId: string) {
    await rawPrisma.session.updateMany({
      where: { subjectId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
}
