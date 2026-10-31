import type { Prisma } from "@prisma/client";
import { operation } from "../resources/service";
import type { AuthContext } from "../auth/authorization-engine";
import { countDurableAdministrators, durableAdministratorWhere } from "../admin/last-administrator";

// Customer Self-Onboarding v1, step 7. Each item is a fact read from canonical data (true or false),
// never a score or an estimate. null means the item is not shown: it does not apply to this organization, or the
// viewer does not hold its read right. In the second case it does not depend on the data, and its query does not run.
export const CHECKLIST_ITEMS = ["domainVerified", "secondAdministrator", "recoveryCodes", "teamInvited", "firstResource", "firstAccessReview"] as const;
export type ChecklistItem = typeof CHECKLIST_ITEMS[number];
/** Who may read the checklist. The overview asks for it only when the viewer holds this (B5). */
export const ONBOARDING_CHECKLIST_PERMISSION = "subjects.read";

/**
 * The rights that show each item: any one of the lists, all the rights of that list. An item goes to someone who
 * could already establish that fact from what they may read, not to whoever holds a right named after its table.
 * - firstAccessReview is about the organization: it needs a view of every campaign, so read alone (a partial view,
 *   which would show a false "not done") gets nothing, and manage alone cannot read campaigns.
 * - recoveryCodes has no reader elsewhere (a person reads only their own): it goes to who appoints administrators.
 */
export const CHECKLIST_ITEM_RIGHTS: Readonly<Record<ChecklistItem, ReadonlyArray<readonly string[]>>> = {
  domainVerified: [["providers.read"]],
  secondAdministrator: [["assignments.read", "identity_accounts.read"]],
  recoveryCodes: [["assignments.manage", "identity_accounts.read"]],
  teamInvited: [["subjects.read"]],
  firstResource: [["resources.read"]],
  firstAccessReview: [["access_reviews.read_all"], ["access_reviews.read", "access_reviews.manage"]],
};
const mayRead = (item: ChecklistItem, held: ReadonlySet<string>) => CHECKLIST_ITEM_RIGHTS[item].some((rights) => rights.every((right) => held.has(right)));

/** The viewer's effective global entitlement keys, with requireNative's semantics. */
async function heldRights(tx: Prisma.TransactionClient, auth: AuthContext, now: Date): Promise<Set<string>> {
  const keys = [...new Set(Object.values(CHECKLIST_ITEM_RIGHTS).flat(2))];
  const rows = await tx.assignment.findMany({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, subjectId: auth.subjectId,
    status: "ACTIVE", source: { not: "LEGACY_ROLE" }, OR: [{ validFrom: null }, { validFrom: { lte: now } }],
    AND: [{ OR: [{ validUntil: null }, { validUntil: { gt: now } }] }],
    entitlement: { key: { in: keys }, active: true, resourceScopeId: null } }, select: { entitlement: { select: { key: true } } } });
  return new Set(rows.map((row) => row.entitlement.key));
}

/** Runs only the queries of the items the viewer may read. Sequential: one transaction connection. */
export async function readChecklist(tx: Prisma.TransactionClient, scope: { organizationId: string; tenantId: string }, held: ReadonlySet<string>, now: Date) {
  const domainVerified = async () => await tx.organizationDomain.count({ where: { ...scope, status: "VERIFIED" } }) > 0;
  // Durable administrators, same definition as the last-administrator guard (B1): a permanent grant
  // and an active identity account, so the second one can sign in and cannot expire on its own.
  const secondAdministrator = async () => await countDurableAdministrators(tx, scope, now) >= 2;
  // B5: the LUXIA local accounts of the durable administrators that sign in with a passkey or a
  // security key. Each one should hold at least one usable recovery code (B2), the only way back in
  // for a passkey-only administrator who loses the key. Counts only: no code or hash is read.
  const recoveryCodes = async () => {
    const localAdministratorAccounts = await tx.identityAccount.findMany({
      where: {
        ...scope, status: "ACTIVE", subject: durableAdministratorWhere(scope, now), providerConnection: { providerType: "LUXIA_LOCAL" },
        localIdentity: { status: "ACTIVE", authenticators: { some: { status: "ACTIVE", type: { in: ["PASSKEY", "SECURITY_KEY"] } } } },
      },
      select: { id: true },
    });
    if (localAdministratorAccounts.length === 0) return null;
    const accountsWithCodes = (await tx.localRecoveryCode.groupBy({
      by: ["identityAccountId"],
      where: { ...scope, identityAccountId: { in: localAdministratorAccounts.map((account) => account.id) }, usedAt: null, revokedAt: null },
    })).length;
    return accountsWithCodes === localAdministratorAccounts.length;
  };
  const teamInvited = async () => await tx.invitation.count({ where: scope }) > 0 || await tx.subject.count({ where: { ...scope, type: "HUMAN" } }) > 1;
  const firstResource = async () => await tx.resource.count({ where: scope }) > 0;
  const firstAccessReview = async () => await tx.accessReviewCampaign.count({ where: scope }) > 0;
  const items: Record<ChecklistItem, boolean | null> = {
    domainVerified: mayRead("domainVerified", held) ? await domainVerified() : null,
    secondAdministrator: mayRead("secondAdministrator", held) ? await secondAdministrator() : null,
    recoveryCodes: mayRead("recoveryCodes", held) ? await recoveryCodes() : null,
    teamInvited: mayRead("teamInvited", held) ? await teamInvited() : null,
    firstResource: mayRead("firstResource", held) ? await firstResource() : null,
    firstAccessReview: mayRead("firstAccessReview", held) ? await firstAccessReview() : null,
  };
  return items;
}

export function getOnboardingChecklist(auth: AuthContext, changeId: string) {
  return operation(auth, changeId, "ONBOARDING.CHECKLIST.READ", ONBOARDING_CHECKLIST_PERMISSION, async (tx) => {
    const now = new Date();
    const held = await heldRights(tx, auth, now);
    return { value: await readChecklist(tx, { organizationId: auth.organizationId, tenantId: auth.tenantId }, held, now) };
  });
}
