// Enterprise Identity Security Dashboard v1: response contract.
// Scope: docs/product/ENTERPRISE-IDENTITY-SECURITY-DASHBOARD-V1-SCOPE.md (D1–D5 validated).
// Four distinct states; a missing value is never coerced to 0 and there is no score.

export type WidgetState = "ok" | "unavailable" | "not_implemented" | "restricted";

export type Breakdown = Readonly<Record<string, number>>;
export type ActivityEntry = Readonly<{ id: string; operation: string; result: string; occurredAt: string;
  actorName: string | null; targetName: string | null }>;
export type WidgetValue = number | Breakdown | readonly ActivityEntry[];

export type Widget =
  | Readonly<{ id: WidgetId; state: "ok"; value: WidgetValue }>
  | Readonly<{ id: WidgetId; state: "unavailable"; reason: UnavailableReason }>
  | Readonly<{ id: WidgetId; state: "not_implemented"; reason: string }>
  // Restricted widgets carry no value, reason or count derived from data.
  | Readonly<{ id: WidgetId; state: "restricted" }>;

export type UnavailableReason = "QUERY_FAILED" | "ENTRA_EVIDENCE_NOT_RECORDED";

export type SectionId = "identity" | "sessions" | "access" | "resources" | "governance" | "activity";

export type PostureResponse = Readonly<{
  contractVersion: 1;
  asOf: string;
  organization: Readonly<{ id: string; name: string }>;
  tenant: Readonly<{ id: string; name: string }>;
  sections: Readonly<Record<SectionId, readonly Widget[]>>;
  // Deterministic rules with count > 0, only from widgets visible (state ok) to the viewer.
  attention: readonly Readonly<{ id: WidgetId; count: number; section: SectionId }>[];
}>;

type Definition = Readonly<{ section: SectionId; permissions: readonly string[]; attention?: true;
  kind: "query" | "unavailable" | "not_implemented"; reason?: string }>;

/** Single source of truth: section, required native entitlements (ALL required), attention flag. */
export const WIDGETS = {
  "identity.subjectsByLifecycle": { section: "identity", permissions: ["subjects.read"], kind: "query" },
  "identity.subjectsByType": { section: "identity", permissions: ["subjects.read"], kind: "query" },
  "identity.accountsByProvider": { section: "identity", permissions: ["identity_accounts.read"], kind: "query" },
  "identity.recoveryRequiredSubjects": { section: "identity", permissions: ["subjects.read"], attention: true, kind: "query" },
  "identity.activeSubjectsWithoutActiveAccount": { section: "identity", permissions: ["subjects.read", "identity_accounts.read"], attention: true, kind: "query" },
  "identity.unresolvedProviderCollisions": { section: "identity", permissions: ["providers.read"], attention: true, kind: "query" },

  "sessions.active": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "sessions.activeSubjects": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "sessions.activeByProvider": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "sessions.started24h": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "sessions.started7d": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "sessions.revoked7d": { section: "sessions", permissions: ["sessions.read"], kind: "query" },
  "auth.localAuthenticatorsByStatus": { section: "sessions", permissions: ["identity_accounts.read"], kind: "query" },
  "auth.compromisedLocalAuthenticators": { section: "sessions", permissions: ["identity_accounts.read"], attention: true, kind: "query" },
  "auth.lockedLocalIdentities": { section: "sessions", permissions: ["identity_accounts.read"], attention: true, kind: "query" },
  "auth.pendingCredentialReenrollments": { section: "sessions", permissions: ["identity_accounts.read"], attention: true, kind: "query" },
  "auth.localSignInEvidence7d": { section: "sessions", permissions: ["audit.read"], kind: "query" },
  "auth.entraSignInEvidence": { section: "sessions", permissions: ["audit.read"], kind: "unavailable", reason: "ENTRA_EVIDENCE_NOT_RECORDED" },
  "auth.entraMfaConditionalAccess": { section: "sessions", permissions: ["identity_accounts.read"], kind: "not_implemented", reason: "REQUIRES_PROVIDER_GRAPH_INTEGRATION" },

  "access.effectiveAssignments": { section: "access", permissions: ["assignments.read"], kind: "query" },
  "access.effectiveHolders": { section: "access", permissions: ["assignments.read"], kind: "query" },
  "access.effectiveBySource": { section: "access", permissions: ["assignments.read"], kind: "query" },
  "access.timeBoundVsPermanent": { section: "access", permissions: ["assignments.read"], kind: "query" },
  "access.administrativeEntitlementHolders": { section: "access", permissions: ["assignments.read"], kind: "query" },
  "access.nonActiveSubjectsWithEffectiveAccess": { section: "access", permissions: ["assignments.read", "subjects.read"], attention: true, kind: "query" },
  "access.expiringWithin7d": { section: "access", permissions: ["assignments.read"], attention: true, kind: "query" },
  "access.activeRowsPastValidity": { section: "access", permissions: ["assignments.read"], attention: true, kind: "query" },
  "access.effectiveLegacyRoleAssignments": { section: "access", permissions: ["assignments.read"], attention: true, kind: "query" },

  "resources.activeByType": { section: "resources", permissions: ["resources.read"], kind: "query" },
  "resources.activeScopesByKind": { section: "resources", permissions: ["resources.read"], kind: "query" },
  "resources.activeScopedEntitlements": { section: "resources", permissions: ["resources.read"], kind: "query" },
  "resources.withoutEffectiveHolder": { section: "resources", permissions: ["resources.read", "assignments.read"], kind: "query" },
  "resources.providerBoundVsNative": { section: "resources", permissions: ["resources.read"], kind: "query" },

  "governance.sodPoliciesByStatus": { section: "governance", permissions: ["sod.read"], kind: "query" },
  "governance.sodEnabledRules": { section: "governance", permissions: ["sod.read"], kind: "query" },
  "governance.sodDeniedAttempts30d": { section: "governance", permissions: ["sod.read"], kind: "query" },
  "governance.sodExistingViolations": { section: "governance", permissions: ["sod.read"], kind: "not_implemented", reason: "SOD_ENGINE_IS_PREVENTIVE_ONLY" },
  "governance.reviewCampaignsByStatus": { section: "governance", permissions: ["access_reviews.read"], kind: "query" },
  "governance.overdueReviewCampaigns": { section: "governance", permissions: ["access_reviews.read"], attention: true, kind: "query" },
  "governance.pendingReviewItems": { section: "governance", permissions: ["access_reviews.read"], attention: true, kind: "query" },
  "governance.reviewItemsRequiringRemediation": { section: "governance", permissions: ["access_reviews.read"], attention: true, kind: "query" },
  "governance.myPendingReviewDecisions": { section: "governance", permissions: ["access_reviews.decide"], attention: true, kind: "query" },

  "activity.recentChangesAndDenials": { section: "activity", permissions: ["audit.read"], kind: "query" },
  "activity.deniedOrFailed24h": { section: "activity", permissions: ["audit.read"], kind: "query" },
  "activity.deniedOrFailed7d": { section: "activity", permissions: ["audit.read"], kind: "query" },
  "activity.privilegedChanges7d": { section: "activity", permissions: ["audit.read"], kind: "query" },
} as const satisfies Record<string, Definition>;

export type WidgetId = keyof typeof WIDGETS;
export const SECTION_ORDER: readonly SectionId[] = ["identity", "sessions", "access", "resources", "governance", "activity"];
export const WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

export const isPermitted = (id: WidgetId, held: ReadonlySet<string>) =>
  (WIDGETS[id].permissions as readonly string[]).every(key => held.has(key));

/** Numeric value of an attention widget; breakdowns are not attention rules. */
export function attentionCount(widget: Widget): number | null {
  if (widget.state !== "ok" || !(WIDGETS[widget.id] as Definition).attention) return null;
  return typeof widget.value === "number" ? widget.value : null;
}
