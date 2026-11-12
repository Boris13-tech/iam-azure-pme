import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawPrisma } from "../../lib/db/raw-prisma";
import { runtimeRoleRestricted } from "../../lib/monitoring/readiness";

// Readiness (#189): the application's database role must be the restricted runtime role. Proven on PostgreSQL with
// real roles, not a mocked answer (Codex, review of 4c89997): the runtime role passes; a superuser, a member of a
// BYPASSRLS role (directly, through another role, or without INHERIT), and the owner of a table, a schema, a function
// or a type, directly or through membership, all fail. Roles and objects are created by the owner and dropped after.
const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const sfx = randomUUID().slice(0, 8).replace(/-/g, "");
const login = `rd_${sfx}_login`, password = randomBytes(18).toString("hex");
// A login role that does not inherit what it is granted (the role attribute, valid on every PostgreSQL version: CI runs
// 15 for these suites, Production 17). It can still SET ROLE to a role it is a member of.
const noInherit = `rd_${sfx}_noinh`;
const groups = { bypass: `rd_${sfx}_bypass`, mid: `rd_${sfx}_mid`, owner: `rd_${sfx}_owner` };
const schema = `rd_${sfx}`;
let owner: PrismaClient;
const sql = (statement: string) => owner.$executeRawUnsafe(statement);

/** The check, run in a session of a login role itself. */
async function restrictedAsLogin(role = login): Promise<boolean> {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = role; url.password = password;
  const client = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try { return await runtimeRoleRestricted(client); } finally { await client.$disconnect(); }
}

describe.runIf(enabled)("readiness: the runtime role check on PostgreSQL, with real roles", () => {
  beforeAll(async () => {
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL! } } });
    await sql(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await sql(`CREATE ROLE ${noInherit} LOGIN NOINHERIT PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await sql(`CREATE ROLE ${groups.bypass} NOLOGIN BYPASSRLS`);
    await sql(`CREATE ROLE ${groups.mid} NOLOGIN`);
    await sql(`CREATE ROLE ${groups.owner} NOLOGIN`);
    await sql(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    if (!owner) return;
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of [login, noInherit, groups.bypass, groups.mid, groups.owner]) {
      await sql(`DROP OWNED BY ${role} CASCADE`).catch(() => undefined);
      await sql(`DROP ROLE IF EXISTS ${role}`);
    }
    await owner.$disconnect();
  }, 30_000);

  it("the application's runtime role passes; the owner connection fails", async () => {
    expect(await runtimeRoleRestricted(rawPrisma)).toBe(true);
    expect(await runtimeRoleRestricted(owner)).toBe(false);
  }, 30_000);

  it("a plain login role with nothing passes", async () => {
    expect(await restrictedAsLogin()).toBe(true);
  }, 30_000);

  it("a member of a BYPASSRLS role fails: directly, through another role, and without INHERIT", async () => {
    await sql(`GRANT ${groups.bypass} TO ${login}`);
    expect(await restrictedAsLogin(), "direct").toBe(false);
    await sql(`REVOKE ${groups.bypass} FROM ${login}`);
    await sql(`GRANT ${groups.bypass} TO ${groups.mid}`);
    await sql(`GRANT ${groups.mid} TO ${login}`);
    expect(await restrictedAsLogin(), "through another role").toBe(false);
    await sql(`REVOKE ${groups.mid} FROM ${login}`);
    await sql(`REVOKE ${groups.bypass} FROM ${groups.mid}`);
    expect(await restrictedAsLogin(noInherit), "a NOINHERIT role, before the grant").toBe(true);
    await sql(`GRANT ${groups.bypass} TO ${noInherit}`);
    expect(await restrictedAsLogin(noInherit), "a NOINHERIT role: SET ROLE still reaches it").toBe(false);
    await sql(`REVOKE ${groups.bypass} FROM ${noInherit}`);
    expect(await restrictedAsLogin(), "membership removed").toBe(true);
  }, 30_000);

  it("the owner of a table, a schema, a function or a type fails, directly or through membership", async () => {
    const owned: Array<[string, string, string]> = [
      ["a table", `CREATE TABLE ${schema}.t (x int)`, `ALTER TABLE ${schema}.t OWNER TO`],
      ["a function", `CREATE FUNCTION ${schema}.f() RETURNS int LANGUAGE sql AS 'select 1'`, `ALTER FUNCTION ${schema}.f() OWNER TO`],
      ["a type", `CREATE TYPE ${schema}.ty AS (x int)`, `ALTER TYPE ${schema}.ty OWNER TO`],
    ];
    for (const [, create] of owned) await sql(create);
    for (const [name, , alter] of owned) {
      await sql(`${alter} ${login}`);
      expect(await restrictedAsLogin(), `${name}, directly`).toBe(false);
      await sql(`${alter} ${groups.owner}`);
      await sql(`GRANT ${groups.owner} TO ${login}`);
      expect(await restrictedAsLogin(), `${name}, through membership`).toBe(false);
      await sql(`REVOKE ${groups.owner} FROM ${login}`);
      await sql(`${alter} CURRENT_USER`);
    }
    await sql(`ALTER SCHEMA ${schema} OWNER TO ${login}`);
    expect(await restrictedAsLogin(), "a schema, directly").toBe(false);
    await sql(`ALTER SCHEMA ${schema} OWNER TO ${groups.owner}`);
    await sql(`GRANT ${groups.owner} TO ${login}`);
    expect(await restrictedAsLogin(), "a schema, through membership").toBe(false);
    await sql(`REVOKE ${groups.owner} FROM ${login}`);
    await sql(`ALTER SCHEMA ${schema} OWNER TO CURRENT_USER`);
    expect(await restrictedAsLogin(), "nothing owned any more").toBe(true);
  }, 30_000);
});
