// Operator command for private-beta signup codes (Customer Self-Onboarding v1, requirement 1).
//
//   npx tsx scripts/operators/signup-codes.ts issue --by "<operator>" [--days 14] [--note "<customer>"]
//   npx tsx scripts/operators/signup-codes.ts revoke <code id> --by "<operator>"
//   npx tsx scripts/operators/signup-codes.ts list
//
// Runs with the table owner connection in LUXIA_OWNER_DATABASE_URL (SignupCode has no app_user
// access). The code is printed once and only its SHA-256 is stored: it cannot be shown again.
import { randomInt } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { signupCodeHash } from "../../lib/onboarding/signup";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

export function generateSignupCode(): string {
  // 20 symbols drawn uniformly (crypto.randomInt) from a 30-letter alphabet: about 98 bits.
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""));
  return `LUXIA-${groups.join("-")}`;
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const url = process.env.LUXIA_OWNER_DATABASE_URL;
  if (!url) throw new Error("LUXIA_OWNER_DATABASE_URL is required (table owner connection).");
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (command === "issue") {
      const by = option(args, "by");
      const days = Number(option(args, "days") ?? 14);
      const note = option(args, "note");
      if (!by || by.length > 200) throw new Error("--by <operator> is required.");
      if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("--days must be between 1 and 30.");
      const code = generateSignupCode();
      const createdAt = new Date();
      const row = await db.signupCode.create({ data: {
        codeHash: signupCodeHash(code)!, issuedBy: by, note: note?.slice(0, 200), createdAt,
        expiresAt: new Date(createdAt.getTime() + days * 86_400_000),
      } });
      console.log(`Code id   : ${row.id}`);
      console.log(`Expires   : ${row.expiresAt.toISOString()}`);
      console.log(`Code      : ${code}`);
      console.log("The code is shown once and is not stored. Send it to the customer through a private channel.");
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
      throw new Error("Commands: issue | revoke | list");
    }
  } finally {
    await db.$disconnect();
  }
}

if (/signup-codes.ts$/.test(process.argv[1] ?? "")) main().catch((error) => { console.error(error instanceof Error ? error.message : "FAILED"); process.exit(1); });
