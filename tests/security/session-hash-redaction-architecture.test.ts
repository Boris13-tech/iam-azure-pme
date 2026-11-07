import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// R2: static checks of the session hash redaction migration and its rollback.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const previous = read("prisma/migrations/20261011180000_organization_status_session_scope/migration.sql");
const migration = read("prisma/migrations/20261023120000_session_network_hash_redaction/migration.sql");
const rollback = read("docs/operations/SESSION-NETWORK-HASH-REDACTION-ROLLBACK.sql");
function fn(sql: string, name: string) {
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION (public\\.)?${name}\\(`));
  if (start < 0) throw new Error(`missing ${name}`);
  const open = sql.indexOf("$$", start);
  return sql.slice(start, sql.indexOf("$$", open + 2) + 2).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION");
}

describe("R2 session hash redaction: migration architecture", () => {
  it("is expand-only: no row changes, no dropped object, no new grant", () => {
    const body = migration.replace(/^--.*$/gm, "");
    expect(body).not.toMatch(/DROP (TABLE|COLUMN|TYPE|FUNCTION|TRIGGER)|GRANT |SECURITY DEFINER|ALTER TABLE/);
    expect(body.match(/UPDATE "Session"/g)).toEqual(['UPDATE "Session"']); // inside the redaction function only
    expect(body).not.toMatch(/SELECT luxia_session_redact_network_hashes/);
  });

  it("keeps every previous session rule and adds only the one-way redaction", () => {
    const guard = fn(migration, "luxia_session_guard");
    for (const rule of ["SESSION_INVALID_INITIAL_STATE", "luxia_organization_lock_active(NEW.\"organizationId\")", "SESSION_REVOKED_IMMUTABLE", "SESSION_IMMUTABLE", "SESSION_REVOCATION_ONLY"])
      expect(guard).toContain(rule);
    expect(guard).toContain(`(to_jsonb(NEW) - 'ipHash' - 'userAgentHash') IS DISTINCT FROM (to_jsonb(OLD) - 'ipHash' - 'userAgentHash')`);
    expect(guard).toMatch(/NEW\."ipHash" IS DISTINCT FROM OLD\."ipHash" AND NEW\."ipHash" IS NOT NULL/);
    expect(guard).toMatch(/NEW\."userAgentHash" IS DISTINCT FROM OLD\."userAgentHash" AND NEW\."userAgentHash" IS NOT NULL/);
    expect(guard).not.toMatch(/now\(\)|clock_timestamp/);
  });

  it("only the table owner, in its own session, may clear a hash; the replaced guard stays closed to PUBLIC", () => {
    // Review follow-ups of #126 and #181: checked on the executable SQL (comments removed, spacing normalised), as one
    // whole statement, so neither a disabled condition nor a commented-out revoke can keep these checks green.
    const executable = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    const OWNER_ONLY = `IF ROW(NEW."ipHash", NEW."userAgentHash") IS DISTINCT FROM ROW(OLD."ipHash", OLD."userAgentHash") AND NOT (current_user = session_user AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = TG_RELID AND r.rolname = current_user)) THEN RAISE EXCEPTION 'SESSION_REDACTION_OWNER_ONLY' USING ERRCODE = '42501'; END IF;`;
    const ownerOnly = (sql: string) => executable(fn(sql, "luxia_session_guard")).includes(OWNER_ONLY);
    // CREATE OR REPLACE keeps the old privileges in PostgreSQL; the migration and the rollback still state the revoke.
    const revokedAfterCreate = (sql: string) => {
      const text = executable(sql);
      const created = text.indexOf("CREATE OR REPLACE FUNCTION luxia_session_guard()");
      return created >= 0 && text.indexOf("; REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;", created) > created;
    };
    expect(ownerOnly(migration)).toBe(true);
    for (const [name, sql] of [["migration", migration], ["rollback", rollback]] as const) expect(revokedAfterCreate(sql), name).toBe(true);

    // The check itself: each mutation below disables the rule while keeping its words, and must be caught.
    const disabled = [
      migration.replace("AND NOT (current_user = session_user", "AND FALSE AND NOT (current_user = session_user"),
      migration.replace("current_user = session_user AND EXISTS", "current_user = session_user OR EXISTS"),
      migration.replace("r.rolname = current_user))", "r.rolname = current_user OR TRUE))"),
      migration.replace("  IF ROW(NEW.\"ipHash\", NEW.\"userAgentHash\") IS DISTINCT FROM ROW(OLD.\"ipHash\", OLD.\"userAgentHash\")\n     AND NOT",
        "  -- IF ROW(NEW.\"ipHash\", NEW.\"userAgentHash\") IS DISTINCT FROM ROW(OLD.\"ipHash\", OLD.\"userAgentHash\")\n  IF FALSE AND NOT"),
    ];
    for (const sql of disabled) { expect(sql).not.toBe(migration); expect(ownerOnly(sql)).toBe(false); }
    for (const sql of [migration, rollback]) {
      const commented = sql.replace("REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;", "-- REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;");
      const blocked = sql.replace("REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;", "/* REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC; */");
      for (const mutated of [commented, blocked]) { expect(mutated).not.toBe(sql); expect(revokedAfterCreate(mutated)).toBe(false); }
    }
  });

  it("both functions pin their search_path", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION luxia_session_guard\(\) RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS/);
    expect(migration).toMatch(/CREATE FUNCTION luxia_session_redact_network_hashes\(p_batch integer\) RETURNS integer\s+LANGUAGE plpgsql SET search_path = public, pg_temp AS/);
  });

  it("the redaction is bounded and refuses a role that row-level security would blind", () => {
    const redact = fn(migration, "luxia_session_redact_network_hashes");
    expect(redact).toContain("p_batch IS NULL OR p_batch < 1 OR p_batch > 10000");
    expect(redact).toContain("REDACTION_REQUIRES_BYPASSRLS");
    expect(redact).toMatch(/LIMIT p_batch FOR UPDATE/);
    expect(migration).toContain("REVOKE ALL ON FUNCTION luxia_session_redact_network_hashes(integer) FROM app_user");
  });

  it("the rollback restores the previous guard exactly and removes the redaction function", () => {
    expect(fn(rollback, "luxia_session_guard")).toBe(fn(previous, "luxia_session_guard"));
    expect(rollback).toContain("DROP FUNCTION luxia_session_redact_network_hashes(integer);");
    expect(rollback).toContain("'20261023120000_session_network_hash_redaction'");
  });
});
