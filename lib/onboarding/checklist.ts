import { operation } from "../resources/service";
import type { AuthContext } from "../auth/authorization-engine";
import { countActiveAdministrators } from "../admin/last-administrator";

// Customer Self-Onboarding v1, step 7. Each item is a fact read from canonical data (true or false),
// never a score or an estimate.
export const CHECKLIST_ITEMS = ["domainVerified", "secondAdministrator", "teamInvited", "firstResource", "firstAccessReview"] as const;
export type ChecklistItem = typeof CHECKLIST_ITEMS[number];

export function getOnboardingChecklist(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "ONBOARDING.CHECKLIST.READ", "subjects.read", async (tx) => {
    const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };
    const now = new Date();
    // Sequential: one transaction connection.
    const domains = await tx.organizationDomain.count({ where: { ...scope, status: "VERIFIED" } });
    // Same definition as the last-administrator guard (B1).
    const administrators = await countActiveAdministrators(tx, scope, now);
    const invitations = await tx.invitation.count({ where: scope });
    const people = await tx.subject.count({ where: { ...scope, type: "HUMAN" } });
    const resources = await tx.resource.count({ where: scope });
    const reviews = await tx.accessReviewCampaign.count({ where: scope });
    const items: Record<ChecklistItem, boolean> = {
      domainVerified: domains > 0,
      secondAdministrator: administrators >= 2,
      teamInvited: invitations > 0 || people > 1,
      firstResource: resources > 0,
      firstAccessReview: reviews > 0,
    };
    return { value: items };
  });
}
