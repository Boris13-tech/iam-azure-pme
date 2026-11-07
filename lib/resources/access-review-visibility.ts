import type { Prisma } from "@prisma/client";

// One campaign-visibility rule for the access review API and the dashboard counters, so a counter can never
// reveal more campaigns than the viewer can open.
//   access_reviews.read      the campaigns the viewer reviews or created
//   access_reviews.read_all  every campaign of the tenant, read only (grants no action)
//   access_reviews.manage    every campaign of the tenant (it manages them)
// Without read or read_all nothing is readable; action rights are always checked separately.
export const REVIEW_READ_RIGHTS = ["access_reviews.read", "access_reviews.read_all"] as const;
export const REVIEW_ALL_CAMPAIGNS_RIGHTS = ["access_reviews.read_all", "access_reviews.manage"] as const;

type Viewer = { organizationId: string; tenantId: string; subjectId: string };
export function campaignVisibility(viewer: Viewer, held: ReadonlySet<string>): Prisma.AccessReviewCampaignWhereInput {
  const scope = { organizationId: viewer.organizationId, tenantId: viewer.tenantId };
  if (REVIEW_ALL_CAMPAIGNS_RIGHTS.some(key => held.has(key))) return scope;
  return { ...scope, OR: [{ reviewerSubjectId: viewer.subjectId }, { createdBySubjectId: viewer.subjectId }] };
}
