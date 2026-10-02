import { rawPrisma } from "../db/raw-prisma";
import * as crypto from "crypto";

export type AuthTransactionData = {
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  expectedOrganizationId: string;
  expectedTenantId: string;
  expectedProviderConnectionId: string;
  returnTo?: string;
  expiresInMinutes?: number;
};

export class AuthTransactionStore {
  /**
   * Persists an OIDC auth transaction for PKCE/State/Nonce validation.
   */
  static async createTransaction(data: AuthTransactionData) {
    const transactionId = crypto.randomBytes(16).toString("hex");
    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + (data.expiresInMinutes || 10));

    return await rawPrisma.authTransaction.create({
      data: {
        id: transactionId,
        stateHash: data.stateHash,
        nonce: data.nonce,
        codeVerifier: data.codeVerifier,
        expectedOrganizationId: data.expectedOrganizationId,
        expectedTenantId: data.expectedTenantId,
        expectedProviderConnectionId: data.expectedProviderConnectionId,
        returnTo: data.returnTo,
        expiresAt
      }
    });
  }

  /**
   * Retrieves and immediately consumes the transaction to prevent replay attacks.
   */
  static async consumeTransaction(stateHash: string) {
    // We use a transaction to guarantee atomic consume
    return await rawPrisma.$transaction(async (tx) => {
      const transaction = await tx.authTransaction.findUnique({
        where: { stateHash }
      });

      if (!transaction) return null;
      if (transaction.consumedAt || transaction.expiresAt < new Date()) {
        return null;
      }

      await tx.authTransaction.update({
        where: { id: transaction.id },
        data: { consumedAt: new Date() }
      });

      return transaction;
    });
  }
}
