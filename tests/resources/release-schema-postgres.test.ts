// scripts/ops/verify-schema-release.sh against a real database: the CI database holds every migration of this checkout,
// so it matches this release, and is refused as the schema of a release one migration behind (the database ahead) or of a
// release with one more migration (the database behind).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const work = mkdtempSync(join(tmpdir(), "release-schema-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const migrations = readdirSync("prisma/migrations").filter((d) => /^\d{14}_/.test(d)).sort();
function releaseWith(names: string[]) {
  const dir = mkdtempSync(join(work, "release-"));
  for (const name of names) mkdirSync(join(dir, name));
  return dir.replace(/\\/g, "/");
}
function verify(dir: string, url = process.env.DATABASE_MIGRATION_URL!) {
  const clean = new URL(url); clean.search = "";
  const result = spawnSync("bash", ["scripts/ops/verify-schema-release.sh", dir], { encoding: "utf8", env: { ...process.env, PSQL_URL: clean.toString() } });
  return { code: result.status, out: `${result.stdout}${result.stderr}`.replace(/\r/g, "") };
}

describe.runIf(enabled)("verify-schema-release.sh on PostgreSQL", () => {
  it("this checkout's migrations match the database", () => {
    const copy = join(work, "this"); cpSync("prisma/migrations", copy, { recursive: true });
    expect(verify(copy.replace(/\\/g, "/"))).toEqual({ code: 0, out: `SCHEMA MATCHES ${migrations.length} migrations\n` });
  });

  it("a release one migration behind the database is refused: the database is ahead of it", () => {
    const { code, out } = verify(releaseWith(migrations.slice(0, -1)));
    expect(code).toBe(1);
    expect(out).toContain(`applied in the database, but not in the release: ${migrations.at(-1)}`);
  });

  it("a release with one more migration is refused: the database is behind it", () => {
    const { code, out } = verify(releaseWith([...migrations, "29991231000000_not_applied"]));
    expect(code).toBe(1);
    expect(out).toContain("not applied in the database, but in the release: 29991231000000_not_applied");
  });

  it("the runtime role reads the migration history and cannot write it: the history cannot be forged to let older code deploy", () => {
    const runtime = new URL(process.env.DATABASE_URL!); runtime.search = "";
    const as = (sql: string) => {
      const result = spawnSync("psql", ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", runtime.toString(), "-c", sql], { encoding: "utf8" });
      return result.status === 0 ? "OK" : /permission denied/.test(result.stderr) ? "DENIED" : `OTHER: ${result.stderr.trim()}`;
    };
    expect(as(`SELECT count(*) FROM "_prisma_migrations"`)).toBe("OK");
    const last = migrations.at(-1)!;
    for (const sql of [`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${last}'`,
      `UPDATE "_prisma_migrations" SET "rolled_back_at" = now() WHERE "migration_name" = '${last}'`,
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count") VALUES ('forged', 'x', '29991231000000_forged', now(), now(), 1)`,
      `TRUNCATE "_prisma_migrations"`])
      expect(as(sql), sql).toBe("DENIED");
  });

  it("the runtime role can run the same read, as the deploy workflow does", () => {
    const copy = join(work, "runtime"); cpSync("prisma/migrations", copy, { recursive: true });
    expect(verify(copy.replace(/\\/g, "/"), process.env.DATABASE_URL!).code).toBe(0);
  });
});
