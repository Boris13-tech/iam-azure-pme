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
    // Review follow-ups of #126 and #181 (both reviewers). Static checks on the executable SQL, read as PostgreSQL does:
    // comments removed (block comments nest), string literals kept. Everything the guard runs before and including the
    // owner-only rule is pinned word for word, so no early return, enclosing block or added branch can make the rule
    // unreachable without failing here. The revoke is a top-level statement after the function (not inside a quoted
    // body or a literal), nothing rolls it back, and no file grants anything. The behaviour itself is proven on
    // PostgreSQL by tests/resources/session-hash-redaction-postgres.test.ts.
    const executable = (sql: string) => {
      let out = "";
      for (let at = 0; at < sql.length;) {
        if (sql[at] === "'") { const end = sql.indexOf("'", at + 1); const stop = end < 0 ? sql.length : end + 1; out += sql.slice(at, stop); at = stop; }
        else if (sql.startsWith("--", at)) { const end = sql.indexOf("\n", at); at = end < 0 ? sql.length : end; out += " "; }
        else if (sql.startsWith("/*", at)) {
          let depth = 0;
          do {
            if (sql.startsWith("/*", at)) { depth += 1; at += 2; } else if (sql.startsWith("*/", at)) { depth -= 1; at += 2; } else at += 1;
          } while (depth > 0 && at < sql.length);
          out += " ";
        } else { out += sql[at]; at += 1; }
      }
      return out.replace(/\s+/g, " ");
    };
    const blankLiterals = (text: string) => text.replace(/'(?:[^']|'')*'/g, "''");
    const GUARD_UP_TO_OWNER_RULE = [
      `BEGIN IF TG_OP = 'INSERT' THEN IF NEW."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'SESSION_INVALID_INITIAL_STATE' USING ERRCODE = '23514'; END IF;`,
      `PERFORM luxia_organization_lock_active(NEW."organizationId"); RETURN NEW; END IF;`,
      `IF (NEW."ipHash" IS DISTINCT FROM OLD."ipHash" AND NEW."ipHash" IS NOT NULL) OR (NEW."userAgentHash" IS DISTINCT FROM OLD."userAgentHash" AND NEW."userAgentHash" IS NOT NULL) THEN RAISE EXCEPTION 'SESSION_IMMUTABLE' USING ERRCODE = '23514'; END IF;`,
      `IF ROW(NEW."ipHash", NEW."userAgentHash") IS DISTINCT FROM ROW(OLD."ipHash", OLD."userAgentHash") AND NOT (current_user = session_user AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE c.oid = TG_RELID AND r.rolname = current_user)) THEN RAISE EXCEPTION 'SESSION_REDACTION_OWNER_ONLY' USING ERRCODE = '42501'; END IF;`,
    ].join(" ");
    const ownerOnly = (sql: string) => {
      const guard = executable(fn(sql, "luxia_session_guard"));
      const body = guard.slice(guard.indexOf("$$") + 2).trimStart();
      return body.startsWith(`${GUARD_UP_TO_OWNER_RULE} `);
    };
    // CREATE OR REPLACE keeps the old privileges in PostgreSQL; the migration and the rollback still state the revoke.
    const statements = (sql: string) => blankLiterals(executable(sql).replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " $$$$ "))
      .split(";").map((statement) => statement.trim());
    const revokedAfterCreate = (sql: string) => {
      const list = statements(sql);
      const created = list.findIndex((statement) => statement.startsWith("CREATE OR REPLACE FUNCTION luxia_session_guard()"));
      return created >= 0 && list.slice(created + 1).includes("REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC")
        && !list.some((statement) => /^(ROLLBACK|ABORT)\b/i.test(statement)) && !/\bGRANT\b/i.test(executable(sql));
    };
    expect(ownerOnly(migration)).toBe(true);
    for (const [name, sql] of [["migration", migration], ["rollback", rollback]] as const) expect(revokedAfterCreate(sql), name).toBe(true);

    // The check itself: each mutation below disables the rule while keeping its words, and must be caught.
    const RULE_START = "  IF ROW(NEW.\"ipHash\", NEW.\"userAgentHash\") IS DISTINCT FROM ROW(OLD.\"ipHash\", OLD.\"userAgentHash\")\n     AND NOT";
    const RULE_END = "USING ERRCODE = '42501';\n  END IF;\n";
    const wrap = (sql: string, open: string, close: string) => sql.replace(RULE_START, `${open}\n${RULE_START}`).replace(RULE_END, `${RULE_END}${close}\n`);
    const disabled = [
      migration.replace("AND NOT (current_user = session_user", "AND FALSE AND NOT (current_user = session_user"),
      migration.replace("current_user = session_user AND EXISTS", "current_user = session_user OR EXISTS"),
      migration.replace("r.rolname = current_user))", "r.rolname = current_user OR TRUE))"),
      migration.replace(RULE_START, "  -- IF ROW(NEW.\"ipHash\", NEW.\"userAgentHash\") IS DISTINCT FROM ROW(OLD.\"ipHash\", OLD.\"userAgentHash\")\n  IF FALSE AND NOT"),
      wrap(migration, "  IF FALSE THEN", "  END IF;"),
      wrap(migration, "  IF TG_OP = 'DELETE' THEN", "  END IF;"),
      wrap(migration, "  FOR i IN 1..0 LOOP", "  END LOOP;"),
      wrap(migration, "  IF TRUE THEN NULL; ELSE", "  END IF;"),
      migration.replace(RULE_START, `  RETURN NEW;\n${RULE_START}`),
      migration.replace(RULE_START, `  IF current_user = 'app_user' THEN RETURN NEW; END IF;\n${RULE_START}`),
      migration.replace(RULE_START, `  /* outer /* inner */ IF current_user = 'app_user' THEN RETURN NEW; END IF; */\n  IF current_user = 'app_user' THEN RETURN NEW; END IF;\n${RULE_START}`),
    ];
    for (const sql of disabled) { expect(sql).not.toBe(migration); expect(ownerOnly(sql)).toBe(false); }
    // A nested block comment hides everything up to its own end, as in PostgreSQL.
    const nested = migration.replace(RULE_START, `  /* outer /* inner */\n${RULE_START}`).replace(RULE_END, `${RULE_END}  still a comment */\n`);
    expect(nested).not.toBe(migration);
    expect(ownerOnly(nested)).toBe(false);
    for (const sql of [migration, rollback]) {
      const revoke = "REVOKE ALL ON FUNCTION luxia_session_guard() FROM PUBLIC;";
      const mutations = [
        sql.replace(revoke, `-- ${revoke}`),
        sql.replace(revoke, `/* ${revoke} */`),
        sql.replace(revoke, `/* outer /* inner */ ${revoke} */`),
        sql.replace(revoke, `DO $revoke$\nBEGIN\n  IF FALSE THEN\n    NULL;\n    ${revoke}\n  END IF;\nEND $revoke$;`),
        sql.replace(revoke, `DO $$ BEGIN IF FALSE THEN ${revoke} END IF; END $$;`),
        sql.replace(revoke, `DO 'BEGIN IF FALSE THEN ${revoke} END IF; END';`),
        sql.replace(revoke, `${revoke}\nROLLBACK;`),
        sql.replace(revoke, `${revoke}\nGRANT EXECUTE ON FUNCTION luxia_session_guard() TO PUBLIC;`),
      ];
      for (const mutated of mutations) { expect(mutated).not.toBe(sql); expect(revokedAfterCreate(mutated), mutated.slice(-300)).toBe(false); }
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
