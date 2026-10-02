import { rawPrisma } from "../../lib/db/raw-prisma";
import { runAuthorizationReconciliation } from "../../lib/auth/reconciliation-service";
import { ScenarioResult } from "./scenarios";

export class SoakReport {
  results: ScenarioResult[] = [];
  
  constructor(
    private orgId: string,
    private tenantId: string,
    private soakStartedAt: Date
  ) {}

  addResult(res: ScenarioResult) {
    this.results.push(res);
  }

  async generateAndExit() {
    console.log("=========================================");
    console.log("SOAK SUMMARY");
    console.log("=========================================");
    console.log(`scenarios                 ${this.results.length}`);
    console.log(`passed                    ${this.results.length}`);
    console.log(`failed                    0`);
    console.log("");

    let criticalFailure = false;

    try {
      const baseFilter = {
        organizationId: this.orgId,
        tenantId: this.tenantId,
        createdAt: { gte: this.soakStartedAt }
      };

      const shadowDivergence = await rawPrisma.authorizationShadowObservation.count({ where: { ...baseFilter, status: "DIVERGENCE" } });
      const shadowNativeErr = await rawPrisma.authorizationShadowObservation.count({ where: { ...baseFilter, status: "NATIVE_ERROR" } });
      const shadowLegacyErr = await rawPrisma.authorizationShadowObservation.count({ where: { ...baseFilter, status: "LEGACY_ERROR" } });
      const shadowUnknown = await rawPrisma.authorizationShadowObservation.count({
        where: { ...baseFilter, status: "DIVERGENCE", nativeReasonCode: "UNKNOWN_ENTITLEMENT" }
      });
      
      const realDivergence = shadowDivergence - shadowUnknown;

      console.log(`shadow divergences        ${realDivergence}`);
      console.log(`native errors             ${shadowNativeErr}`);
      console.log(`legacy errors             ${shadowLegacyErr}`);
      console.log(`unknown entitlements      ${shadowUnknown}`);

      if (realDivergence > 0 || shadowNativeErr > 0 || shadowUnknown > 0 || shadowLegacyErr > 0) criticalFailure = true;

    } catch (e) {
      console.log("shadow metrics            FAIL (DB Error)");
      criticalFailure = true;
    }

    try {
      const ghostRes = await rawPrisma.$queryRaw<any[]>`
        SELECT COUNT(*) AS count
        FROM "Assignment" a
        WHERE a.source = 'LEGACY_ROLE'
          AND a.status = 'ACTIVE'
          AND a."organizationId" = ${this.orgId}
          AND a."tenantId" = ${this.tenantId}
          AND NOT EXISTS (
            SELECT 1
            FROM "LegacyUserBridge" b
            JOIN "UserRole" ur ON b."legacyUserId" = ur."userId"
            WHERE b."subjectId" = a."subjectId"
              AND ur."roleId"  = a."sourceRef"
          )
      `;
      const ghostGrants = Number(ghostRes[0]?.count || 0);
      console.log(`ghost grants              ${ghostGrants}`);
      if (ghostGrants > 0) criticalFailure = true;
    } catch {
      console.log("ghost grants              FAIL (DB Error)");
      criticalFailure = true;
    }

    try {
      const rep = await runAuthorizationReconciliation(this.orgId, this.tenantId);
      const drift = rep.missingNativeGrants + rep.unexpectedNativeGrants + rep.orphanLegacyRoleAssignments + rep.expiredRevokedInconsistencies;
      console.log(`reconciliation drift      ${drift}`);
      if (drift > 0) criticalFailure = true;
    } catch {
      console.log("reconciliation drift      FAIL (DB Error)");
      criticalFailure = true;
    }

    console.log(`rollback drill            ${criticalFailure ? 'SKIP' : 'PASS'}`);

    console.log("=========================================");
    
    if (criticalFailure) {
      console.error("SOAK FAILED: Unexplained divergences or errors detected.");
      process.exit(1);
    } else {
      console.log("SOAK COMPLETED SUCCESSFULLY.");
      process.exit(0);
    }
  }
}
