import { Prisma, type ProviderConnectionStatus } from "@prisma/client";
import type { AuthContext } from "../auth/authorization-engine";
import { withTenantDb } from "../db/scoped-client";
import { probeOidcIssuer, type OidcProbeInput, type OidcProbeResult } from "../provider-adapters/implementations/oidc/probe";
import { operation, requireNative } from "../resources/service";
import { CanonicalAdminError } from "./canonical-admin-error";

// F4, slice S3 (docs/architecture/F4-GENERIC-OIDC-CONNECTIONS-DESIGN.md, section 4, "Test"): an administrator tests a
// generic OIDC connection without any user. The network probe runs OUTSIDE any transaction (no governance lock held
// while an outside server answers); the journaled operation then re-reads the connection and its configuration, refuses
// if the configuration changed meanwhile, records the run in ProviderTestRun whatever its outcome, and moves a DRAFT
// connection to TESTING when the run passed. A refusal before the probe is journaled and calls nobody.
export type ConnectionTestResult = Readonly<{
  providerConnectionId: string;
  outcome: OidcProbeResult["outcome"];
  reasonCode: string;
  configurationHash: string;
  from: ProviderConnectionStatus;
  to: ProviderConnectionStatus;
  testRunId: string;
  metadata: OidcProbeResult["metadata"];
}>;
export type ConnectionTestDependencies = Readonly<{ probe: (input: OidcProbeInput) => Promise<OidcProbeResult> }>;

type Prepared = { id: string; status: ProviderConnectionStatus; configurationHash: string; probe: OidcProbeInput };

/** The connection and its configuration, in the administrator's tenant scope; refused unless it can be tested. */
async function prepare(tx: Prisma.TransactionClient, auth: AuthContext, id: string, lock: boolean): Promise<Prepared> {
  const rows = await tx.$queryRaw<Array<{ id: string; providerType: string; status: ProviderConnectionStatus }>>`
    SELECT pc."id", pc."providerType"::text AS "providerType", pc."status"::text AS status
    FROM "ProviderConnection" pc
    JOIN "ProviderConnectionTenantScope" s ON s."organizationId" = pc."organizationId" AND s."providerConnectionId" = pc."id"
    WHERE pc."organizationId" = ${auth.organizationId} AND s."tenantId" = ${auth.tenantId} AND pc."id" = ${id}
    ${lock ? Prisma.sql`FOR UPDATE OF pc` : Prisma.empty}`;
  const target = rows[0];
  if (!target) throw new CanonicalAdminError("PROVIDER_NOT_FOUND", 404);
  if (target.providerType !== "OIDC_GENERIC") throw new CanonicalAdminError("CONNECTION_TEST_UNSUPPORTED", 409);
  if (target.status !== "DRAFT" && target.status !== "TESTING") throw new CanonicalAdminError("CONNECTION_TEST_NOT_ALLOWED", 409);
  const configuration = await tx.providerOidcConfiguration.findFirst({
    where: { organizationId: auth.organizationId, providerConnectionId: target.id },
    select: { issuer: true, idTokenAlgorithm: true, clientAuthMethod: true, configurationHash: true },
  });
  if (!configuration) throw new CanonicalAdminError("CONNECTION_NOT_CONFIGURED", 409);
  return {
    id: target.id,
    status: target.status,
    configurationHash: configuration.configurationHash,
    probe: {
      issuer: configuration.issuer,
      idTokenAlgorithm: configuration.idTokenAlgorithm as OidcProbeInput["idTokenAlgorithm"],
      clientAuthMethod: configuration.clientAuthMethod as OidcProbeInput["clientAuthMethod"],
    },
  };
}

export async function testProviderConnection(auth: AuthContext, changeId: string, providerConnectionId: string,
  dependencies: ConnectionTestDependencies = { probe: probeOidcIssuer }): Promise<ConnectionTestResult> {
  let before: Prepared;
  try {
    // The permission first: nobody without providers.manage can make the server call an outside host.
    before = await withTenantDb(auth, async (tx) => {
      await requireNative(tx, auth, "providers.manage");
      return prepare(tx, auth, providerConnectionId, false);
    });
  } catch (error) {
    if (!(error instanceof CanonicalAdminError)) throw error;
    // Journaled as denied (and the permission checked) by the same operation, with no network call.
    return operation(auth, changeId, "PROVIDER.CONNECTION.TEST", "providers.manage", async () => { throw error; });
  }
  const result = await dependencies.probe(before.probe).catch((): OidcProbeResult => ({ outcome: "FAILED", reasonCode: "PROBE_FAILED", metadata: {} }));

  return operation(auth, changeId, "PROVIDER.CONNECTION.TEST", "providers.manage", async (tx) => {
    const current = await prepare(tx, auth, providerConnectionId, true);
    if (current.configurationHash !== before.configurationHash) throw new CanonicalAdminError("CONNECTION_CONFIGURATION_CHANGED", 409);
    const run = await tx.providerTestRun.create({ data: {
      organizationId: auth.organizationId, providerConnectionId: current.id, kind: "DISCOVERY", outcome: result.outcome,
      reasonCode: result.reasonCode, configurationHash: current.configurationHash, metadata: result.metadata, actorSubjectId: auth.subjectId,
    } });
    const to: ProviderConnectionStatus = result.outcome === "PASSED" && current.status === "DRAFT" ? "TESTING" : current.status;
    if (to !== current.status) {
      await tx.$executeRaw`UPDATE "ProviderConnection" SET "status" = ${to}::"ProviderConnectionStatus"
        WHERE "organizationId" = ${auth.organizationId} AND "id" = ${current.id}`;
    }
    return {
      value: { providerConnectionId: current.id, outcome: result.outcome, reasonCode: result.reasonCode,
        configurationHash: current.configurationHash, from: current.status, to, testRunId: run.id, metadata: result.metadata },
      metadata: { providerConnectionId: current.id, outcome: result.outcome, reasonCode: result.reasonCode,
        configurationHash: current.configurationHash, from: current.status, to, testRunId: run.id },
      // A failed test is recorded, and it is not a success: the journal shows it as refused, with its reason.
      auditResult: result.outcome === "PASSED" ? "SUCCESS" : "DENIED",
    };
  });
}
