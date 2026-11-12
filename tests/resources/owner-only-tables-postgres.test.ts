// Owner-only tables (row-level security forced, no policy) carry two independent barriers for the runtime role: no
// privilege, and row-level security that shows and accepts no row. Read from the catalog, so a new owner-only table is
// covered without a list: after the CI bootstrap (the mirror of the Production activation gate), app_user holds no
// privilege on any of them, nor on the sequences they own.
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

describe.runIf(process.env.LUXIA_RESOURCE_RLS === "true")("owner-only tables: no runtime privilege (PostgreSQL)", () => {
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  afterAll(async () => { await owner.$disconnect(); });

  it("no table privilege on any table with forced row-level security and no policy, nor on its sequences", async () => {
    const tables = await owner.$queryRawUnsafe<Array<{ name: string; privileges: string[]; sequences: string[] }>>(`
      SELECT c.relname AS name,
        ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
              WHERE has_table_privilege('app_user', c.oid, p)) AS privileges,
        ARRAY(SELECT s.relname || ':' || p FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
              CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p
              WHERE d.refobjid = c.oid AND d.deptype IN ('a', 'i') AND has_sequence_privilege('app_user', s.oid, p)) AS sequences
      FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
      ORDER BY c.relname`);
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["OrganizationErasure", "RetentionRun", "SignupCode", "RateLimitBucket", "RateLimitConfig"]));
    expect(tables.filter((t) => t.privileges.length > 0 || t.sequences.length > 0)).toEqual([]);
  });
});
