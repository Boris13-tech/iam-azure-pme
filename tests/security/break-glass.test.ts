import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  applyBreakGlass, AUTHORITY, BREAK_GLASS_ACTIONS, canonicalJson, planBreakGlass, planDigest, validateInput, type BreakGlassAction,
} from "../../lib/operators/break-glass";
import { loadedSources, outsidePreloads, toolVersion } from "../../scripts/operators/tool-version";

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
    expect(cli.match(/toolVersion: [^,}]+/g)?.map((call) => call.trim())).toEqual(Array(2).fill("toolVersion: toolVersion(loadedSources())"));
  });

  it("the command's version is the commit its loaded sources come from, and \"unknown\" otherwise (real Git repositories)", () => {
    // Review follow-ups of #183 (both AI reviewers): real Git, disposable repositories, a foreign working directory.
    // Each case below is caught by one control: the clean-checkout check, the tracked-file check, the byte comparison
    // with HEAD, or the removal of inherited GIT_* variables.
    const base = mkdtempSync(join(tmpdir(), "luxia-tool-version-"));
    const previous = process.cwd();
    const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "git_dir"];
    const gitIn = (cwd: string) => (...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test",
      "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe" }).toString().trim();
    const repository = (name: string) => {
      const root = join(base, name);
      mkdirSync(join(root, "scripts", "operators"), { recursive: true });
      const git = gitIn(root);
      git("init", "-q");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(root, "lib.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "scripts", "operators", "cli.ts"), "import './../../lib';\n");
      return { root, git, cli: join(root, "scripts", "operators", "cli.ts"), lib: join(root, "lib.ts") };
    };
    try {
      const tool = repository("tool");
      expect(toolVersion([tool.cli, tool.lib]), "no commit yet").toBe("unknown");
      tool.git("add", ".");
      tool.git("commit", "-q", "-m", "one");
      const head = tool.git("rev-parse", "HEAD");
      process.chdir(base); // the caller's working directory plays no part
      expect(toolVersion([tool.cli, tool.lib]), "clean, from the command's folder").toBe(head);
      expect(toolVersion([]), "no file given").toBe("unknown");
      expect(toolVersion([join(base, "nowhere.ts")]), "not a checkout").toBe("unknown");
      writeFileSync(join(tool.root, "notes.txt"), "untracked\n");
      expect(toolVersion([tool.cli, tool.lib]), "an untracked file the command does not load").toBe(head);

      // Clean-checkout check: a modified tracked file, even one the command does not load.
      writeFileSync(join(tool.root, "other.ts"), "1\n"); tool.git("add", "other.ts"); tool.git("commit", "-q", "-m", "two");
      const two = tool.git("rev-parse", "HEAD");
      writeFileSync(join(tool.root, "other.ts"), "2\n");
      expect(toolVersion([tool.cli, tool.lib]), "modified, unstaged, not loaded").toBe("unknown");
      tool.git("add", "other.ts");
      expect(toolVersion([tool.cli, tool.lib]), "modified, staged").toBe("unknown");
      tool.git("checkout", "-q", "HEAD", "--", "other.ts");
      expect(toolVersion([tool.cli, tool.lib]), "restored").toBe(two);

      // Tracked-file check: an untracked module the command loads, and an untracked copy of the command placed in an
      // unrelated clean repository (Codex, third pass).
      const extra = join(tool.root, "scripts", "operators", "extra.ts");
      writeFileSync(extra, "export {};\n");
      expect(toolVersion([tool.cli, tool.lib, extra]), "an untracked module is loaded").toBe("unknown");
      const unrelated = repository("unrelated");
      unrelated.git("add", "lib.ts"); unrelated.git("commit", "-q", "-m", "unrelated");
      writeFileSync(unrelated.cli, readFileSync(tool.cli));
      expect(unrelated.git("status", "--porcelain", "--untracked-files=no"), "the unrelated checkout is clean").toBe("");
      expect(toolVersion([unrelated.cli, unrelated.lib]), "untracked command copy in an unrelated clean repository").toBe("unknown");
      expect(toolVersion([tool.cli, join(base, "nowhere.ts")]), "a loaded file outside the checkout").toBe("unknown");

      // Byte comparison: a file hidden from status (assume-unchanged) but different from HEAD.
      tool.git("update-index", "--assume-unchanged", "lib.ts");
      writeFileSync(tool.lib, "export const a = 666;\n");
      expect(tool.git("status", "--porcelain", "--untracked-files=no"), "status cannot see it").toBe("");
      expect(toolVersion([tool.cli, tool.lib]), "loaded file differs from HEAD, hidden from status").toBe("unknown");
      tool.git("update-index", "--no-assume-unchanged", "lib.ts");
      tool.git("checkout", "-q", "HEAD", "--", "lib.ts");
      expect(toolVersion([tool.cli, tool.lib]), "restored").toBe(two);

      // Raw bytes, no Git filter (Codex, fourth pass): a local clean filter that hands Git the committed text while the
      // file Node runs is different.
      mkdirSync(join(tool.root, ".git", "info"), { recursive: true });
      writeFileSync(join(tool.root, ".git", "info", "attributes"), "lib.ts filter=hide\n");
      tool.git("config", "filter.hide.clean", `git cat-file blob ${tool.git("rev-parse", "HEAD:lib.ts")}`);
      writeFileSync(tool.lib, "export const a = 777;\n");
      tool.git("add", "lib.ts"); // the index takes the filtered text: the same blob as HEAD
      expect(tool.git("status", "--porcelain", "--untracked-files=no"), "status sees the filtered text only").toBe("");
      expect(toolVersion([tool.cli, tool.lib]), "a clean filter hides the running code").toBe("unknown");
      rmSync(join(tool.root, ".git", "info", "attributes"));
      tool.git("checkout", "-q", "HEAD", "--", "lib.ts");
      // The one difference accepted: CRLF line endings in the file for LF in the blob (a Windows checkout).
      tool.git("config", "core.autocrlf", "true");
      rmSync(tool.lib);
      execFileSync("git", ["checkout", "-q", "HEAD", "--", "lib.ts"], { cwd: tool.root, stdio: "pipe" }); // Git writes CRLF, as on Windows
      expect(readFileSync(tool.lib, "utf8")).toBe("export const a = 1;\r\n");
      expect(toolVersion([tool.cli, tool.lib]), "CRLF checkout of the same text").toBe(two);
      writeFileSync(tool.lib, "export const a = 2;\r\n");
      expect(toolVersion([tool.cli, tool.lib]), "CRLF checkout of another text").toBe("unknown");
      tool.git("config", "core.autocrlf", "false");
      tool.git("checkout", "-q", "HEAD", "--", "lib.ts");
      expect(toolVersion([tool.cli, tool.lib]), "restored").toBe(two);

      // No replacement objects (Codex, fourth pass): HEAD replaced locally by a commit with other code, checked out.
      writeFileSync(tool.lib, "export const a = 999;\n");
      tool.git("add", "lib.ts");
      const replacementTree = tool.git("write-tree");
      const replacement = tool.git("commit-tree", replacementTree, "-p", two, "-m", "replacement");
      tool.git("reset", "-q", "--hard", two);
      tool.git("replace", two, replacement);
      tool.git("reset", "-q", "--hard", "HEAD"); // with the replacement active, this checks out the replacement's code
      expect(readFileSync(tool.lib, "utf8"), "the replacement's code is checked out").toBe("export const a = 999;\n");
      expect(tool.git("rev-parse", "HEAD"), "HEAD still names the original commit").toBe(two);
      expect(toolVersion([tool.cli, tool.lib]), "a replaced commit").toBe("unknown");
      tool.git("replace", "-d", two);
      tool.git("reset", "-q", "--hard", two);
      expect(toolVersion([tool.cli, tool.lib]), "restored").toBe(two);

      // Inherited Git variables: they cannot point the lookup at another, clean checkout.
      const clean = repository("clean");
      clean.git("add", "."); clean.git("commit", "-q", "-m", "c");
      expect(toolVersion([clean.cli, clean.lib]), "the other checkout is clean").toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(tool.root, "other.ts"), "3\n"); // the tool's own checkout is dirty
      // The case only the removal of GIT_* variables catches: the clean repository's index and history (same loaded
      // files) laid over the tool's own dirty work tree.
      for (const variables of [{ GIT_DIR: join(clean.root, ".git"), GIT_WORK_TREE: tool.root }, { GIT_DIR: join(clean.root, ".git"), GIT_WORK_TREE: clean.root }, { GIT_DIR: join(clean.root, ".git") },
        { GIT_WORK_TREE: clean.root }, { GIT_INDEX_FILE: join(clean.root, ".git", "index") }, { git_dir: join(clean.root, ".git"), GIT_WORK_TREE: clean.root }]) {
        Object.assign(process.env, variables);
        expect(toolVersion([tool.cli, tool.lib]), JSON.stringify(Object.keys(variables))).toBe("unknown");
        for (const name of names) delete process.env[name];
      }
    } finally {
      for (const name of names) delete process.env[name];
      process.chdir(previous);
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000); // dozens of real Git processes: slow on a loaded Windows runner

  it("the command lists every source it has loaded, imports included; a loader it cannot list gives no answer", () => {
    // Codex, fourth pass of #183: run the real loader (tsx, as the command does) in a child process.
    const dir = mkdtempSync(join(tmpdir(), "luxia-loaded-"));
    const tsx = resolve("node_modules/tsx/dist/cli.mjs");
    const helper = resolve("scripts/operators/tool-version.ts").replace(/\\/g, "/");
    const library = resolve("lib/operators/break-glass.ts").replace(/\\/g, "/");
    try {
      // CommonJS, as the command runs today: the entry, the helper, the library and its own imports are listed.
      const cjs = join(dir, "probe.ts");
      writeFileSync(cjs, `import { loadedSources } from "${helper}";\nimport "${library}";\nconsole.log(JSON.stringify(loadedSources()));\n`);
      const listed = JSON.parse(execFileSync(process.execPath, [tsx, cjs], { cwd: process.cwd(), encoding: "utf8" }).trim().split("\n").pop()!) as string[];
      const has = (path: string) => listed.includes(resolve(path));
      expect(listed[0]).toBe(resolve(cjs));
      for (const path of ["scripts/operators/tool-version.ts", "lib/operators/break-glass.ts", "lib/admin/last-administrator.ts", "lib/organizations/lifecycle.ts"])
        expect(has(path), path).toBe(true);
      expect(listed.some((path) => /[\\/]node_modules[\\/]/.test(path))).toBe(false);
      // ES modules: the modules cannot be listed, so nothing is, and the version is "unknown" rather than partial.
      const esm = join(dir, "probe.mts");
      writeFileSync(esm, `import { loadedSources, toolVersion } from "${pathToFileURL(helper).href}";\nimport "${pathToFileURL(library).href}";\nconst listed = loadedSources();\nconsole.log(JSON.stringify([listed, toolVersion(listed)]));\n`);
      const [esmListed, esmVersion] = JSON.parse(execFileSync(process.execPath, [tsx, esm], { cwd: process.cwd(), encoding: "utf8" }).trim().split("\n").pop()!) as [string[], string];
      expect(esmListed).toEqual([]);
      expect(esmVersion).toBe("unknown");
      expect(loadedSources("", {})).toEqual([]);
      // Code preloaded from outside node_modules runs unlisted, so nothing is listed (Antigravity, fourth pass).
      const preload = join(dir, "preload.cjs");
      writeFileSync(preload, "globalThis.preloaded = true;\n");
      const preloaded = JSON.parse(execFileSync(process.execPath, [tsx, cjs], { cwd: process.cwd(), encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}"` } }).trim().split("\n").pop()!) as string[];
      expect(preloaded).toEqual([]);
      for (const [execArgv, options, outside] of [
        [["--require", "C:\\x\\node_modules\\tsx\\dist\\preflight.cjs", "--import", "file:///C:/x/node_modules/tsx/dist/loader.mjs"], "", 0],
        [[], "--import /tmp/evil.mjs", 1], [[], "--require=./evil.js", 1], [[], "-r evil-package", 0], [[], `--import "C:\\Users\\a b\\evil.mjs"`, 1],
        [["--loader", "file:///tmp/evil.mjs"], "", 1], [[], "--max-old-space-size=4096", 0], [[], "--import @scope/package", 0], [[], "--import ../x/evil.mjs", 1],
      ] as const) expect(outsidePreloads(execArgv, options), JSON.stringify([execArgv, options])).toHaveLength(outside);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

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
