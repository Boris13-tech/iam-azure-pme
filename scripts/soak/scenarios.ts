import { AuthContext } from "../../lib/auth/authorization-engine";
import { checkPermission } from "../../lib/auth/authorization-gateway";
import { dualWriteUpdateUserRole, dualWriteRevokeUserRole } from "../../lib/auth/dual-write-service";
import { SessionStore } from "../../lib/auth/session-store";

export type SoakScenarioType = "AUTHORIZE" | "DUAL_WRITE_MEMBERSHIP" | "REVOKE_MEMBERSHIP" | "SESSION_VALIDATION";

export interface SoakScenario {
  id: string;
  type: SoakScenarioType;
  authContext: AuthContext;
  
  // For AUTHORIZE
  action?: string;
  resource?: string;
  expectedGatewayDecision?: boolean;
  expectedLegacyDecision?: boolean | null;

  // For DUAL_WRITE_MEMBERSHIP / REVOKE_MEMBERSHIP
  targetLegacyUserId?: string;
  targetRoleId?: string;

  // For SESSION_VALIDATION
  rawToken?: string;
  expectedSessionValid?: boolean;
}

export interface ScenarioResult {
  scenarioId: string;
  organizationId: string;
  tenantId: string;
  subjectId: string;
  routeOrAction: string;
  expectedLegacyDecision: boolean | null | undefined;
  gatewayDecision: boolean;
  reasonCode: string | null;
  latencyMs: number;
  timestamp: Date;
}

export async function executeScenario(scenario: SoakScenario): Promise<ScenarioResult> {
  const start = performance.now();
  
  let gatewayDecision = false;
  let reasonCode: string | null = null;
  let routeOrAction = "";

  if (scenario.type === "AUTHORIZE") {
    routeOrAction = `${scenario.action}:${scenario.resource}`;
    gatewayDecision = await checkPermission(scenario.authContext, {
      action: scenario.action!,
      resource: scenario.resource!
    });

    if (scenario.expectedGatewayDecision !== undefined && gatewayDecision !== scenario.expectedGatewayDecision) {
      throw new Error(`Scenario ${scenario.id} failed: Expected gateway decision ${scenario.expectedGatewayDecision} but got ${gatewayDecision}`);
    }

  } else if (scenario.type === "DUAL_WRITE_MEMBERSHIP") {
    routeOrAction = `ASSIGN_ROLE:${scenario.targetRoleId}`;
    try {
      await dualWriteUpdateUserRole(scenario.authContext, scenario.targetLegacyUserId!, scenario.targetRoleId!);
      gatewayDecision = true;
    } catch (e: any) {
      gatewayDecision = false;
      reasonCode = e.message;
    }
  } else if (scenario.type === "REVOKE_MEMBERSHIP") {
    routeOrAction = `REVOKE_ROLE`;
    try {
      await dualWriteRevokeUserRole(scenario.authContext, scenario.targetLegacyUserId!);
      gatewayDecision = true;
    } catch (e: any) {
      gatewayDecision = false;
      reasonCode = e.message;
    }
  } else if (scenario.type === "SESSION_VALIDATION") {
    routeOrAction = `VALIDATE_SESSION`;
    try {
      const session = await SessionStore.getSession(scenario.rawToken!);
      gatewayDecision = !!session;
      if (scenario.expectedSessionValid !== undefined && gatewayDecision !== scenario.expectedSessionValid) {
        throw new Error(`Scenario ${scenario.id} failed: Expected session validity ${scenario.expectedSessionValid} but got ${gatewayDecision}`);
      }
    } catch (e: any) {
      gatewayDecision = false;
      reasonCode = e.message;
      if (scenario.expectedSessionValid) {
        throw new Error(`Scenario ${scenario.id} failed: Expected session to be valid but got error ${reasonCode}`);
      }
    }
  }

  const latencyMs = performance.now() - start;

  return {
    scenarioId: scenario.id,
    organizationId: scenario.authContext.organizationId,
    tenantId: scenario.authContext.tenantId,
    subjectId: scenario.authContext.subjectId,
    routeOrAction,
    expectedLegacyDecision: scenario.expectedLegacyDecision,
    gatewayDecision,
    reasonCode,
    latencyMs,
    timestamp: new Date()
  };
}
