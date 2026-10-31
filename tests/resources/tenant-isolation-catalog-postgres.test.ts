// I2 in two parts, kept apart. Configuration: what the catalog declares, for every table holding an organization.
// Behaviour: what the runtime role really sees, with a row of another organization present, on a disposable database this
// file creates, neutralizes table by table, restores and drops, so that no other suite ever sees RLS turned off.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The sorted set of tables that hold an organization and are not protected as below. Reviewed separately; a change to
// the set changes this digest, and means a new review.
const UNPROTECTED_SET_SHA256 = "08c9bb3d98cade69650ddeb5efeec9672d910aac3191162a9a0e10fe5e0a1719";
// The only conditions a policy may have. Anything else, a true, an OR, is outside the rule and needs a new review.
const scope = (organization: string, tenant?: string) => {
  const org = `("organizationId" = current_setting('${organization}'::text, true))`;
  return tenant ? `(${org} AND ("tenantId" = current_setting('${tenant}'::text, true)))` : org;
};
const SCOPED = [scope("app.organization_id"), scope("app.organization_id", "app.tenant_id"), scope("app.current_organization_id", "app.current_tenant_id")];

type Policy = { name: string; permissive: boolean; qual: string | null; check: string | null };
type Row = { table: string; rls: boolean; force: boolean; policies: Policy[] };

async function catalog(db: PrismaClient): Promise<Row[]> {
  return db.$queryRawUnsafe<Row[]>(`
    SELECT c.relname AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', p.polname, 'permissive', p.polpermissive,
        'qual', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)) ORDER BY p.polname)
        FROM pg_policy p WHERE p.polrelid = c.oid), '[]'::jsonb) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attname IN ('organizationId', 'expectedOrganizationId'))
    ORDER BY c.relname`);
}
// Protected: row-level security on and forced, and every permissive policy scoped. With none, PostgreSQL refuses every row.
const isProtected = (row: Row) => row.rls && row.force
  && row.policies.filter((policy) => policy.permissive).every((policy) => SCOPED.includes(policy.qual ?? "") && SCOPED.includes(policy.check ?? ""));
const unprotected = (rows: Row[]) => rows.filter((row) => !isProtected(row)).map((row) => row.table).sort();
const digest = (names: string[]) => createHash("sha256").update(names.join(",")).digest("hex");

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("Tenant isolation: catalog and behaviour (PostgreSQL)", () => {
  const admin = process.env.DATABASE_MIGRATION_URL!;

  describe("configuration, read from the catalog", () => {
    const owner = new PrismaClient({ datasources: { db: { url: admin } } });
    const runtime = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    afterAll(async () => { await owner.$disconnect(); await runtime.$disconnect(); });

    it("the application's role cannot go around row-level security", async () => {
      const [role] = await runtime.$queryRawUnsafe<Array<Record<string, unknown>>>(`
        SELECT current_user AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
          (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owned,
          (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
        FROM pg_roles r WHERE r.rolname = current_user`);
      expect(role).toEqual({ name: "app_user", superuser: false, bypass: false, owned: 0, memberships: 0 });
    });

    it("every table holding an organization is protected, or is in the reviewed set", async () => {
      const rows = await catalog(owner);
      expect(rows.length).toBeGreaterThan(30);
      const open = unprotected(rows);
      expect(digest(open), `${open.length} unprotected tables: the set changed, review it`).toBe(UNPROTECTED_SET_SHA256);
    });
  });

  describe("behaviour, as the runtime role, on a disposable database", () => {
    const name = `luxia_iso_${randomUUID().slice(0, 8)}`;
    const url = new URL(admin); url.pathname = `/${name}`;
    const psql = (target: string, args: string[], input?: string) => {
      const clean = new URL(target); clean.search = "";
      return spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", clean.toString(), ...args], { encoding: "utf8", input });
    };
    const psqlOk = (target: string, args: string[], input?: string) => {
      const result = psql(target, args, input);
      if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
      return result.stdout;
    };
    let owner: PrismaClient, runtime: PrismaClient, tables: string[], closed: string[], baseline: Row[];
    const orgA = `iso-a-${randomUUID()}`, orgB = `iso-b-${randomUUID()}`, tenantA = `iso-ta-${randomUUID()}`, tenantB = `iso-tb-${randomUUID()}`;

    /** A row for one table, from its own columns: triggers and foreign keys are off for this fixture only. */
    async function insertSql(table: string, organization: string, tenant: string) {
      const columns = await owner.$queryRawUnsafe<Array<{ column: string; type: string; base: string; udt: string }>>(`
        SELECT a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, t.typtype::text AS base, t.typname AS udt
        FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
        WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          AND (a.attname IN ('organizationId', 'tenantId') OR (a.attnotnull AND NOT a.atthasdef AND a.attidentity = ''))`);
      const value = ({ column, type, base, udt }: { column: string; type: string; base: string; udt: string }) => {
        if (column === "organizationId") return `'${organization}'`;
        if (column === "tenantId") return `'${tenant}'`;
        if (base === "e") return `(SELECT min(enumlabel)::"${udt}" FROM pg_enum WHERE enumtypid = '"${udt}"'::regtype)`;
        if (type.endsWith("[]")) return `'{}'`;
        if (/^(text|character|uuid)/.test(type)) return type === "uuid" ? `gen_random_uuid()` : `'${randomUUID()}'`;
        if (/^timestamp/.test(type)) return "now()";
        if (/int|numeric/.test(type)) return "1";
        if (type === "boolean") return "false";
        if (/^jsonb?$/.test(type)) return `'{}'`;
        if (type === "bytea") return `'\\x00'`;
        throw new Error(`No fixture value for ${table}.${column}: ${type}`);
      };
      return `INSERT INTO "${table}" (${columns.map((c) => `"${c.column}"`).join(", ")}) VALUES (${columns.map(value).join(", ")})`;
    }
    const inContext = async <T>(work: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>) => {
      let result: T | undefined;
      const rollback = new Error("rollback");
      await runtime.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.organization_id', '${orgA}', true), set_config('app.tenant_id', '${tenantA}', true),
          set_config('app.current_organization_id', '${orgA}', true), set_config('app.current_tenant_id', '${tenantA}', true)`);
        result = await work(tx);
        throw rollback; // what a check wrote never stays
      }).catch((error) => { if (error !== rollback) throw error; });
      return result as T;
    };
    /** What is wrong for this table as the runtime role. Empty means isolated, with rows of both organizations present. */
    async function breaches(table: string) {
      const found: string[] = [];
      const counts = await inContext((tx) => tx.$queryRawUnsafe<Array<{ own: number; foreign: number }>>(`
        SELECT count(*) FILTER (WHERE "organizationId" = '${orgA}')::int AS own, count(*) FILTER (WHERE "organizationId" <> '${orgA}')::int AS foreign FROM "${table}"`));
      if (counts[0].own < 1) found.push("own row not visible: this proves nothing");
      if (counts[0].foreign !== 0) found.push("another organization's row is visible");
      const [{ n }] = await runtime.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`);
      if (n !== 0) found.push("rows are visible with no context");
      const written = await inContext((tx) => tx.$executeRawUnsafe(`UPDATE "${table}" SET "organizationId" = "organizationId" WHERE "organizationId" = '${orgB}'`)).catch(() => 0);
      if (written !== 0) found.push("another organization's row can be updated");
      const insert = await insertSql(table, orgB, tenantB);
      const inserted = await inContext((tx) => tx.$executeRawUnsafe(insert)).catch(() => 0);
      if (inserted !== 0) found.push("a row can be written for another organization");
      return found;
    }
    const stillClean = async () => expect(await catalog(owner)).toEqual(baseline);

    beforeAll(async () => {
      psqlOk(admin, ["-c", `CREATE DATABASE ${name}`]);
      for (const dir of readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort())
        psqlOk(url.toString(), ["-1", "-f", `prisma/migrations/${dir}/migration.sql`]);
      psqlOk(url.toString(), [], readFileSync("scripts/ci/bootstrap-app-user.sql", "utf8").replace(/luxia_db/g, name));
      owner = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const runtimeUrl = new URL(process.env.DATABASE_URL!); runtimeUrl.pathname = `/${name}`;
      runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } } });
      baseline = await catalog(owner);
      tables = baseline.filter((row) => isProtected(row) && row.policies.length > 0).map((row) => row.table);
      closed = baseline.filter((row) => isProtected(row) && row.policies.length === 0).map((row) => row.table);
      // One generic row per table, on this copy only: its CHECK constraints go, since they play no part in row-level security.
      psqlOk(url.toString(), ["-c", `DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.conrelid::regclass AS t, c.conname FROM pg_constraint c
        JOIN pg_class k ON k.oid = c.conrelid WHERE c.contype = 'c' AND k.relnamespace = 'public'::regnamespace LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.t, r.conname); END LOOP; END $$`]);
      for (const table of [...tables, ...closed]) {
        const [a, b] = [await insertSql(table, orgA, tenantA), await insertSql(table, orgB, tenantB)];
        await owner.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
          await tx.$executeRawUnsafe(a);
          await tx.$executeRawUnsafe(b);
        });
      }
    }, 240_000);

    afterAll(async () => {
      await owner?.$disconnect();
      await runtime?.$disconnect();
      psql(admin, ["-c", `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    });

    it("on every table with a policy, each organization sees and writes only its own rows", async () => {
      expect(tables).toEqual(expect.arrayContaining(["Subject", "Assignment", "Entitlement", "AccessReviewItem", "Resource", "ResourceScope"]));
      expect(tables.length).toBeGreaterThan(30);
      const found: Record<string, string[]> = {};
      for (const table of tables) { const wrong = await breaches(table); if (wrong.length) found[table] = wrong; }
      expect(found).toEqual({});
    }, 180_000);

    it("a table forced with no policy gives the runtime role nothing, whatever its grants", async () => {
      expect(closed.length).toBeGreaterThan(0);
      for (const table of closed) {
        psqlOk(url.toString(), ["-c", `GRANT SELECT ON "${table}" TO app_user`]);
        const [{ n }] = await inContext((tx) => tx.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "${table}"`));
        psqlOk(url.toString(), ["-c", `REVOKE SELECT ON "${table}" FROM app_user`]);
        expect(n, table).toBe(0);
        const [{ rows }] = await owner.$queryRawUnsafe<Array<{ rows: number }>>(`SELECT count(*)::int AS rows FROM "${table}"`);
        expect(rows, table).toBe(2);
      }
      await stillClean();
    }, 60_000);

    it("row-level security off on a table: behaviour and configuration both see it, on every table", async () => {
      for (const table of tables) {
        psqlOk(url.toString(), ["-1", "-c", `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY; ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`]);
        const seen = await breaches(table);
        const config = unprotected(await catalog(owner));
        psqlOk(url.toString(), ["-1", "-c", `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`]);
        expect(seen, table).toContain("another organization's row is visible");
        expect(config, table).toContain(table);
      }
      await stillClean();
    }, 240_000);

    it("a policy opened with the flags kept on: behaviour and configuration both see it, on every table", async () => {
      for (const table of tables) {
        const policy = baseline.find((row) => row.table === table)!.policies[0];
        psqlOk(url.toString(), ["-c", `ALTER POLICY "${policy.name}" ON "${table}" USING (true) WITH CHECK (true)`]);
        const seen = await breaches(table);
        const config = unprotected(await catalog(owner));
        psqlOk(url.toString(), ["-c", `ALTER POLICY "${policy.name}" ON "${table}" USING (${policy.qual}) WITH CHECK (${policy.check})`]);
        expect(seen, table).toContain("another organization's row is visible");
        expect(config, table).toContain(table);
      }
      await stillClean();
    }, 240_000);

    it("a table with several policies: a scoped second one changes nothing, an open second one or RLS off is seen", async () => {
      const qual = baseline.find((row) => row.table === "Subject")!.policies[0].qual;
      psqlOk(url.toString(), ["-c", `CREATE POLICY iso_second ON "Subject" USING (${qual}) WITH CHECK (${qual})`]);
      expect(await breaches("Subject")).toEqual([]);
      expect(unprotected(await catalog(owner))).not.toContain("Subject");
      psqlOk(url.toString(), ["-c", `ALTER POLICY iso_second ON "Subject" USING (true) WITH CHECK (true)`]);
      expect(await breaches("Subject")).toContain("another organization's row is visible");
      expect(unprotected(await catalog(owner))).toContain("Subject");
      psqlOk(url.toString(), ["-c", `ALTER POLICY iso_second ON "Subject" USING (${qual}) WITH CHECK (${qual})`]);
      psqlOk(url.toString(), ["-c", `ALTER TABLE "Subject" DISABLE ROW LEVEL SECURITY`]);
      expect(await breaches("Subject")).toContain("another organization's row is visible");
      psqlOk(url.toString(), ["-c", `ALTER TABLE "Subject" ENABLE ROW LEVEL SECURITY`]);
      psqlOk(url.toString(), ["-c", `DROP POLICY iso_second ON "Subject"`]);
      await stillClean();
    }, 60_000);

    it("force off is a configuration fault; the runtime role does not own the table, so behaviour does not change", async () => {
      psqlOk(url.toString(), ["-c", `ALTER TABLE "Resource" NO FORCE ROW LEVEL SECURITY`]);
      const config = unprotected(await catalog(owner)), seen = await breaches("Resource");
      psqlOk(url.toString(), ["-c", `ALTER TABLE "Resource" FORCE ROW LEVEL SECURITY`]);
      expect(config).toContain("Resource");
      expect(seen).toEqual([]);
      await stillClean();
    }, 60_000);

    it("a new table holding an organization changes the reviewed set until it is protected", async () => {
      const before = digest(unprotected(await catalog(owner)));
      expect(before).toBe(UNPROTECTED_SET_SHA256);
      psqlOk(url.toString(), ["-c", `CREATE TABLE "IsoProbe" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL); GRANT ALL ON "IsoProbe" TO app_user`]);
      expect(digest(unprotected(await catalog(owner)))).not.toBe(before);
      psqlOk(url.toString(), ["-c", `DROP TABLE "IsoProbe"`]);
      await stillClean();
    }, 60_000);
  });
});
