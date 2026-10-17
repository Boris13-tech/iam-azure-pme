import { rawPrisma } from "../db/raw-prisma";
import * as crypto from "crypto";

/** F4: why a federated round trip was started. Only SIGN_IN opens a session; the others arrive with slices S5 and S6. */
export type AuthTransactionPurpose = "SIGN_IN" | "LINK" | "ACTIVATION_PROOF";

export type AuthTransactionData = {
  stateHash: string;
  nonce: string;
  codeVerifier: string;
  expectedOrganizationId: string;
  expectedTenantId: string;
  expectedProviderConnectionId: string;
  /** Default SIGN_IN (the column default, as before F4). */
  purpose?: "SIGN_IN";
  /** F4 (S4): the configurationHash a generic OIDC round trip started with. Absent (NULL) for Microsoft. */
  expectedConfigurationHash?: string;
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
        ...(data.purpose ? { purpose: data.purpose } : {}),
        ...(data.expectedConfigurationHash ? { expectedConfigurationHash: data.expectedConfigurationHash } : {}),
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

      // F4 (S4): single use even when two callbacks race with the same state. Only the request whose update finds the
      // row still unconsumed wins; PostgreSQL re-checks the condition after waiting for the other one's row lock.
      const claimed = await tx.authTransaction.updateMany({
        where: { id: transaction.id, consumedAt: null },
        data: { consumedAt: new Date() }
      });

      return claimed.count === 1 ? transaction : null;
    });
  }
}
