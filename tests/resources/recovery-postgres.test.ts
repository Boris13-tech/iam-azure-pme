import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// First Admin / Break-glass v1, B2: recovery codes and the recovery-only session on PostgreSQL, as
// app_user, through the real route handlers (design section 11). The browser cookie is a test jar.
const jar = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "luxia_session" && jar.token ? { name, value: jar.token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("../../lib/auth/providers/entra", () => ({ getEntraLogoutUrl: vi.fn(async () => null) }));

import { rawPrisma } from "../../lib/db/raw-prisma";
import { withTenantDb } from "../../lib/db/scoped-client";
import { SessionStore } from "../../lib/auth/session-store";
import { getAuthContext, type AuthContext } from "../../lib/auth/auth-context";
import { requireAuth } from "../../lib/auth/require-auth";
import { getRecoveryContext } from "../../lib/auth/recovery-session";
import {
  beginRecoveryEnrollment, completeRecoveryEnrollment, generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash, revokeRecoveryCodes,
} from "../../lib/auth/recovery";
import { transitionOrganization, type OrganizationStatus } from "../../lib/organizations/lifecycle";
import { listSecurityJournal } from "../../lib/audit/security-journal";
import { listMySessions } from "../../lib/auth/self-service";
import { softwarePasskey } from "../helpers/software-passkey";
import { withinOneRateLimitWindow } from "../helpers/rate-limit-window";
import { POST as begin } from "../../app/api/auth/local/begin/route";
import { POST as complete } from "../../app/api/auth/local/complete/route";
import { POST as recover } from "../../app/api/auth/local/recovery/route";
import { POST as recoveryBegin } from "../../app/api/auth/recovery/enrollment/begin/route";
import { POST as recoveryComplete } from "../../app/api/auth/recovery/enrollment/complete/route";
import { GET as codeStatus, POST as codeGenerate } from "../../app/api/me/recovery-codes/route";
import { POST as codeRevoke } from "../../app/api/me/recovery-codes/revoke/route";
import { GET as mySessions } from "../../app/api/me/sessions/route";
import { GET as myAuthenticators } from "../../app/api/me/authenticators/route";
import { GET as subjects } from "../../app/api/canonical/subjects/route";
import { GET as sessions } from "../../app/api/canonical/sessions/route";
import { GET as assignments } from "../../app/api/canonical/assignments/route";
import { GET as journal } from "../../app/api/canonical/security-journal/route";
import { GET as posture } from "../../app/api/canonical/posture/route";
import { GET as checklist } from "../../app/api/onboarding/checklist/route";
import { GET as invitations } from "../../app/api/onboarding/invitations/route";
import { GET as platform } from "../../app/api/platform/context/route";
import { POST as fullEnrollment } from "../../app/api/auth/local/enrollment/begin/route";
import { POST as logout } from "../../app/auth/logout/route";

const enabled = process.env.LUXIA_RESOURCE_RLS === "true";
const suffix = randomUUID().slice(0, 8);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const change = () => `b2:${randomUUID()}`;
const GENERIC = { status: 401, body: { error: "LOCAL_AUTHENTICATION_FAILED" }, cookie: null };
let owner: PrismaClient;
let orgs = 0, ips = 0;

type Org = { slug: string; organizationId: string; tenantId: string; subjectId: string; accountId: string; localId: string;
  entraConnection: string; principalName: string; passkey: ReturnType<typeof softwarePasskey> };
async function organization(): Promise<Org> {
  const organizationId = randomUUID(), tenantId = randomUUID(), slug = `rec-${suffix}-${++orgs}`;
  await owner.organization.create({ data: { id: organizationId, name: "Recovery", slug } });
  await owner.tenant.create({ data: { id: tenantId, organizationId, name: "Production" } });
  const connect = async (providerType: "LUXIA_LOCAL" | "MICROSOFT_ENTRA") => {
    const connection = await owner.providerConnection.create({ data: { organizationId, providerType, externalScopeId: `${providerType}-${organizationId}`, name: providerType } });
    await owner.providerConnectionTenantScope.create({ data: { organizationId, tenantId, providerConnectionId: connection.id } });
    return connection.id;
  };
  const local = await connect("LUXIA_LOCAL");
  const entraConnection = await connect("MICROSOFT_ENTRA");
  const subject = await owner.subject.create({ data: { organizationId, tenantId, type: "HUMAN", name: "Holder", lifecycleState: "ACTIVE" } });
  const account = await owner.identityAccount.create({ data: { organizationId, tenantId, subjectId: subject.id, providerConnectionId: local, externalObjectId: randomUUID() } });
  const principalName = `holder-${randomUUID().slice(0, 8)}`;
  const passkey = softwarePasskey();
  const identity = await owner.localIdentity.create({ data: { organizationId, tenantId, identityAccountId: account.id, principalName } });
  await owner.localAuthenticator.create({ data: { organizationId, tenantId, identityAccountId: account.id, type: "PASSKEY", credentialId: passkey.credentialId,
    publicKey: passkey.publicKeyPem, relyingPartyId: "localhost", allowedOrigin: "http://localhost:3000",
    credentialSchemaVersion: 2, credentialFormat: "WEBAUTHN_PUBLIC_KEY", algorithmId: "WEBAUTHN_ES256" } });
  return { slug, organizationId, tenantId, subjectId: subject.id, accountId: account.id, localId: identity.id, entraConnection, principalName, passkey };
}
const scope = (org: Org) => ({ organizationId: org.organizationId, tenantId: org.tenantId });
const nextIp = () => `198.51.100.${(++ips % 250) + 1}-${suffix}`;
const post = (handler: (request: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": nextIp(), ...headers }, body: JSON.stringify(body) }));
const tokenOf = (response: Response) => /luxia_session=([0-9a-f]{64})/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? null;
const settle = (promise: Promise<unknown>) => promise.then((value) => value ?? "ok", (error: unknown) => error);
const codeOf = (error: unknown) => (error as { code?: string })?.code ?? String(error);

/** Normal passkey sign-in through the real routes: a FULL session with its VERIFIED evidence. */
async function passkeySignIn(org: Org, passkey = org.passkey) {
  const started = await post(begin, "/api/auth/local/begin", { organization: org.slug, principalName: org.principalName });
  const challenge = await started.json() as { transactionId: string; challenge: string };
  const done = await post(complete, "/api/auth/local/complete", { organization: org.slug, transactionId: challenge.transactionId,
    challenge: challenge.challenge, ...passkey.assert(challenge.challenge) });
  return { status: done.status, token: tokenOf(done) };
}
async function signedIn(org: Org): Promise<{ token: string; auth: AuthContext }> {
  const { status, token } = await passkeySignIn(org);
  expect(status).toBe(200);
  jar.token = token!;
  const auth = await getAuthContext();
  if (!auth) throw new Error("FULL_SESSION_EXPECTED");
  return { token: token!, auth };
}
async function generate(token: string) {
  jar.token = token;
  const response = await codeGenerate(new Request("http://localhost:3000/api/me/recovery-codes", { method: "POST", headers: { "x-luxia-change-id": change() } }));
  return { status: response.status, body: await response.json() as { codes: string[]; batchId: string; revokedCodes: number; error?: string } };
}
async function withCodes(org: Org) {
  const { token, auth } = await signedIn(org);
  const generated = await generate(token);
  expect(generated.status).toBe(200);
  return { token, auth, codes: generated.body.codes, batchId: generated.body.batchId };
}
async function recoverWith(org: Org, code: string, overrides: { principalName?: string; slug?: string; ip?: string } = {}) {
  const startedAt = Date.now();
  const response = await post(recover, "/api/auth/local/recovery", { organization: overrides.slug ?? org.slug,
    principalName: overrides.principalName ?? org.principalName, code }, overrides.ip ? { "x-real-ip": overrides.ip } : {});
  return { status: response.status, body: await response.json(), cookie: tokenOf(response), elapsed: Date.now() - startedAt };
}
const shape = ({ status, body, cookie }: { status: number; body: unknown; cookie: string | null }) => ({ status, body, cookie });
const codeRow = (org: Org, code: string) => owner.localRecoveryCode.findFirstOrThrow({ where: { ...scope(org), codeHash: recoveryCodeHash(org.accountId, normalizeRecoveryCode(code)!) } });
const transition = (org: Org, to: OrganizationStatus) => owner.$transaction((tx) => transitionOrganization(tx, org.organizationId, to), { timeout: 60_000 });
const asApp = <T>(org: Org, work: (tx: Prisma.TransactionClient) => Promise<T>) => withTenantDb(scope(org), work);

function gate() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }
/** Waits until `count` row locks are being waited for (transactionid or tuple waits). */
async function waitBlocked(count: number) {
  for (let attempt = 0; ; attempt++) {
    const [{ waiting }] = await owner.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks
      WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`;
    if (waiting >= count) return;
    if (attempt > 400) throw new Error("NOT_BLOCKED");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Holds one row FOR UPDATE (owner) while the operations start, in order, and queue on it. */
async function race(lockRow: (tx: Prisma.TransactionClient) => Promise<unknown>, operations: Array<() => Promise<unknown>>) {
  const release = gate(); const ready = gate();
  const holder = owner.$transaction(async (tx) => { await lockRow(tx); ready.open(); await release.promise; }, { timeout: 60_000 });
  await ready.promise;
  const settled: Promise<unknown>[] = [];
  try {
    for (const [index, operation] of operations.entries()) { settled.push(settle(operation())); await waitBlocked(index + 1); }
  } finally { release.open(); }
  await holder;
  return Promise.all(settled);
}
const lockCode = (org: Org, code: string) => async (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT 1 FROM "LocalRecoveryCode" WHERE "codeHash" = ${recoveryCodeHash(org.accountId, normalizeRecoveryCode(code)!)} FOR UPDATE`;

describe.runIf(enabled)("B2 recovery codes and recovery-only session (app_user, PostgreSQL)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_MIGRATION_URL || !process.env.DATABASE_URL) throw new Error("ISOLATED_DB_REQUIRED");
    owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_MIGRATION_URL } } });
  });
  afterAll(async () => { await rawPrisma.$disconnect(); await owner?.$disconnect(); });

  it("generation: 10 codes shown once, only account-bound hashes stored, a new batch and 'revoke all' end the old codes", async () => {
    const org = await organization();
    const { token, codes, batchId } = await withCodes(org);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    const rows = await owner.localRecoveryCode.findMany({ where: { ...scope(org) } });
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.codeHash).sort()).toEqual(codes.map((code) => recoveryCodeHash(org.accountId, normalizeRecoveryCode(code)!)).sort());
    expect(rows.every((row) => row.batchId === batchId && row.usedAt === null && row.revokedAt === null && row.expiresAt === null)).toBe(true);
    const stored = JSON.stringify(rows) + JSON.stringify(await owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId } }));
    for (const code of codes) expect(stored).not.toContain(normalizeRecoveryCode(code)!);
    const event = await owner.canonicalAdminAuditEvent.findFirstOrThrow({ where: { organizationId: org.organizationId, operation: "RECOVERY_CODES.GENERATE" } });
    expect(event).toMatchObject({ result: "SUCCESS", actorSubjectId: org.subjectId, targetSubjectId: org.subjectId, metadata: { batchId, count: 10, revokedCodes: 0 } });

    // Never readable again: the status answer has no code.
    jar.token = token;
    const status = await codeStatus();
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ available: true, remaining: 10, recoveryUsedInCurrentBatch: false });
    for (const code of codes) expect(JSON.stringify(statusBody)).not.toContain(normalizeRecoveryCode(code)!);

    // A new batch revokes every unused code of the earlier one, in the same transaction.
    const second = await generate(token);
    expect(second.body.revokedCodes).toBe(10);
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), batchId, revokedAt: { not: null }, usedAt: null } })).toBe(10);
    expect(shape(await recoverWith(org, codes[0]))).toEqual(GENERIC);

    // Revoke all: once, with its journal event; a replayed change id is refused.
    const changeId = change();
    const revoke = () => { jar.token = token; return codeRevoke(new Request("http://localhost:3000/api/me/recovery-codes/revoke", { method: "POST", headers: { "x-luxia-change-id": changeId } })); };
    expect(await (await revoke()).json()).toEqual({ revokedCodes: 10 });
    expect((await revoke()).status).toBe(409);
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(0);
    expect(await (await codeStatus()).json()).toMatchObject({ available: true, remaining: 0 });
    expect(shape(await recoverWith(org, second.body.codes[0]))).toEqual(GENERIC);
  }, 60_000);

  it("generation needs a passkey sign-in less than 15 minutes old (R2) on a LUXIA local account, and is rate limited", async () => {
    const org = await organization();
    // A FULL session without a passkey sign-in behind it.
    const bare = await SessionStore.createSession({ ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId });
    expect(await generate(bare.rawToken)).toMatchObject({ status: 403, body: { error: "RECENT_PASSKEY_SIGN_IN_REQUIRED" } });
    // A passkey session, but more than 15 minutes later.
    const { auth } = await signedIn(org);
    await expect(generateRecoveryCodes(auth, change(), new Date(Date.now() + 16 * 60_000))).rejects.toMatchObject({ code: "RECENT_PASSKEY_SIGN_IN_REQUIRED" });
    expect(await owner.localRecoveryCode.count({ where: scope(org) })).toBe(0);

    // A Microsoft-only account gets no codes.
    const person = await owner.subject.create({ data: { ...scope(org), type: "HUMAN", name: "Microsoft only", lifecycleState: "ACTIVE" } });
    const entraAccount = await owner.identityAccount.create({ data: { ...scope(org), subjectId: person.id, providerConnectionId: org.entraConnection, externalObjectId: randomUUID() } });
    const entra = await SessionStore.createSession({ ...scope(org), subjectId: person.id, identityAccountId: entraAccount.id });
    jar.token = entra.rawToken;
    expect(await (await codeStatus()).json()).toEqual({ available: false, remaining: 0, batchCreatedAt: null, recoveryUsedInCurrentBatch: false });
    expect(await generate(entra.rawToken)).toMatchObject({ status: 403, body: { error: "RECOVERY_CODES_NOT_AVAILABLE" } });

    // 5 batches a day per person (the two refused attempts above counted for their own people).
    const fresh = await organization();
    const { token } = await signedIn(fresh);
    await withinOneRateLimitWindow(86400, 30); // counted per day: the six requests below share one window
    for (let i = 0; i < 5; i++) expect((await generate(token)).status).toBe(200);
    expect(await generate(token)).toMatchObject({ status: 429, body: { error: "RATE_LIMITED" } });
    expect(await owner.localRecoveryCode.count({ where: { ...scope(fresh), usedAt: null, revokedAt: null } })).toBe(10);
  }, 90_000);

  it("recovery sign-in: a RECOVERY session of exactly 15 minutes, VERIFIED evidence and journal event; the code is single use", async () => {
    const org = await organization();
    const { codes, token: full } = await withCodes(org);
    // Typed loosely: lower case, spaces instead of hyphens.
    const result = await recoverWith(org, codes[3].toLowerCase().replace(/-/g, " "));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "RECOVERY", redirectTo: "/recovery" });
    expect(result.cookie).toMatch(/^[0-9a-f]{64}$/);
    const session = await owner.session.findUniqueOrThrow({ where: { id: sha(result.cookie!) } });
    expect(session).toMatchObject({ scope: "RECOVERY", subjectId: org.subjectId, identityAccountId: org.accountId, revokedAt: null });
    expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBe(15 * 60_000);
    expect(await codeRow(org, codes[3])).toMatchObject({ usedAt: session.createdAt, revokedAt: null });
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(9);
    const evidence = await owner.authenticationEvidence.findFirstOrThrow({ where: { ...scope(org), reasonCode: "LOCAL_RECOVERY_CODE_VERIFIED" } });
    expect(evidence).toMatchObject({ outcome: "VERIFIED", method: "CUSTOM", assuranceLevel: "LOW", assuranceProfile: "local-recovery",
      phishingResistant: false, hardwareBound: false, userVerification: "NOT_VERIFIED", source: "LOCAL_VERIFIER", identityAccountId: org.accountId });
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: org.organizationId, operation: "RECOVERY.SIGN_IN" } })).toBe(1);
    // B5: the security journal and « Mes sessions » name it for what it is, never a generic method or a passkey.
    const self = { organizationId: org.organizationId, tenantId: org.tenantId, subjectId: org.subjectId };
    const signIns = (await listSecurityJournal(self, { kind: "sign-in" })).entries;
    expect(signIns.filter((entry) => entry.method === "RECOVERY_CODE")).toEqual([expect.objectContaining({ result: "SUCCESS", assurance: "RECOVERY_CODE" })]);
    expect(signIns.some((entry) => entry.method === "CUSTOM")).toBe(false);
    const mine = await listMySessions({ ...self, sessionId: "not-a-session", identityAccountId: org.accountId });
    expect(mine.filter((own) => own.scope === "RECOVERY")).toEqual([expect.objectContaining({ providerType: "LUXIA_LOCAL", current: false })]);

    expect(await SessionStore.getSession(result.cookie!)).toBeNull(); // never a FULL session
    expect(await SessionStore.getRecoverySession(result.cookie!)).toMatchObject({ id: session.id, scope: "RECOVERY" });
    // A consumed code never opens a second session.
    expect(shape(await recoverWith(org, codes[3]))).toEqual(GENERIC);
    expect(await owner.session.count({ where: { ...scope(org), scope: "RECOVERY" } })).toBe(1);
    // R5: the fact comes from the database.
    jar.token = full;
    expect(await (await codeStatus()).json()).toMatchObject({ remaining: 9, recoveryUsedInCurrentBatch: true });
  }, 60_000);

  it("every refusal is the same 401 after the same minimum duration, consumes nothing and opens nothing", async () => {
    const unknown = await recoverWith(await organization(), "0123456789ABCDEFGHJK", { slug: `unknown-${suffix}` });
    expect(shape(unknown)).toEqual(GENERIC);

    const a = await organization(); const { codes } = await withCodes(a);
    const refusals: Array<[string, Awaited<ReturnType<typeof recoverWith>>]> = [
      ["unknown person", await recoverWith(a, codes[0], { principalName: "nobody-here" })],
      ["wrong code", await recoverWith(a, "0123456789ABCDEFGHJK")],
      ["malformed code", await recoverWith(a, "not-a-code")],
    ];
    const b = await organization(); const bCodes = (await withCodes(b)).codes;
    await revokeRecoveryCodes((await signedIn(b)).auth, change());
    refusals.push(["revoked code", await recoverWith(b, bCodes[0])]);

    const prepared = async (label: string, mutate: (org: Org) => Promise<unknown>) => {
      const org = await organization(); const { codes: own } = await withCodes(org);
      await mutate(org);
      refusals.push([label, await recoverWith(org, own[0])]);
      expect(await codeRow(org, own[0]), label).toMatchObject({ usedAt: null, revokedAt: null });
      return { org, code: own[1] };
    };
    await prepared("suspended organization", (org) => transition(org, "SUSPENDED"));
    await prepared("closed organization", (org) => transition(org, "CLOSED"));
    await prepared("disabled account", (org) => owner.$executeRaw`UPDATE "IdentityAccount" SET "status" = 'DISABLED', "disabledAt" = now() WHERE "id" = ${org.accountId}`);
    await prepared("suspended person", (org) => owner.$executeRaw`UPDATE "Subject" SET "lifecycleState" = 'SUSPENDED' WHERE "id" = ${org.subjectId}`);
    await prepared("disabled local identity", (org) => owner.$executeRaw`UPDATE "LocalIdentity" SET "status" = 'DISABLED' WHERE "id" = ${org.localId}`);
    const locked = await prepared("locked local identity", (org) => owner.$executeRaw`UPDATE "LocalIdentity" SET "status" = 'LOCKED', "lockedUntil" = now() + interval '1 hour' WHERE "id" = ${org.localId}`);

    for (const [label, refusal] of refusals) {
      expect(shape(refusal), label).toEqual(GENERIC);
      expect(refusal.elapsed, label).toBeGreaterThanOrEqual(390);
    }
    expect(await owner.session.count({ where: { scope: "RECOVERY", organizationId: { in: [a.organizationId, b.organizationId, locked.org.organizationId] } } })).toBe(0);
    // Known people get a REJECTED evidence with the precise reason; nobody is told which part failed.
    const reasons = await owner.authenticationEvidence.findMany({ where: { outcome: "REJECTED", organizationId: { in: [a.organizationId, locked.org.organizationId] } }, select: { reasonCode: true } });
    expect(reasons.map((row) => row.reasonCode).sort()).toEqual(["LOCAL_IDENTITY_NOT_ACTIVE", "RECOVERY_CODE_INVALID"]);

    // A lock that has expired no longer refuses (decision R3: no lockout by recovery attempts).
    await owner.$executeRaw`UPDATE "LocalIdentity" SET "lockedUntil" = now() - interval '1 minute' WHERE "id" = ${locked.org.localId}`;
    expect((await recoverWith(locked.org, locked.code)).status).toBe(200);
  }, 120_000);

  it("rate limits: 5 per hour per person and 10 per hour per client, then even a valid code is refused and not consumed", async () => {
    const org = await organization(); const { codes } = await withCodes(org);
    await withinOneRateLimitWindow(3600, 60); // both scopes count per hour: every hit below shares one window
    for (let i = 0; i < 5; i++) expect(shape(await recoverWith(org, "0123456789ABCDEFGHJK"))).toEqual(GENERIC);
    expect(shape(await recoverWith(org, codes[0]))).toEqual(GENERIC);
    expect(await codeRow(org, codes[0])).toMatchObject({ usedAt: null });

    const other = await organization(); const own = (await withCodes(other)).codes;
    const client = `203.0.113.250-${suffix}`;
    for (let i = 0; i < 10; i++) expect(shape(await recoverWith(other, "0123456789ABCDEFGHJK", { principalName: `nobody-${i}`, ip: client }))).toEqual(GENERIC);
    expect(shape(await recoverWith(other, own[0], { ip: client }))).toEqual(GENERIC);
    expect(await codeRow(other, own[0])).toMatchObject({ usedAt: null });
    expect((await recoverWith(other, own[0])).status).toBe(200); // another client
  }, 120_000);

  it("a recovery session is refused everywhere else, even for an administrator, and accepted only by the allow-list", async () => {
    const org = await organization();
    for (const key of ["subjects.read", "sessions.read", "assignments.read", "assignments.manage", "audit.read", "providers.manage"]) {
      const entitlement = await owner.entitlement.create({ data: { ...scope(org), key, resource: key.split(".")[0], action: key.split(".")[1] } });
      await owner.assignment.create({ data: { ...scope(org), subjectId: org.subjectId, entitlementId: entitlement.id, source: "DIRECT", sourceRef: "b2-test" } });
    }
    const { codes } = await withCodes(org);
    const { cookie: token } = await recoverWith(org, codes[0]);
    jar.token = token!;
    expect(await getAuthContext()).toBeNull();
    await expect(requireAuth()).rejects.toThrow("UNAUTHORIZED");
    const url = (path: string) => `http://localhost:3000${path}`;
    const routes: Array<[string, () => Promise<Response>]> = [
      ["me/sessions", () => mySessions()], ["me/authenticators", () => myAuthenticators()], ["me/recovery-codes GET", () => codeStatus()],
      ["me/recovery-codes POST", () => codeGenerate(new Request(url("/api/me/recovery-codes"), { method: "POST", headers: { "x-luxia-change-id": change() } }))],
      ["me/recovery-codes/revoke", () => codeRevoke(new Request(url("/api/me/recovery-codes/revoke"), { method: "POST", headers: { "x-luxia-change-id": change() } }))],
      ["canonical/subjects", () => subjects()], ["canonical/sessions", () => sessions()], ["canonical/assignments", () => assignments()],
      ["canonical/security-journal", () => journal(new Request(url("/api/canonical/security-journal")))], ["canonical/posture", () => posture()],
      ["onboarding/checklist", () => checklist()], ["onboarding/invitations", () => invitations()], ["platform/context", () => platform()],
      ["local/enrollment/begin", () => fullEnrollment(new Request(url("/api/auth/local/enrollment/begin"), { method: "POST", body: JSON.stringify({ principalName: org.principalName }) }))],
    ];
    for (const [name, call] of routes) expect((await call()).status, name).toBe(401);
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(9);

    // Allowed: enrolment begin for its own account, and sign-out.
    const started = await recoveryBegin(new Request(url("/api/auth/recovery/enrollment/begin"), { method: "POST" }));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ rp: { id: "localhost" }, user: { name: org.principalName } });
    const out = await logout(new NextRequest(url("/auth/logout"), { method: "POST", headers: { cookie: `luxia_session=${token}` } }));
    expect(out.status).toBe(303);
    expect((await owner.session.findUniqueOrThrow({ where: { id: sha(token!) } })).revokedAt).toBeInstanceOf(Date);
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: org.organizationId, operation: "SESSION.SIGN_OUT" } })).toBe(1);
    expect((await recoveryBegin(new Request(url("/api/auth/recovery/enrollment/begin"), { method: "POST" }))).status).toBe(401);
  }, 60_000);

  it("a recovery session lives 15 minutes at most and is never extended", async () => {
    const org = await organization();
    const insert = (createdAt: Date, expiresAt: Date) => owner.session.create({ data: { id: sha(randomUUID()), ...scope(org), subjectId: org.subjectId,
      identityAccountId: org.accountId, scope: "RECOVERY", createdAt, expiresAt } });
    const now = new Date();
    await expect(insert(now, new Date(now.getTime() + 15 * 60_000 + 1))).rejects.toThrow(/Session_recovery_lifetime/);
    const expiredToken = randomBytes(32).toString("hex");
    await owner.session.create({ data: { id: sha(expiredToken), ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId,
      scope: "RECOVERY", createdAt: new Date(now.getTime() - 16 * 60_000), expiresAt: new Date(now.getTime() - 60_000) } });
    expect(await SessionStore.getRecoverySession(expiredToken)).toBeNull();
    jar.token = expiredToken;
    expect((await recoveryBegin(new Request("http://localhost:3000/api/auth/recovery/enrollment/begin", { method: "POST" }))).status).toBe(401);

    // A live session: resolution never refreshes it, and an enrolment after its expiry is refused with no write.
    const { codes } = await withCodes(org);
    const { cookie: token } = await recoverWith(org, codes[0]);
    const before = await owner.session.findUniqueOrThrow({ where: { id: sha(token!) } });
    for (let i = 0; i < 3; i++) await SessionStore.getRecoverySession(token!);
    expect(await owner.session.findUniqueOrThrow({ where: { id: sha(token!) } })).toEqual(before);
    jar.token = token!;
    const context = (await getRecoveryContext())!;
    const options = await beginRecoveryEnrollment(context, "localhost");
    const late = new Date(before.expiresAt.getTime() + 1_000);
    await expect(completeRecoveryEnrollment(context, { transactionId: options.transactionId, ...softwarePasskey().register(options.challenge) },
      { rpId: "localhost", origin: "http://localhost:3000" }, late)).rejects.toMatchObject({ code: "RECOVERY_SESSION_INVALID" });
    expect(await owner.session.findUniqueOrThrow({ where: { id: sha(token!) } })).toEqual(before);
    expect(await owner.localAuthenticator.count({ where: { ...scope(org) } })).toBe(1);
  }, 60_000);

  it("enrolment ends the recovery session, revokes the other sessions and previous passkeys (R4); the new passkey signs in FULL", async () => {
    const org = await organization();
    const { codes, token: first } = await withCodes(org);
    const other = await SessionStore.createSession({ ...scope(org), subjectId: org.subjectId, identityAccountId: org.accountId });
    const { cookie: token } = await recoverWith(org, codes[0]);
    jar.token = token!;
    const started = await recoveryBegin(new Request("http://localhost:3000/api/auth/recovery/enrollment/begin", { method: "POST" }));
    const options = await started.json() as { transactionId: string; challenge: string };
    const replacement = softwarePasskey();
    const registration = { transactionId: options.transactionId, ...replacement.register(options.challenge) };
    const done = await post(recoveryComplete, "/api/auth/recovery/enrollment/complete", registration);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "ENROLLED", redirectTo: "/login" });
    expect(done.headers.get("set-cookie")).toMatch(/luxia_session=;.*Max-Age=0/i);

    const all = await owner.session.findMany({ where: { ...scope(org) } });
    expect(all.filter((session) => session.revokedAt === null)).toEqual([]);
    expect(all.map((session) => session.id).sort()).toEqual([sha(first), other.session.id, sha(token!)].sort());
    const authenticators = await owner.localAuthenticator.findMany({ where: { ...scope(org) }, orderBy: { enrolledAt: "asc" } });
    expect(authenticators.map((item) => [item.credentialId, item.status])).toEqual([[org.passkey.credentialId, "REVOKED"], [replacement.credentialId, "ACTIVE"]]);
    expect(authenticators[0]).toMatchObject({ stateVersion: 2 });
    expect(authenticators[0].revokedAt).toBeInstanceOf(Date);
    const events = await owner.canonicalAdminAuditEvent.findMany({ where: { organizationId: org.organizationId, operation: { in: ["RECOVERY.PASSKEY_ENROLLED", "LOCAL_AUTHENTICATOR.ENROLL"] } } });
    expect(events.map((event) => [event.operation, event.metadata])).toEqual(expect.arrayContaining([
      ["RECOVERY.PASSKEY_ENROLLED", { passkeysRevoked: 1, sessionsRevoked: 2 }], ["LOCAL_AUTHENTICATOR.ENROLL", { type: "PASSKEY", via: "RECOVERY" }]]));

    // One enrolment per recovery session.
    expect((await post(recoveryComplete, "/api/auth/recovery/enrollment/complete", registration)).status).toBe(401);
    // The old passkey is refused; the new one gives a FULL session.
    expect((await passkeySignIn(org)).status).toBe(401);
    const signed = await passkeySignIn(org, replacement);
    expect(signed.status).toBe(200);
    expect(await SessionStore.getSession(signed.token!)).toMatchObject({ scope: "FULL" });
    // R5: the notice stays until a new batch exists.
    jar.token = signed.token!;
    expect(await (await codeStatus()).json()).toMatchObject({ remaining: 9, recoveryUsedInCurrentBatch: true });
    expect((await generate(signed.token!)).body.revokedCodes).toBe(9);
    jar.token = signed.token!;
    expect(await (await codeStatus()).json()).toMatchObject({ remaining: 10, recoveryUsedInCurrentBatch: false });
  }, 60_000);

  it("database guard: single use, no resurrection, frozen rows, no delete, at most 10 usable codes, ACTIVE organization", async () => {
    const org = await organization();
    const { codes } = await withCodes(org);
    const [used, revoked, spare] = await Promise.all(codes.slice(0, 3).map((code) => codeRow(org, code)));
    const row = (overrides: Partial<Prisma.LocalRecoveryCodeUncheckedCreateInput> = {}) => ({ ...scope(org), identityAccountId: org.accountId,
      codeHash: sha(randomUUID()), batchId: randomUUID(), ...overrides });
    await expect(asApp(org, (tx) => tx.localRecoveryCode.create({ data: row() }))).rejects.toThrow(/RECOVERY_CODE_LIMIT/);
    await expect(asApp(org, (tx) => tx.localRecoveryCode.create({ data: row({ usedAt: new Date() }) }))).rejects.toThrow(/RECOVERY_CODE_INVALID_INITIAL_STATE/);
    const update = (id: string, data: Prisma.LocalRecoveryCodeUncheckedUpdateManyInput) => asApp(org, (tx) => tx.localRecoveryCode.updateMany({ where: { id }, data }));
    await expect(update(spare.id, { codeHash: sha(randomUUID()) })).rejects.toThrow(/RECOVERY_CODE_IMMUTABLE/);
    await expect(update(spare.id, { batchId: randomUUID() })).rejects.toThrow(/RECOVERY_CODE_IMMUTABLE/);
    await expect(update(spare.id, { usedAt: new Date(), revokedAt: new Date() })).rejects.toThrow(/RECOVERY_CODE_ONE_CHANGE/);
    await expect(update(spare.id, { createdAt: new Date() })).rejects.toThrow(/RECOVERY_CODE_IMMUTABLE|RECOVERY_CODE_ONE_CHANGE/);
    expect(await update(used.id, { usedAt: new Date() })).toEqual({ count: 1 });
    expect(await update(revoked.id, { revokedAt: new Date() })).toEqual({ count: 1 });
    for (const data of [{ usedAt: null }, { revokedAt: new Date() }, { usedAt: new Date() }] as const)
      await expect(update(used.id, data), JSON.stringify(data)).rejects.toThrow(/RECOVERY_CODE_FROZEN/);
    for (const data of [{ revokedAt: null }, { usedAt: new Date() }] as const)
      await expect(update(revoked.id, data), JSON.stringify(data)).rejects.toThrow(/RECOVERY_CODE_FROZEN/);
    // Even the owner cannot resurrect or delete a code.
    await expect(owner.localRecoveryCode.update({ where: { id: revoked.id }, data: { revokedAt: null } })).rejects.toThrow(/RECOVERY_CODE_FROZEN/);
    await expect(owner.localRecoveryCode.delete({ where: { id: spare.id } })).rejects.toThrow(/RECOVERY_CODE_IMMUTABLE/);
    await expect(asApp(org, (tx) => tx.localRecoveryCode.deleteMany({ where: { id: spare.id } }))).rejects.toThrow(/RECOVERY_CODE_IMMUTABLE/);
    // Room for one more usable code now (8 usable): a new one is accepted, then the limit applies again.
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(8);
    await expect(owner.localRecoveryCode.create({ data: row({ codeHash: "not-a-hash" }) })).rejects.toThrow(/LocalRecoveryCode_hash_format/);
    await asApp(org, (tx) => tx.localRecoveryCode.createMany({ data: [row(), row()] }));
    await expect(asApp(org, (tx) => tx.localRecoveryCode.create({ data: row() }))).rejects.toThrow(/RECOVERY_CODE_LIMIT/);
    // A SUSPENDED organization: no new code and no consumption; revoking stays possible.
    await transition(org, "SUSPENDED");
    await expect(update(spare.id, { usedAt: new Date() })).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
    await revokeOne(org, spare.id);
    await expect(owner.localRecoveryCode.create({ data: row() })).rejects.toThrow(/ORGANIZATION_NOT_ACTIVE/);
  }, 60_000);

  it("race: two recovery sign-ins with the same code open one session; the other gets the generic answer", async () => {
    const org = await organization();
    const { codes } = await withCodes(org);
    const results = await race(lockCode(org, codes[0]), [() => recoverWith(org, codes[0]), () => recoverWith(org, codes[0])]) as Array<{ status: number }>;
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(await owner.session.count({ where: { ...scope(org), scope: "RECOVERY" } })).toBe(1);
    expect(await owner.authenticationEvidence.count({ where: { ...scope(org), reasonCode: "LOCAL_RECOVERY_CODE_VERIFIED" } })).toBe(1);
  }, 60_000);

  for (const kind of ["new batch", "revoke all"] as const) {
    for (const first of ["sign-in", kind] as const) {
      it(`race: ${kind} and a recovery sign-in with an old code, ${first} first: never both`, async () => {
        const org = await organization();
        const { codes, auth } = await withCodes(org);
        const writer = () => kind === "new batch" ? generateRecoveryCodes(auth, change()) : revokeRecoveryCodes(auth, change());
        const signIn = () => recoverWith(org, codes[0]);
        const results = await race(lockCode(org, codes[0]), first === "sign-in" ? [signIn, writer] : [writer, signIn]);
        const [signedIn, written] = (first === "sign-in" ? results : [...results].reverse()) as [{ status: number }, { revokedCodes: number }];
        const row = await codeRow(org, codes[0]);
        if (first === "sign-in") {
          expect(signedIn.status).toBe(200);
          expect(written.revokedCodes).toBe(9);
          expect(row.usedAt).toBeInstanceOf(Date);
          expect(row.revokedAt).toBeNull();
        } else {
          expect(signedIn.status).toBe(401);
          expect(written.revokedCodes).toBe(10);
          expect(row.revokedAt).toBeInstanceOf(Date);
          expect(row.usedAt).toBeNull();
        }
        expect(await owner.session.count({ where: { ...scope(org), scope: "RECOVERY" } })).toBe(first === "sign-in" ? 1 : 0);
        expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(kind === "new batch" ? 10 : 0);
      }, 60_000);
    }
  }

  it("race: two batches at once are serialized on the person's row: never more than 10 usable codes", async () => {
    const org = await organization();
    const { auth } = await signedIn(org);
    const results = await Promise.all([generateRecoveryCodes(auth, change()), generateRecoveryCodes(auth, change())].map(settle));
    expect(results.every((result) => (result as { codes?: string[] }).codes?.length === 10)).toBe(true);
    expect((results as Array<{ revokedCodes: number }>).map((result) => result.revokedCodes).sort()).toEqual([0, 10]);
    expect(await owner.localRecoveryCode.count({ where: { ...scope(org), usedAt: null, revokedAt: null } })).toBe(10);
  }, 60_000);

  it("race: two enrolment completions in one recovery session give one passkey; the second is refused", async () => {
    const org = await organization();
    const { codes } = await withCodes(org);
    const { cookie: token } = await recoverWith(org, codes[0]);
    jar.token = token!;
    const context = (await getRecoveryContext())!;
    const origin = { rpId: "localhost", origin: "http://localhost:3000" };
    const attempts = await Promise.all([1, 2].map(async () => {
      const options = await beginRecoveryEnrollment(context, "localhost");
      const passkey = softwarePasskey();
      return { passkey, input: { transactionId: options.transactionId, ...passkey.register(options.challenge) } };
    }));
    const results = await race((tx) => tx.$queryRaw`SELECT 1 FROM "Session" WHERE "id" = ${sha(token!)} FOR UPDATE`,
      attempts.map(({ input }) => () => completeRecoveryEnrollment(context, input, origin)));
    expect(results.map((result) => result instanceof Error ? codeOf(result) : (result as { status: string }).status).sort()).toEqual(["ENROLLED", "RECOVERY_SESSION_INVALID"]);
    expect(await owner.localAuthenticator.count({ where: { ...scope(org), status: "ACTIVE" } })).toBe(1);
    expect(await owner.canonicalAdminAuditEvent.count({ where: { organizationId: org.organizationId, operation: "RECOVERY.PASSKEY_ENROLLED" } })).toBe(1);
  }, 60_000);

  it("race: suspension first, a recovery sign-in waits on the organization row and is refused without consuming the code", async () => {
    const org = await organization();
    const { codes } = await withCodes(org);
    const results = await race(async (tx) => {
      await transitionOrganization(tx, org.organizationId, "SUSPENDED");
    }, [() => recoverWith(org, codes[0])]) as Array<{ status: number }>;
    expect(results[0].status).toBe(401);
    expect(await codeRow(org, codes[0])).toMatchObject({ usedAt: null, revokedAt: null });
    expect(await owner.session.count({ where: { ...scope(org), scope: "RECOVERY" } })).toBe(0);
  }, 60_000);

  it("race: recovery sign-in first, the suspension waits, then revokes the new recovery session too", async () => {
    const org = await organization();
    const { codes } = await withCodes(org);
    const results = await race(lockCode(org, codes[0]), [() => recoverWith(org, codes[0]), () => transition(org, "SUSPENDED")]);
    const [signIn, suspended] = results as [{ status: number; cookie: string }, { revokedSessions: number }];
    expect(signIn.status).toBe(200);
    expect(suspended.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await owner.session.findUniqueOrThrow({ where: { id: sha(signIn.cookie) } })).revokedAt).toBeInstanceOf(Date);
    expect(await SessionStore.getRecoverySession(signIn.cookie)).toBeNull();
    expect((await owner.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).status).toBe("SUSPENDED");
  }, 60_000);
});

async function revokeOne(org: Org, id: string) {
  expect(await withTenantDb(scope(org), (tx) => tx.localRecoveryCode.updateMany({ where: { id }, data: { revokedAt: new Date() } }))).toEqual({ count: 1 });
}
