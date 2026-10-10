// GET /api/canonical/sessions hardening: the list never returns ipHash / userAgentHash.
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { listSessions } from "../../lib/admin/canonical-administration";

const org = randomUUID(), tenant = randomUUID(), subjectId = randomUUID(), accountId = randomUUID(), provider = randomUUID();
const scope = { organizationId: org, tenantId: tenant };
const MARK = { ip: `IPHASH-${randomUUID()}`, ua: `UAHASH-${randomUUID()}` };
let owner: PrismaClient;

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("sessions list projection (app_user PostgreSQL/RLS)", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (!(["localhost", "127.0.0.1"].includes(url.hostname) || (url.hostname === "ep-weathered-grass-ah5vrehj-pooler.c-3.us-east-1.aws.neon.tech" && ["/luxia_resources_diag_ci05"].includes(url.pathname)))) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await owner.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.organization_id', ${org}, true)`;
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      await tx.organization.create({ data: { id: org, name: "Sessions projection fixture" } });
      await tx.tenant.create({ data: { id: tenant, organizationId: org, name: "Sessions projection fixture" } });
      await tx.providerConnection.create({ data: { id: provider, organizationId: org, providerType: "MICROSOFT_ENTRA", externalScopeId: randomUUID(), name: "Entra" } });
      await tx.subject.create({ data: { ...scope, id: subjectId, name: "Session holder", type: "HUMAN" } });
      await tx.identityAccount.create({ data: { ...scope, id: accountId, subjectId, providerConnectionId: provider, externalObjectId: randomUUID() } });
      await tx.session.create({ data: { ...scope, id: randomUUID(), subjectId, identityAccountId: accountId,
        expiresAt: new Date(Date.now() + 3_600_000), ipHash: MARK.ip, userAgentHash: MARK.ua } });
    });
  }, 120_000);
  afterAll(async () => { await owner?.$disconnect(); await rawPrisma.$disconnect(); });

  it("returns the revocation handle and lifecycle fields, never ip/user-agent hashes", async () => {
    const rows = await listSessions({ ...scope, subjectId }, `read:sessions:${randomUUID()}`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "identityAccountId", "lastSeenAt",
      "organizationId", "recoveryEpoch", "revokedAt", "subjectId", "tenantId"]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(MARK.ip);
    expect(json).not.toContain(MARK.ua);
  });
});
