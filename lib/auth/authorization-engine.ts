import { withTenantDb } from "../db/scoped-client";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";

export type AuthorizationRequest = {
  action: string;
  resource: string;
};

export type AuthorizationReasonCode =
  | "ALLOW_ACTIVE_ASSIGNMENT"
  | "DENY_UNKNOWN_ENTITLEMENT"
  | "DENY_NO_ACTIVE_ASSIGNMENT"
  | "DENY_INVALID_CONTEXT";

export type AuthorizationDecision = {
  allowed: boolean;
  reasonCode: AuthorizationReasonCode;
  entitlementKey?: string;
  matchedEntitlementIds: string[];
  matchedAssignmentIds: string[];
  evaluatedAt: Date;
};

export class AuthorizationInfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AuthorizationInfrastructureError";
  }
}

/**
 * Maps a resource/action pair to a canonical V1 entitlement key.
 * If the combination is not explicitly listed in the catalog, it fails closed (returns null).
 */
export function resolveEntitlementDefinition(request: AuthorizationRequest): CatalogEntitlement | null {
  const targetKey = `${request.resource}.${request.action}`;
  if ((ENTITLEMENT_CATALOG_V1 as readonly string[]).includes(targetKey)) {
    return targetKey as CatalogEntitlement;
  }
  return null;
}

export type AuthContext = {
  organizationId: string;
  tenantId: string;
  subjectId: string;
};

/**
 * Core Native Authorization Engine for LUXIA.
 * Evaluates whether a subject has a valid, active assignment for a given action on a resource.
 * Purely deterministic, side-effect free, and strictly tenant-bound.
 */
export async function authorize(
  auth: AuthContext,
  request: AuthorizationRequest
): Promise<AuthorizationDecision> {
  const evaluatedAt = new Date();

  // 1. Resolve canonical entitlement
  const entitlementKey = resolveEntitlementDefinition(request);
  if (!entitlementKey) {
    return {
      allowed: false,
      reasonCode: "DENY_UNKNOWN_ENTITLEMENT",
      matchedEntitlementIds: [],
      matchedAssignmentIds: [],
      evaluatedAt,
    };
  }

  // 2. Validate context basics
  if (!auth.organizationId || !auth.tenantId || !auth.subjectId) {
    return {
      allowed: false,
      reasonCode: "DENY_INVALID_CONTEXT",
      entitlementKey,
      matchedEntitlementIds: [],
      matchedAssignmentIds: [],
      evaluatedAt,
    };
  }

  let assignments: any[] = [];

  try {
    // 3. Tenant-scoped database query
    await withTenantDb(
      { organizationId: auth.organizationId, tenantId: auth.tenantId },
      async (tx) => {
        assignments = await tx.assignment.findMany({
          where: {
            subjectId: auth.subjectId,
            status: "ACTIVE",
            entitlement: {
              key: entitlementKey,
            },
            OR: [
              { validFrom: null },
              { validFrom: { lte: evaluatedAt } },
            ],
            AND: [
              {
                OR: [
                  { validUntil: null },
                  { validUntil: { gt: evaluatedAt } },
                ],
              },
            ],
          },
          include: {
            entitlement: true,
          },
        });
      }
    );
  } catch (error) {
    throw new AuthorizationInfrastructureError(
      "Failed to evaluate authorization due to database or infrastructure error",
      error
    );
  }

  // 4. Decision
  if (!assignments || assignments.length === 0) {
    return {
      allowed: false,
      reasonCode: "DENY_NO_ACTIVE_ASSIGNMENT",
      entitlementKey,
      matchedEntitlementIds: [],
      matchedAssignmentIds: [],
      evaluatedAt,
    };
  }

  const matchedAssignmentIds = assignments.map((a) => a.id);
  const matchedEntitlementIds = Array.from(
    new Set(assignments.map((a) => a.entitlementId))
  );

  return {
    allowed: true,
    reasonCode: "ALLOW_ACTIVE_ASSIGNMENT",
    entitlementKey,
    matchedEntitlementIds,
    matchedAssignmentIds,
    evaluatedAt,
  };
}
