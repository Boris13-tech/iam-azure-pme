import { operation } from "../resources/service";
import type { AuthContext } from "../auth/authorization-engine";
import { countDurableAdministrators, durableAdministratorWhere } from "../admin/last-administrator";

// Customer Self-Onboarding v1, step 7. Each item is a fact read from canonical data (true or false),
// never a score or an estimate. null means the item does not apply to this organization and is not shown.
export const CHECKLIST_ITEMS = ["domainVerified", "secondAdministrator", "recoveryCodes", "teamInvited", "firstResource", "firstAccessReview"] as const;
export type ChecklistItem = typeof CHECKLIST_ITEMS[number];
/** Who may read the checklist. The overview asks for it only when the viewer holds this (B5). */
export const ONBOARDING_CHECKLIST_PERMISSION = "subjects.read";

export function getOnboardingChecklist(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "ONBOARDING.CHECKLIST.READ", ONBOARDING_CHECKLIST_PERMISSION, async (tx) => {
    const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };
    const now = new Date();
    // Sequential: one transaction connection.
    const domains = await tx.organizationDomain.count({ where: { ...scope, status: "VERIFIED" } });
    // Durable administrators, same definition as the last-administrator guard (B1): a permanent grant
    // and an active identity account, so the second one can sign in and cannot expire on its own.
    const durableAdministrators = await countDurableAdministrators(tx, scope, now);
    // B5: the LUXIA local accounts of the durable administrators that sign in with a passkey or a
    // security key. Each one should hold at least one usable recovery code (B2), the only way back in
    // for a passkey-only administrator who loses the key. Counts only: no code or hash is read.
    const localAdministratorAccounts = await tx.identityAccount.findMany({
      where: {
        ...scope, status: "ACTIVE", subject: durableAdministratorWhere(scope, now), providerConnection: { providerType: "LUXIA_LOCAL" },
        localIdentity: { status: "ACTIVE", authenticators: { some: { status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] } } } },
      },
      select: { id: true },
    });
    const accountsWithCodes = localAdministratorAccounts.length === 0 ? 0 : (await tx.localRecoveryCode.groupBy({
      by: ["identityAccountId"],
      where: { ...scope, identityAccountId: { in: localAdministratorAccounts.map((account) => account.id) }, usedAt: null, revokedAt: null },
    })).length;
    const invitations = await tx.invitation.count({ where: scope });
    const people = await tx.subject.count({ where: { ...scope, type: "HUMAN" } });
    const resources = await tx.resource.count({ where: scope });
    const reviews = await tx.accessReviewCampaign.count({ where: scope });
    const items: Record<ChecklistItem, boolean | null> = {
      domainVerified: domains > 0,
      secondAdministrator: durableAdministrators >= 2,
      recoveryCodes: localAdministratorAccounts.length === 0 ? null : accountsWithCodes === localAdministratorAccounts.length,
      teamInvited: invitations > 0 || people > 1,
      firstResource: resources > 0,
      firstAccessReview: reviews > 0,
    };
    return { value: items };
  });
}
