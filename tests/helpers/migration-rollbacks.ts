// A rollback runs only when its migration is the last applied one (the precondition added with the pinned release):
// rolling back an older migration while a newer one is applied would restore objects the newer one depends on. A
// rollback drill must therefore undo every newer migration first, newest first.
//
// The map is built from the rollback files themselves: each names its migration in its first line ("Rollback of <name>").
// A migration added later with its own rollback is picked up with no change here, and every drill adapts.
import { readFileSync, readdirSync } from "node:fs";

const DIR = "docs/operations";

/** Every rollback script, as {migration: path}, read from the scripts' own headers. */
export function rollbackScripts(): Record<string, string> {
  const scripts: Record<string, string> = {};
  for (const file of readdirSync(DIR).filter((name) => name.endsWith("ROLLBACK.sql")).sort()) {
    const header = readFileSync(`${DIR}/${file}`, "utf8").slice(0, 400);
    const migration = /Rollback of (\d{14}_[A-Za-z0-9_]+)/.exec(header)?.[1];
    if (migration) scripts[migration] = `${DIR}/${file}`;
  }
  return scripts;
}

/**
 * The rollbacks to run before `migration`'s own, newest first: those of every migration applied after it. Throws when a
 * newer migration has no rollback script, because the drill could then not reach `migration` at all.
 */
export function rollbacksAfter(migration: string): string[] {
  const scripts = rollbackScripts();
  const newer = readdirSync("prisma/migrations").filter((name) => /^\d{14}_/.test(name) && name > migration).sort().reverse();
  const missing = newer.filter((name) => !scripts[name]);
  if (missing.length > 0) throw new Error(`no rollback script for ${missing.join(", ")}: the drill of ${migration} cannot run`);
  return newer.map((name) => scripts[name]);
}
