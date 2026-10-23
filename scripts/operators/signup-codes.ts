// Operator command for private-beta signup codes (Customer Self-Onboarding v1, requirement 1).
//
//   npx tsx scripts/operators/signup-codes.ts plan --by "<operator>" [--days 14] [--note "<customer>"] [--evidence <dir>]
//   npx tsx scripts/operators/signup-codes.ts issue --plan <plan.json> --confirm <digest> [--evidence <dir>]
//   npx tsx scripts/operators/signup-codes.ts revoke <code id> --by "<operator>"
//   npx tsx scripts/operators/signup-codes.ts list
//
// Runs with the table owner connection in LUXIA_OWNER_DATABASE_URL (SignupCode has no app_user
// access). The code is printed once and only its SHA-256 is stored: it cannot be shown again.
//
// Issuing a code is a Production write (standard, section 10). `plan` writes nothing and prints a
// digest. `issue` writes only with that digest, within 15 minutes, against the same database, role
// and tool commit as the plan, and at most once per plan. Revocation stays immediate: it only
// removes access, and must stay fast during an incident.
import { execSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { signupCodeHash } from "../../lib/onboarding/signup";
import { canonicalJson, planDigest } from "../../lib/operators/break-glass";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
export const SIGNUP_PLAN_VALIDITY_MS = 15 * 60_000;

export function generateSignupCode(): string {
  // 20 symbols drawn uniformly (crypto.randomInt) from a 30-letter alphabet: about 98 bits.
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
  return `LUXIA-${groups.join("-")}`;
}

export class SignupPlanRefusal extends Error {}
const refuse = (code: string): never => { throw new SignupPlanRefusal(code); };

/** Where a plan may be applied: the database, the role and the endpoint host it was made against. */
export type SignupTarget = { host: string; database: string; role: string };
export type SignupPlan = {
  kind: "LUXIA_SIGNUP_CODE_PLAN"; by: string; days: number; note: string | null;
  target: SignupTarget; toolVersion: string; issuedAt: string; notAfter: string;
};

export function planSignupCode(input: { by?: string; days?: string; note?: string }, target: SignupTarget, toolVersion: string, now = new Date()) {
  const days = Number(input.days ?? 14);
  if (!input.by || input.by.length > 200) refuse("BY_REQUIRED");
  if (!Number.isInteger(days) || days < 1 || days > 30) refuse("DAYS_OUT_OF_RANGE");
  if (!/^[0-9a-f]{40}$/.test(toolVersion)) refuse("TOOL_VERSION_UNKNOWN");
  const plan: SignupPlan = {
    kind: "LUXIA_SIGNUP_CODE_PLAN", by: input.by!, days, note: input.note?.slice(0, 150) ?? null, target, toolVersion,
    issuedAt: now.toISOString(), notAfter: new Date(now.getTime() + SIGNUP_PLAN_VALIDITY_MS).toISOString(),
  };
  return { plan, digest: planDigest(plan) };
}

/** Refuses unless the saved plan is intact, confirmed by its digest, fresh, and for this database and commit. */
export function checkSignupPlan(saved: unknown, confirm: string | undefined, current: { target: SignupTarget; toolVersion: string }, now = new Date()): SignupPlan {
  const file = saved as { plan?: SignupPlan; digest?: string } | null;
  if (!file?.plan || file.plan.kind !== "LUXIA_SIGNUP_CODE_PLAN") refuse("NOT_A_SIGNUP_PLAN");
  const plan = file!.plan!;
  if (planDigest(plan) !== file!.digest) refuse("PLAN_TAMPERED");
  if (!confirm || confirm !== file!.digest) refuse("CONFIRMATION_MISMATCH");
  if (!(now.getTime() <= Date.parse(plan.notAfter))) refuse("PLAN_EXPIRED");
  if (canonicalJson(plan.target) !== canonicalJson(current.target)) refuse("TARGET_MISMATCH");
  if (plan.toolVersion !== current.toolVersion) refuse("TOOL_VERSION_MISMATCH");
  return plan;
}

/** The plan marker stored in the code's note: it makes each plan usable once. */
export const planMarker = (digest: string) => `plan:${digest.slice(0, 16)}`;

export async function issueFromPlan(db: PrismaClient, plan: SignupPlan, digest: string, now = new Date()) {
  const marker = planMarker(digest);
  const code = generateSignupCode();
  const row = await db.$transaction(async (tx) => {
    if (await tx.signupCode.findFirst({ where: { note: { startsWith: marker } }, select: { id: true } })) refuse("PLAN_ALREADY_USED");
    return tx.signupCode.create({ data: {
      codeHash: signupCodeHash(code)!, issuedBy: plan.by, note: plan.note ? `${marker} ${plan.note}` : marker, createdAt: now,
      expiresAt: new Date(now.getTime() + plan.days * 86_400_000),
    } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { code, row };
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}
function toolVersion(): string {
  try { return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return "unknown"; }
}
async function currentTarget(db: PrismaClient, url: string): Promise<SignupTarget> {
  const [row] = await db.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
  return { host: new URL(url).hostname, database: row.database, role: row.role };
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
  if (!url) throw new Error("LUXIA_OWNER_DATABASE_URL is required (table owner connection).");
  const evidence = option(args, "evidence") ?? ".signup-code-evidence";
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (command === "plan") {
      const { plan, digest } = planSignupCode({ by: option(args, "by"), days: option(args, "days"), note: option(args, "note") },
        await currentTarget(db, url), toolVersion());
      const path = writeEvidence(evidence, `${plan.issuedAt.replace(/[:.]/g, "-")}-signup-code-${digest.slice(0, 12)}.plan.json`, { plan, digest });
      console.log(JSON.stringify(plan, null, 1));
      console.log(`\nNothing was written. Plan digest : ${digest}`);
      console.log(`Valid until : ${plan.notAfter}`);
      console.log(`Issue with  : issue --plan ${path} --confirm ${digest}`);
    } else if (command === "issue") {
      const file = option(args, "plan");
      if (!file) throw new Error("issue needs --plan <plan.json> --confirm <digest>. Run plan first: it writes nothing.");
      const saved = JSON.parse(readFileSync(file, "utf8")) as { plan: SignupPlan; digest: string };
      const plan = checkSignupPlan(saved, option(args, "confirm"), { target: await currentTarget(db, url), toolVersion: toolVersion() });
      const { code, row } = await issueFromPlan(db, plan, saved.digest);
      const path = writeEvidence(evidence, file.replace(/^.*[\\/]/, "").replace(/\.plan\.json$/, ".issue.json"),
        { digest: saved.digest, codeId: row.id, expiresAt: row.expiresAt.toISOString(), issuedAt: row.createdAt.toISOString() });
      console.log(`Code id   : ${row.id}`);
      console.log(`Expires   : ${row.expiresAt.toISOString()}`);
      console.log(`Code      : ${code}`);
      console.log("The code is shown once and is not stored. Send it to the customer through a private channel.");
      console.log(`Evidence  : ${path} (the code is not in it)`);
    } else if (command === "revoke") {
      const id = args[0];
      const by = option(args, "by");
      if (!id || !by) throw new Error("Usage: revoke <code id> --by <operator>");
      const result = await db.signupCode.updateMany({
        where: { id, status: { in: ["ISSUED", "RESERVED"] } },
        data: { status: "REVOKED", revokedAt: new Date(), revokedBy: by, pendingChallengeHash: null, pendingExpiresAt: null, pendingPayload: Prisma.DbNull },
      });
      console.log(result.count === 1 ? `Revoked ${id}.` : `Nothing revoked: ${id} is unknown or already final.`);
    } else if (command === "list") {
      const rows = await db.signupCode.findMany({ orderBy: { createdAt: "desc" }, take: 100,
        select: { id: true, status: true, issuedBy: true, note: true, createdAt: true, expiresAt: true, consumedAt: true, organization: { select: { slug: true } } } });
      for (const row of rows)
        console.log([row.id, row.status, row.createdAt.toISOString(), row.expiresAt.toISOString(), row.consumedAt?.toISOString() ?? "-", row.organization?.slug ?? "-", row.issuedBy, row.note ?? ""].join(" | "));
    } else {
      throw new Error("Commands: plan | issue | revoke | list");
    }
  } finally {
    await db.$disconnect();
  }
}

if (/signup-codes.ts$/.test(process.argv[1] ?? "")) main().catch((error) => {
  console.error(error instanceof SignupPlanRefusal ? `REFUSED ${error.message}` : error instanceof Error ? error.message : "FAILED");
  process.exit(1);
});
