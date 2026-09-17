import { rawPrisma } from "../db/raw-prisma";
import { ENTITLEMENT_CATALOG_V1, CatalogEntitlement } from "./entitlements-catalog";
import { mapLegacyPermission } from "./legacy-permission-map";

export interface ReadinessReport {
  subjectsChecked: number;
  scopeResolved?: boolean;
  legacyActiveGrants: number;
  expectedNativeGrants: number;
  nativeActiveGrants: number;
  missingNativeGrants: number;
  unexpectedNativeGrants: number;
  expiredRevokedInconsistencies: number;
  orphanLegacyRoleAssignments: number;
  unknownSourceRef: number;
  unbridgedLegacyUsers: number;
}

export async function runAuthorizationReconciliation(organizationId: string, tenantId: string): Promise<ReadinessReport> {
  const report: ReadinessReport = {
    subjectsChecked: 0,
    legacyActiveGrants: 0,
    expectedNativeGrants: 0,
    nativeActiveGrants: 0,
    missingNativeGrants: 0,
    unexpectedNativeGrants: 0,
    expiredRevokedInconsistencies: 0,
    orphanLegacyRoleAssignments: 0,
    unknownSourceRef: 0,
    unbridgedLegacyUsers: 0
  };

  // 1. Fetch all subjects in the given tenant
  const subjects = await withTenantDb({ organizationId, tenantId, subjectId: "system", type: "SYSTEM" as any }, async (tx) => tx.subject.findMany({
    where: { organizationId, tenantId },
    include: {
      legacyBridge: {
        include: {
          legacyUser: {
            include: {
              roles: {
                include: {
                  role: {
                    include: {
                      permissions: {
                        include: {
                          permission: true
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      Assignment: {
        include: {
          entitlement: true
        }
      }
    }
  }));

  if (subjects.length === 0) { report.scopeResolved = true; return report; }

  // Track valid role IDs for orphan checks
  const allRoles = await rawPrisma.role.findMany({ select: { id: true } });
  const validRoleIds = new Set(allRoles.map(r => r.id));

  for (const subject of subjects) {
    report.subjectsChecked++;

    const bridge = subject.legacyBridge;
    if (!bridge || bridge.status !== "VALIDATED" || !bridge.legacyUser) {
      report.unbridgedLegacyUsers++;
      continue;
    }

    const legacyUser = bridge.legacyUser;

    // A. Compute Expected Native Grants from Legacy
    // Map: EntitlementKey -> Set of SourceRefs (Role IDs)
    const expectedGrants = new Map<string, Set<string>>();

    for (const userRole of legacyUser.roles) {
      const role = userRole.role;
      report.legacyActiveGrants++; // counting each userRole as a legacy grant
      
      const addExpected = (key: string) => {
        if (!expectedGrants.has(key)) expectedGrants.set(key, new Set());
        expectedGrants.get(key)!.add(role.id);
      };

      if (role.name === "Administrateur") {
        ENTITLEMENT_CATALOG_V1.forEach(addExpected);
      } else {
        for (const rp of role.permissions) {
          const mapped = mapLegacyPermission(rp.permission.resource, rp.permission.action);
          if (mapped) addExpected(mapped);
        }
      }
    }

    // B. Analyze Actual Native Assignments
    const activeAssignments = subject.Assignment.filter(a => a.status === "ACTIVE");
    const nonActiveAssignments = subject.Assignment.filter(a => a.status !== "ACTIVE");
    
    report.nativeActiveGrants += activeAssignments.length;

    // Track what we found natively
    // Map: EntitlementKey -> Set of SourceRefs
    const actualGrants = new Map<string, Set<string>>();
    for (const a of activeAssignments) {
      if (a.source === "LEGACY_ROLE" && a.sourceRef) {
        if (!actualGrants.has(a.entitlement.key)) actualGrants.set(a.entitlement.key, new Set());
        actualGrants.get(a.entitlement.key)!.add(a.sourceRef);

        if (!validRoleIds.has(a.sourceRef)) {
          report.orphanLegacyRoleAssignments++;
        } else {
          // Is this role actually held by the user?
          const userHasRole = legacyUser.roles.some(ur => ur.roleId === a.sourceRef);
          if (!userHasRole) {
            report.orphanLegacyRoleAssignments++;
          }
        }
      } else if (a.source === "LEGACY_ROLE" && !a.sourceRef) {
        report.unknownSourceRef++;
      }
    }

    // C. Compare Expected vs Actual
    let subjectExpectedCount = 0;
    
    // Check for missing
    for (const [key, expectedSources] of Array.from(expectedGrants.entries())) {
      subjectExpectedCount += expectedSources.size;
      const actualSources = actualGrants.get(key) || new Set();
      
      for (const expectedSource of Array.from(expectedSources)) {
        if (!actualSources.has(expectedSource)) {
          report.missingNativeGrants++;
        }
      }
    }
    report.expectedNativeGrants += subjectExpectedCount;

    // Check for unexpected
    for (const [key, actualSources] of Array.from(actualGrants.entries())) {
      const expectedSources = expectedGrants.get(key) || new Set();
      for (const actualSource of Array.from(actualSources)) {
        if (!expectedSources.has(actualSource)) {
          report.unexpectedNativeGrants++;
        }
      }
    }

    // Check for inconsistent non-active
    // If a grant is expected, but there is a non-active assignment for that same sourceRef, 
    // it's an inconsistency only if there is NO active assignment for it.
    for (const na of nonActiveAssignments) {
      if (na.source === "LEGACY_ROLE" && na.sourceRef) {
        const expectedSourcesForKey = expectedGrants.get(na.entitlement.key);
        if (expectedSourcesForKey && expectedSourcesForKey.has(na.sourceRef)) {
          // It's expected to be active! Is there an active one to compensate?
          const activeSourcesForKey = actualGrants.get(na.entitlement.key);
          if (!activeSourcesForKey || !activeSourcesForKey.has(na.sourceRef)) {
            report.expiredRevokedInconsistencies++;
          }
        }
      }
    }
  }

  return report;
}
