import { AuthContext } from "./authorization-engine";
import { authorize, AuthorizationRequest, AuthorizationDecision, AuthorizationInfrastructureError } from "./authorization-engine";
import { hasLegacyPermission } from "./legacy-auth-adapter";
import { withTenantDb } from "../db/scoped-client";

export type AuthorizationMode = "legacy" | "shadow" | "native";

export type LegacyAuthorizationDecision = {
  allowed: boolean;
  reasonCode: "LEGACY_ALLOW" | "LEGACY_DENY" | "LEGACY_ERROR";
};

type ShadowComparisonStatus =
  | "PARITY"
  | "DIVERGENCE"
  | "NATIVE_ERROR"
  | "LEGACY_ERROR";

export async function checkPermission(
  auth: AuthContext,
  request: AuthorizationRequest
): Promise<boolean> {
  const mode = (process.env.AUTHZ_MODE as AuthorizationMode) || "legacy";

  // 1. Evaluate Legacy and Native in parallel (if not strictly legacy)
  let legacyDecision: LegacyAuthorizationDecision;
  let nativeDecision: AuthorizationDecision | null = null;
  let nativeError: unknown = null;

  if (mode === "legacy") {
    try {
      const legacyAllowed = await hasLegacyPermission(auth, request.action, request.resource);
      return legacyAllowed;
    } catch (err) {
      return false; // safe fail closed
    }
  }

  // Shadow or Native mode: we run both
  try {
    const [legacyAllowed, nativeRes] = await Promise.allSettled([
      hasLegacyPermission(auth, request.action, request.resource),
      authorize(auth, request)
    ]);

    // Parse legacy
    if (legacyAllowed.status === "fulfilled") {
      legacyDecision = {
        allowed: legacyAllowed.value,
        reasonCode: legacyAllowed.value ? "LEGACY_ALLOW" : "LEGACY_DENY"
      };
    } else {
      legacyDecision = { allowed: false, reasonCode: "LEGACY_ERROR" };
    }

    // Parse native
    if (nativeRes.status === "fulfilled") {
      nativeDecision = nativeRes.value;
    } else {
      nativeError = nativeRes.reason;
    }
  } catch (err) {
    // Top-level failure
    legacyDecision = { allowed: false, reasonCode: "LEGACY_ERROR" };
    nativeError = err;
  }

  // 2. Shadow Observation (Await it to guarantee lifecycle completion in Serverless)
  if (mode === "shadow") {
    try {
      await recordObservation(auth, request, legacyDecision, nativeDecision, nativeError);
    } catch (e) {
      console.error("Failed to record authorization shadow observation", e);
    }
    // In shadow mode, legacy is STILL the absolute source of truth
    return legacyDecision.allowed;
  }

  // 4. Native mode (Future)
  if (mode === "native") {
    if (nativeError) {
      // In native mode, if infrastructure fails, it's a hard DENY (fail closed)
      console.error("Native authorization failed", nativeError);
      return false;
    }
    return nativeDecision!.allowed;
  }

  // Fallback safe DENY
  return false;
}

async function recordObservation(
  auth: AuthContext,
  request: AuthorizationRequest,
  legacyDecision: LegacyAuthorizationDecision,
  nativeDecision: AuthorizationDecision | null,
  nativeError: unknown
) {
  let status: ShadowComparisonStatus;
  
  if (legacyDecision.reasonCode === "LEGACY_ERROR") {
    status = "LEGACY_ERROR";
  } else if (nativeError) {
    status = "NATIVE_ERROR";
  } else if (legacyDecision.allowed === nativeDecision!.allowed) {
    status = "PARITY";
  } else {
    status = "DIVERGENCE";
  }

  const errorCode = nativeError instanceof Error ? nativeError.message : nativeError ? String(nativeError) : null;

  // Use scoped client to respect RLS
  await withTenantDb({ organizationId: auth.organizationId, tenantId: auth.tenantId }, async (tx) => {
    await tx.authorizationShadowObservation.create({
      data: {
        organizationId: auth.organizationId,
        tenantId: auth.tenantId,
        subjectId: auth.subjectId,
        action: request.action,
        resource: request.resource,
        legacyAllowed: legacyDecision.reasonCode !== "LEGACY_ERROR" ? legacyDecision.allowed : null,
        nativeAllowed: nativeDecision ? nativeDecision.allowed : null,
        nativeReasonCode: nativeDecision ? nativeDecision.reasonCode : null,
        status,
        nativeAssignmentIds: nativeDecision?.matchedAssignmentIds,
        nativeEntitlementIds: nativeDecision?.matchedEntitlementIds,
        errorCode,
      }
    });
  });
}
