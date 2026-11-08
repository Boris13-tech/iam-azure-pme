// Operator command for the First Admin / Break-glass v1 procedure (B4).
// Design: docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md
// Runbook: docs/operations/B4-BREAK-GLASS-RUNBOOK.md
//
//   npx tsx scripts/operators/break-glass.ts plan --request <request.json> [--evidence <dir>]
//   npx tsx scripts/operators/break-glass.ts apply --plan <plan.json> --confirm <digest> [--irreversible <organization>] [--evidence <dir>]
//
// The request file holds the closed inputs only: action, organization, target, reference and reason.
// No SQL, query or free expression is accepted. The owner connection is read from
// LUXIA_OWNER_DATABASE_URL (direct endpoint, BYPASSRLS role) and never printed. Evidence files hold the
// plan, digest and result, never a token, link, code or secret.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { applyBreakGlass, BreakGlassRefusal, planBreakGlass } from "../../lib/operators/break-glass";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function toolVersion(): string {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; }
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
  const evidence = option(args, "evidence") ?? ".break-glass-evidence";
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [role] = await db.$queryRaw<Array<{ bypass: boolean }>>`SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (!role?.bypass) throw new Error("The operator role (BYPASSRLS) is required.");
    if (command === "plan") {
      const file = option(args, "request");
      if (!file) throw new Error("Usage: plan --request <request.json>");
      const input = JSON.parse(readFileSync(file, "utf8"));
      const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      const { plan, digest } = await planBreakGlass(db, input, { issuedAt, toolVersion: toolVersion(), endpoint: new URL(url).host });
      const path = writeEvidence(evidence, `${plan.issuedAt.replace(/[:.]/g, "-")}-${plan.input.action}-${digest.slice(0, 12)}.plan.json`,
        { kind: "LUXIA_BREAK_GLASS_PLAN", input, issuedAt: plan.issuedAt, digest, plan });
      console.log(JSON.stringify(plan, null, 1));
      console.log(`\nDRY RUN: nothing was written to the database.`);
      console.log(`Plan digest : ${digest}`);
      console.log(`Valid until : ${plan.notAfter}`);
      console.log(`Plan file   : ${path}`);
      console.log(`Apply with  : apply --plan ${path} --confirm ${digest}${plan.irreversible ? ` --irreversible ${plan.input.organization}` : ""}`);
    } else if (command === "apply") {
      const file = option(args, "plan");
      const confirm = option(args, "confirm");
      if (!file || !confirm) throw new Error("Usage: apply --plan <plan.json> --confirm <digest> [--irreversible <organization>]");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (saved.kind !== "LUXIA_BREAK_GLASS_PLAN") throw new Error("Not a break-glass plan file.");
      if (saved.digest !== confirm) throw new Error("The confirmation is not this plan's digest.");
      const result = await applyBreakGlass(db, saved.input, { issuedAt: new Date(saved.issuedAt), toolVersion: toolVersion(), endpoint: new URL(url).host, confirm,
        irreversible: option(args, "irreversible") });
      const { invitationToken, ...recorded } = result;
      const path = writeEvidence(evidence, file.replace(/^.*[\\/]/, "").replace(/\.plan\.json$/, ".apply.json"), { kind: "LUXIA_BREAK_GLASS_APPLY", ...recorded });
      console.log(JSON.stringify(recorded, null, 1));
      console.log(`\nAPPLIED: ${recorded.changeId}. Committed state ${recorded.committed.verified ? "matches" : "DOES NOT MATCH"} the plan.`);
      console.log(`Evidence    : ${path}`);
      if (invitationToken) {
        const base = process.env.LUXIA_APP_URL ?? "https://iam-azure-pme.vercel.app";
        console.log("\nEmergency administrator link, shown ONCE (valid 24 h, single use). It is not stored anywhere:");
        console.log(`${base}/invitation#${invitationToken}`);
        console.log("Deliver it only to the named person, through the verified channel.");
      }
      if (!recorded.committed.verified) process.exitCode = 2;
    } else {
      throw new Error("Commands: plan | apply");
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof BreakGlassRefusal ? `REFUSED ${error.message}` : error instanceof Error ? error.message : "FAILED");
  process.exit(1);
});
