import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  applyBreakGlass, AUTHORITY, BREAK_GLASS_ACTIONS, canonicalJson, planBreakGlass, planDigest, validateInput, type BreakGlassAction,
} from "../../lib/operators/break-glass";
import { toolVersion } from "../../scripts/operators/tool-version";

// First Admin / Break-glass v1, B4: input validation, authority matrix (D7 + Q1) and plan digest.
const UUID = "0b9d0b8e-5555-4c2a-9a55-000000000001";
const HASH = "a".repeat(64);
const customer = (actions: BreakGlassAction[], extra: Record<string, unknown> = {}) => ({
  type: "VERIFIED_CUSTOMER_REQUEST", id: "REQ-42", requester: { name: "Jeanne Martin", role: "Directrice", channel: "Courrier signé" },
  verificationMethods: ["CALLBACK_KNOWN_CONTACT", "SIGNED_LETTER_OR_CONTRACT"], documentSha256: HASH, requestedActions: actions, ...extra,
});
const target = (action: BreakGlassAction) => action === "DISABLE_ACCOUNT" ? { identityAccountId: UUID }
  : action === "RELEASE_DOMAIN" ? { domain: "example.com" } : action === "RECOVERY_INVITATION" ? { namedPerson: "Nouvelle Admin" } : {};
const input = (action: BreakGlassAction, reference: Record<string, unknown>, organization = "acme-corp") =>
  ({ action, organization, reason: "Raison suffisamment détaillée", reference, ...target(action) });
const code = (fn: () => unknown) => { try { fn(); return "OK"; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

describe("B4 break-glass: authority matrix and inputs", () => {
  it("the closed list has exactly the seven approved actions", () => {
    expect([...BREAK_GLASS_ACTIONS].sort()).toEqual(["CLOSE_ORGANIZATION", "DISABLE_ACCOUNT", "REACTIVATE_ORGANIZATION", "RECOVERY_INVITATION",
      "RELEASE_DOMAIN", "REVOKE_SESSIONS", "SUSPEND_ORGANIZATION"]);
    expect(code(() => validateInput({ ...input("SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1" }), action: "DROP_TABLE" }))).toBe("UNKNOWN_ACTION");
    expect(code(() => validateInput({ ...input("SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1" }), sql: "DELETE" }))).toBe("UNKNOWN_FIELD");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", { type: "ROOT", id: "x" })))).toBe("UNKNOWN_REFERENCE_TYPE");
  });

  it("LUXIA_INCIDENT allows only SUSPEND_ORGANIZATION and REVOKE_SESSIONS", () => {
    expect(AUTHORITY.LUXIA_INCIDENT).toEqual(["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS"]);
    for (const action of BREAK_GLASS_ACTIONS)
      expect(code(() => validateInput(input(action, { type: "LUXIA_INCIDENT", id: "INC-1" }))), action)
        .toBe(["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS"].includes(action) ? "OK" : "AUTHORITY_REFUSED");
  });

  it("LUXIA_CERTIFICATION acts only on organizations explicitly marked as certification organizations", () => {
    expect(code(() => validateInput(input("CLOSE_ORGANIZATION", { type: "LUXIA_CERTIFICATION", id: "CERT-1" }, "acme-corp")))).toBe("AUTHORITY_REFUSED");
    expect(code(() => validateInput(input("CLOSE_ORGANIZATION", { type: "LUXIA_CERTIFICATION", id: "CERT-1" }, "luxia-certification-lab")))).toBe("OK");
    expect(code(() => validateInput(input("CLOSE_ORGANIZATION", { type: "LUXIA_CERTIFICATION", id: "CERT-1" }, "luxia-cert-b2-r6")))).toBe("OK");
    // Legrand Tech accepts only its own verified request.
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1" }, "legrand-tech")))).toBe("AUTHORITY_REFUSED");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"]), "legrand-tech")))).toBe("OK");
  });

  it("VERIFIED_CUSTOMER_REQUEST allows only the actions the request explicitly contains (Q1 included)", () => {
    for (const action of BREAK_GLASS_ACTIONS) {
      const reference = customer([action], action === "RECOVERY_INVITATION" ? { namedPerson: "Nouvelle Admin" } : {});
      expect(code(() => validateInput(input(action, reference))), action).toBe("OK");
      const other = BREAK_GLASS_ACTIONS.find((a) => a !== action)!;
      expect(code(() => validateInput(input(action, customer([other])))), action).toBe("ACTION_NOT_REQUESTED");
    }
    // One request can name the whole neutralization sequence (D2 with Q1).
    const sequence: BreakGlassAction[] = ["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS", "DISABLE_ACCOUNT"];
    for (const action of sequence) expect(code(() => validateInput(input(action, customer(sequence)))), action).toBe("OK");
  });

  it("a customer request needs two independent known methods, a document hash and a requester", () => {
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"], { verificationMethods: ["CALLBACK_KNOWN_CONTACT"] }))))).toBe("TWO_VERIFICATION_METHODS_REQUIRED");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"], { verificationMethods: ["CALLBACK_KNOWN_CONTACT", "CALLBACK_KNOWN_CONTACT"] }))))).toBe("TWO_VERIFICATION_METHODS_REQUIRED");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"], { verificationMethods: ["CALLBACK_KNOWN_CONTACT", "TRUST_ME"] }))))).toBe("UNKNOWN_VERIFICATION_METHOD");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"], { documentSha256: "not-a-hash" }))))).toBe("DOCUMENT_SHA256_REQUIRED");
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", customer(["SUSPEND_ORGANIZATION"], { requester: undefined }))))).toBe("REQUESTER_REQUIRED");
    // Customer fields are refused on any other reference: nothing hidden rides along.
    expect(code(() => validateInput(input("SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1", requestedActions: ["CLOSE_ORGANIZATION"] })))).toBe("UNEXPECTED_FIELD");
  });

  it("each action takes exactly its own target, and the recovery invitation only for the named person", () => {
    expect(code(() => validateInput({ ...input("SUSPEND_ORGANIZATION", { type: "LUXIA_INCIDENT", id: "INC-1" }), identityAccountId: UUID }))).toBe("UNEXPECTED_FIELD");
    expect(code(() => validateInput({ ...input("DISABLE_ACCOUNT", customer(["DISABLE_ACCOUNT"])), identityAccountId: "1 OR 1=1" }))).toBe("IDENTITY_ACCOUNT_REQUIRED");
    expect(code(() => validateInput({ ...input("RELEASE_DOMAIN", customer(["RELEASE_DOMAIN"])), domain: "http://x/y" }))).toBe("DOMAIN_REQUIRED");
    expect(code(() => validateInput(input("RECOVERY_INVITATION", customer(["RECOVERY_INVITATION"]))))).toBe("NAMED_PERSON_MISMATCH");
    expect(code(() => validateInput(input("RECOVERY_INVITATION", customer(["RECOVERY_INVITATION"], { namedPerson: "Quelqu'un d'autre" }))))).toBe("NAMED_PERSON_MISMATCH");
    expect(code(() => validateInput({ ...input("RECOVERY_INVITATION", customer(["RECOVERY_INVITATION"], { namedPerson: "Nouvelle Admin" })), reason: "court" }))).toBe("REASON_REQUIRED");
  });

  it("the digest covers every input: canonical, stable, and different for any change", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"x":2,"y":1}]},"b":1}');
    const base = validateInput(input("DISABLE_ACCOUNT", customer(["REVOKE_SESSIONS", "DISABLE_ACCOUNT"])));
    // Order of methods and actions does not matter; their content does.
    const same = validateInput(input("DISABLE_ACCOUNT", customer(["DISABLE_ACCOUNT", "REVOKE_SESSIONS"], { verificationMethods: ["SIGNED_LETTER_OR_CONTRACT", "CALLBACK_KNOWN_CONTACT"] })));
    expect(planDigest(same)).toBe(planDigest(base));
    for (const changed of [
      { ...base, reason: `${base.reason}.` },
      { ...base, identityAccountId: "0b9d0b8e-5555-4c2a-9a55-000000000002" },
      { ...base, reference: { ...base.reference, id: "REQ-43" } },
      { ...base, reference: { ...base.reference, requestedActions: ["DISABLE_ACCOUNT"] } },
      { ...base, reference: { ...base.reference, documentSha256: "b".repeat(64) } },
    ]) expect(planDigest(changed)).not.toBe(planDigest(base));
  });

  it("plan and apply refuse an unknown tool version before touching the database (a modified checkout proves no commit)", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("DATABASE_TOUCHED"); } }) as unknown as PrismaClient;
    const issuedAt = new Date("2026-10-12T10:00:00Z");
    const close = input("CLOSE_ORGANIZATION", { type: "LUXIA_CERTIFICATION", id: "CERT-1" }, "luxia-cert-b2-r6");
    for (const toolVersion of ["unknown", "", "t", "A".repeat(40), "a".repeat(39)]) {
      expect(await planBreakGlass(untouchable, close, { issuedAt, toolVersion }).then(() => "OK", (error) => error.code ?? error.message), toolVersion).toBe("TOOL_VERSION_UNKNOWN");
      expect(await applyBreakGlass(untouchable, close, { issuedAt, toolVersion, confirm: "c".repeat(64), now: issuedAt })
        .then(() => "OK", (error) => error.code ?? error.message), toolVersion).toBe("TOOL_VERSION_UNKNOWN");
    }
    // The command takes its version from its own checkout, never from the caller (behaviour tested below).
    const cli = readFileSync("scripts/operators/break-glass.ts", "utf8");
    expect(cli.match(/toolVersion: [^,}]+/g)?.map((call) => call.trim())).toEqual(Array(2).fill("toolVersion: toolVersion(dirname(resolve(process.argv[1])))"));
  });

  it("the command's version is the commit of a clean checkout, and \"unknown\" otherwise (real Git repository)", () => {
    // Review follow-up of #183: run Git for real, in a disposable repository, from a foreign working directory.
    const repo = mkdtempSync(join(tmpdir(), "luxia-tool-version-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "luxia-elsewhere-"));
    const previous = process.cwd();
    try {
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" }).toString().trim();
      expect(toolVersion(repo), "not a checkout").toBe("unknown");
      git("init", "-q");
      expect(toolVersion(repo), "no commit yet").toBe("unknown");
      writeFileSync(join(repo, "tool.ts"), "export const a = 1;\n");
      git("add", "tool.ts");
      git("commit", "-q", "-m", "one");
      const head = git("rev-parse", "HEAD");
      process.chdir(elsewhere); // the caller's directory plays no part
      expect(toolVersion(repo), "clean").toBe(head);
      writeFileSync(join(repo, "notes.txt"), "untracked\n");
      expect(toolVersion(repo), "untracked file only").toBe(head);
      writeFileSync(join(repo, "tool.ts"), "export const a = 2;\n");
      expect(toolVersion(repo), "modified, unstaged").toBe("unknown");
      git("add", "tool.ts");
      expect(toolVersion(repo), "modified, staged").toBe("unknown");
      git("commit", "-q", "-m", "two");
      expect(toolVersion(repo), "committed again").toBe(git("rev-parse", "HEAD"));
      rmSync(join(repo, "tool.ts"));
      expect(toolVersion(repo), "tracked file deleted").toBe("unknown");
      expect(toolVersion(join(elsewhere, "missing")), "missing directory").toBe("unknown");
    } finally {
      process.chdir(previous);
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 30_000); // a dozen real Git processes: slow on a loaded Windows runner

  it("apply refuses before touching the database: expired plan, missing confirmation, missing typed identifier", async () => {
    const untouchable = new Proxy({}, { get: () => { throw new Error("DATABASE_TOUCHED"); } }) as unknown as PrismaClient;
    const issuedAt = new Date("2026-10-12T10:00:00Z");
    const close = input("CLOSE_ORGANIZATION", { type: "LUXIA_CERTIFICATION", id: "CERT-1" }, "luxia-cert-b2-r6");
    const run = (options: Record<string, unknown>) => applyBreakGlass(untouchable, close, { issuedAt, toolVersion: "a".repeat(40), confirm: "c".repeat(64), ...options })
      .then(() => "OK", (error) => error.code ?? error.message);
    expect(await run({ now: new Date(issuedAt.getTime() + 15 * 60_000 + 1) })).toBe("PLAN_EXPIRED");
    expect(await run({ now: issuedAt, confirm: "" })).toBe("CONFIRMATION_REQUIRED");
    expect(await run({ now: issuedAt })).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
    expect(await run({ now: issuedAt, irreversible: "luxia-certification-lab" })).toBe("IRREVERSIBLE_CONFIRMATION_REQUIRED");
  });
});
