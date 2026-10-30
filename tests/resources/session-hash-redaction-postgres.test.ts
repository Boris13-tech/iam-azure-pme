// R2 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): session network hashes can be set to
// NULL, one way only, on active and revoked sessions; every other session rule is unchanged. The
// drill runs on a scratch database so the redaction never touches other suites' rows.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const NEW = "20261023120000_session_network_hash_redaction";
const ROLLBACK = "docs/operations/SESSION-NETWORK-HASH-REDACTION-ROLLBACK.sql";
const suffix = randomUUID().slice(0, 8);

function psql(url: string, args: string[]) {
  const target = new URL(url); target.search = "";
  return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", target.toString(), ...args], { encoding: "utf8" });
}
function psqlOk(url: string, args: string[]) {
  const result = psql(url, args);
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  return result.stdout;
}
const settle = (promise: Promise<unknown>) => promise.then(() => "ACCEPTED", (error: unknown) => String(error instanceof Error ? error.message : error));

describe.runIf(enabled)("R2: one-way redaction of session network hashes (PostgreSQL)", () => {
  it("drill: guard rules, bounded owner-only redaction, lossless rollback and re-application", async () => {
    const admin = process.env.DATABASE_MIGRATION_URL!;
    if (!admin || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    const name = `luxia_r2_${suffix}`;
    psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
    const scratch = new URL(admin); scratch.pathname = `/${name}`;
    const url = scratch.toString();
    const catalog = () => psqlOk(url, ["-c", `SELECT string_agg(p.proname || ':' || md5(pg_get_functiondef(p.oid)), ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`,
      "-c", `SELECT string_agg(tgname || ':' || md5(pg_get_triggerdef(oid)), ',' ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal`]).replace(/\r/g, "");
    let db: PrismaClient | undefined;
    try {
      const prior = readdirSync("prisma/migrations").filter((dir) => /^\d{14}_/.test(dir) && dir < NEW).sort();
      for (const dir of prior) psqlOk(url, ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      const before = catalog();
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);

      db = new PrismaClient({ datasources: { db: { url } } });
      const org = randomUUID(), tenant = randomUUID(), subjectId = randomUUID(), accountId = randomUUID(), provider = randomUUID();
      const scope = { organizationId: org, tenantId: tenant };
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.organization_id', ${org}, true)`;
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        await tx.organization.create({ data: { id: org, name: "R2 drill", slug: `r2-${suffix}` } });
        await tx.tenant.create({ data: { id: tenant, organizationId: org, name: "R2 drill" } });
        await tx.providerConnection.create({ data: { id: provider, organizationId: org, providerType: "MICROSOFT_ENTRA", externalScopeId: randomUUID(), name: "Entra" } });
        await tx.subject.create({ data: { ...scope, id: subjectId, name: "Session holder", type: "HUMAN" } });
        await tx.identityAccount.create({ data: { ...scope, id: accountId, subjectId, providerConnectionId: provider, externalObjectId: randomUUID() } });
        for (const id of ids) await tx.session.create({ data: { ...scope, id, subjectId, identityAccountId: accountId,
          expiresAt: new Date(Date.now() + 3_600_000), ipHash: `ip-${id}`, userAgentHash: `ua-${id}` } });
      });
      const [active, other, revoked] = ids;
      const update = (id: string, data: Record<string, unknown>) => settle(db!.session.update({ where: { id }, data }));

      // Active session: a hash can go to NULL, never to another value, never back.
      expect(await update(active, { ipHash: "ip-forged" })).toMatch(/SESSION_IMMUTABLE/);
      expect(await update(active, { ipHash: null })).toBe("ACCEPTED");
      expect(await update(active, { ipHash: `ip-${active}` })).toMatch(/SESSION_IMMUTABLE/);
      expect(await update(active, { lastSeenAt: new Date() })).toBe("ACCEPTED");
      expect(await update(active, { expiresAt: new Date(Date.now() + 7_200_000) })).toMatch(/SESSION_IMMUTABLE/);

      // Revoked session: frozen, except the redaction alone.
      expect(await update(revoked, { revokedAt: new Date() })).toBe("ACCEPTED");
      expect(await update(revoked, { lastSeenAt: new Date() })).toMatch(/SESSION_REVOKED_IMMUTABLE/);
      expect(await update(revoked, { ipHash: `ip-${revoked}` })).toMatch(/SESSION_REVOKED_IMMUTABLE/);
      expect(await update(revoked, { ipHash: null, lastSeenAt: new Date() })).toMatch(/SESSION_REVOKED_IMMUTABLE/);
      expect(await update(revoked, { revokedAt: null, ipHash: null })).toMatch(/SESSION_REVOKED_IMMUTABLE/);
      expect(await update(revoked, { userAgentHash: null })).toBe("ACCEPTED");
      expect(await update(revoked, { userAgentHash: "ua-forged" })).toMatch(/SESSION_IMMUTABLE/);

      // The runtime role, with its usual rights and tenant context, cannot clear a hash by a direct UPDATE either.
      const runtime = new URL(process.env.DATABASE_URL!); runtime.pathname = `/${name}`;
      psqlOk(url, ["-c", `GRANT SELECT, UPDATE ON "Session" TO app_user`]);
      const direct = psql(runtime.toString(), ["-1", "-c", `SELECT set_config('app.organization_id', '${org}', true), set_config('app.tenant_id', '${tenant}', true); UPDATE "Session" SET "ipHash" = NULL WHERE "id" = '${other}'`]);
      expect(direct.status).not.toBe(0);
      expect(direct.stderr).toMatch(/SESSION_REDACTION_OWNER_ONLY/);
      expect((await db.session.findUniqueOrThrow({ where: { id: other } })).ipHash).toBe(`ip-${other}`);

      // Bounded redaction by the owner; the runtime role cannot call it.
      const redact = (batch: number) => db!.$queryRawUnsafe<Array<{ n: number }>>(`SELECT luxia_session_redact_network_hashes(${batch}) AS n`).then((rows) => rows[0].n);
      expect(await settle(redact(0))).toMatch(/REDACTION_BATCH_OUT_OF_RANGE/);
      expect(await settle(redact(10001))).toMatch(/REDACTION_BATCH_OUT_OF_RANGE/);
      expect(await redact(1)).toBe(1);
      expect(await redact(10000)).toBe(2);
      expect(await redact(10000)).toBe(0);
      expect(await db.session.count({ where: { OR: [{ ipHash: { not: null } }, { userAgentHash: { not: null } }] } })).toBe(0);
      expect(await db.session.count({ where: { id: { in: ids } } })).toBe(3);
      const denied = psql(runtime.toString(), ["-c", "SELECT luxia_session_redact_network_hashes(1)"]);
      expect(denied.status).not.toBe(0);
      expect(denied.stderr).toMatch(/permission denied/);
      await db.$disconnect(); db = undefined;

      // Rollback restores the previous guard exactly; the migration applies again.
      psqlOk(url, ["-1", "-f", ROLLBACK]);
      expect(catalog()).toBe(before);
      psqlOk(url, ["-1", "-f", `prisma/migrations/${NEW}/migration.sql`]);
      expect(catalog()).not.toBe(before);
    } finally {
      await db?.$disconnect();
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
  }, 240_000);
});
