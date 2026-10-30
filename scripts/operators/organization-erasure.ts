// Operator command for R7: erasure of a CLOSED organization (end of a pilot, or after closure).
// Design: docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md (R7). Close the organization first with the
// break-glass procedure (CLOSE_ORGANIZATION), then, after the agreed period:
//
//   npx tsx scripts/operators/organization-erasure.ts plan --organization <identifier> [--evidence <dir>]
//   npx tsx scripts/operators/organization-erasure.ts apply --plan <plan.json> --confirm <digest> --irreversible <identifier> [--evidence <dir>]
//
// Runs with the owner connection in LUXIA_OWNER_DATABASE_URL (direct endpoint, BYPASSRLS role), never printed.
// `plan` writes nothing. `apply` is irreversible; the backups still hold the data until they expire (R8).
// Precondition: no LegacyUserBridge row for the organization, otherwise REFUSED LEGACY_DATA_PRESENT; a historical
// organization needs the separate legacy procedure first. An organization created without a bridge continues normally.
// Guarantee: no row attributable to the organization through the supported canonical or legacy linkage remains.
// Legacy users with no bridge cannot be attributed and are not part of it; plan and apply report their
// count for the whole database, and that count needs the operator's attention.
// Evidence files hold the organization identifiers and the counts per table, never row content.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyErasure, checkErasurePlan, erasureEndpoint, ErasureRefusal, planErasure, type ErasurePlan, type ErasureTarget } from "../../lib/operators/organization-erasure";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function toolVersion(): string {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; }
}
async function currentTarget(db: PrismaClient, url: string): Promise<ErasureTarget> {
  const [row] = await db.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  return { host: erasureEndpoint(url), database: row.database, role: row.role };
}
function writeEvidence(dir: string, name: string, value: unknown) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 1));
  return path;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const url = process.env.LUXIA_OWNER_DATABASE_URL;
  if (!url) throw new Error("LUXIA_OWNER_DATABASE_URL is required (owner connection, direct endpoint).");
  if (new URL(url).hostname.includes("-pooler")) throw new Error("Use the direct endpoint, not the pooler.");
  const evidence = option(args, "evidence") ?? ".organization-erasure-evidence";
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (command === "plan") {
      const { plan, digest } = await planErasure(db, option(args, "organization"), await currentTarget(db, url), toolVersion());
      const path = writeEvidence(evidence, `${plan.issuedAt.replace(/[:.]/g, "-")}-erasure-${plan.organization.slug}-${digest.slice(0, 12)}.plan.json`, { plan, digest });
      console.log(JSON.stringify(plan, null, 1));
      console.log(`\nNothing was written. Plan digest : ${digest}`);
      console.log(`Valid until : ${plan.notAfter}`);
      if (plan.legacy.usersWithoutBridge > 0) console.log(`WARNING: ${plan.legacy.usersWithoutBridge} legacy user(s) in this database have no bridge: no erasure can attribute them to an organization. Review them before telling a customer the erasure is complete.`);
      console.log(`IRREVERSIBLE. Apply with : apply --plan ${path} --confirm ${digest} --irreversible ${plan.organization.slug}`);
    } else if (command === "apply") {
      const file = option(args, "plan");
      if (!file) throw new Error("Usage: apply --plan <plan.json> --confirm <digest> --irreversible <identifier>");
      const saved = JSON.parse(readFileSync(file, "utf8")) as { plan: ErasurePlan; digest: string };
      const plan = checkErasurePlan(saved, option(args, "confirm"), option(args, "irreversible"),
        { target: await currentTarget(db, url), toolVersion: toolVersion() });
      const result = await applyErasure(db, plan);
      const path = writeEvidence(evidence, file.replace(/^.*[\/]/, "").replace(/\.plan\.json$/, ".apply.json"),
        { kind: "LUXIA_ORGANIZATION_ERASURE_APPLY", digest: saved.digest, erasedAt: new Date().toISOString(), ...result });
      console.log(JSON.stringify(result, null, 1));
      console.log(`\nERASED: ${result.slug}. No row attributable to the organization through the supported canonical or legacy linkage remains; the counts match the plan.`);
      console.log(`Evidence    : ${path}`);
      if (result.legacyUsersWithoutBridge > 0) console.log(`WARNING: ${result.legacyUsersWithoutBridge} legacy user(s) in this database have no bridge and were not examined: operator attention needed.`);
      console.log("Backups keep the data until they expire (R8). Confirm the erasure to the customer in writing.");
    } else {
      throw new Error("Commands: plan | apply");
    }
  } finally {
    await db.$disconnect();
  }
}

if (/organization-erasure.ts$/.test(process.argv[1] ?? "")) main().catch((error) => {
  console.error(error instanceof ErasureRefusal ? `REFUSED ${error.message}` : error instanceof Error ? error.message : "FAILED");
  process.exit(1);
});
