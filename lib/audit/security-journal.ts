// Security Journal v1 (R1): one tenant-scoped, read-only journal merging administrative events
// (CanonicalAdminAuditEvent) and sign-in evidence (AuthenticationEvidence), newest first, with a
// stable cursor. Each consultation is itself audited (AUDIT.READ). No token, hash, IP or credential.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withTenantDb } from "../db/scoped-client";

export type JournalKind = "SIGN_IN" | "ADMIN";
export type JournalEntry = Readonly<{
  id: string; kind: JournalKind; occurredAt: string;
  /** Canonical operation code for ADMIN entries; "SIGN_IN" for sign-in evidence. */
  action: string;
  result: "SUCCESS" | "DENIED" | "FAILURE";
  actorName: string | null; targetName: string | null;
  /** Sign-in only. */
  method?: string; providerType?: string | null;
  /** Sign-in only. Never claims MFA: Entra is "PROVIDER_ATTESTED" (decision S1). */
  assurance?: "PROVIDER_ATTESTED" | "PHISHING_RESISTANT" | "STANDARD";
  reasonCode?: string;
}>;
export type JournalPage = Readonly<{ entries: readonly JournalEntry[]; nextCursor: string | null }>;
export type JournalQuery = Readonly<{ limit?: number; cursor?: string | null; includeReads?: boolean; kind?: "all" | "sign-in" | "admin" }>;

type Cursor = { t: Date; kind: JournalKind; id: string };
const KIND_RANK: Record<JournalKind, number> = { SIGN_IN: 1, ADMIN: 0 };

export function encodeCursor(entry: Pick<JournalEntry, "occurredAt" | "kind" | "id">): string {
  return Buffer.from(`${entry.occurredAt}|${entry.kind}|${entry.id}`, "utf8").toString("base64url");
}
export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  const [iso, kind, id] = Buffer.from(value, "base64url").toString("utf8").split("|");
  const t = new Date(iso);
  if (!id || Number.isNaN(t.getTime()) || (kind !== "SIGN_IN" && kind !== "ADMIN") || !/^[\w:.-]{1,128}$/.test(id)) throw new Error("INVALID_CURSOR");
  return { t, kind, id };
}
/** Total order used everywhere: occurredAt desc, then SIGN_IN before ADMIN, then id desc. */
export function compareEntries(a: Pick<JournalEntry, "occurredAt" | "kind" | "id">, b: Pick<JournalEntry, "occurredAt" | "kind" | "id">): number {
  const ta = Date.parse(a.occurredAt), tb = Date.parse(b.occurredAt);
  if (ta !== tb) return tb - ta;
  if (a.kind !== b.kind) return KIND_RANK[b.kind] - KIND_RANK[a.kind];
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
/** Rows of `kind` strictly after the cursor in the total order. */
function after(kind: JournalKind, cursor: Cursor | null): { OR?: object[]; occurredAt?: object } {
  if (!cursor) return {};
  if (kind === cursor.kind) return { OR: [{ occurredAt: { lt: cursor.t } }, { occurredAt: cursor.t, id: { lt: cursor.id } }] };
  // Same timestamp: SIGN_IN ranks before ADMIN.
  return KIND_RANK[kind] < KIND_RANK[cursor.kind] ? { occurredAt: { lte: cursor.t } } : { occurredAt: { lt: cursor.t } };
}

export async function listSecurityJournal(auth: { organizationId: string; tenantId: string; subjectId: string },
  query: JournalQuery = {}): Promise<JournalPage> {
  const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 50)));
  const cursor = decodeCursor(query.cursor);
  const kind = query.kind ?? "all";
  const scope = { organizationId: auth.organizationId, tenantId: auth.tenantId };
  return withTenantDb(scope, async tx => {
    await tx.canonicalAdminAuditEvent.create({ data: { ...scope, actorSubjectId: auth.subjectId, operation: "AUDIT.READ", result: "SUCCESS",
      changeId: `read:security-journal:${randomUUID()}`, metadata: { journal: "security", includeReads: query.includeReads === true, kind } } });
    const admin = kind === "sign-in" ? [] : await tx.canonicalAdminAuditEvent.findMany({
      where: { ...scope, ...after("ADMIN", cursor), ...(query.includeReads ? {} : { NOT: { operation: { endsWith: ".READ" } } }) } as Prisma.CanonicalAdminAuditEventWhereInput,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, operation: true, result: true, occurredAt: true, actor: { select: { name: true } }, target: { select: { name: true } } } });
    const signIns = kind === "admin" ? [] : await tx.authenticationEvidence.findMany({
      where: { ...scope, ...after("SIGN_IN", cursor) } as Prisma.AuthenticationEvidenceWhereInput,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, method: true, outcome: true, occurredAt: true, phishingResistant: true, reasonCode: true,
        subject: { select: { name: true } }, providerConnection: { select: { providerType: true } } } });
    const merged: JournalEntry[] = [
      ...admin.map(e => ({ id: e.id, kind: "ADMIN" as const, occurredAt: e.occurredAt.toISOString(), action: e.operation, result: e.result,
        actorName: e.actor?.name ?? null, targetName: e.target?.name ?? null })),
      ...signIns.map(e => ({ id: e.id, kind: "SIGN_IN" as const, occurredAt: e.occurredAt.toISOString(), action: "SIGN_IN",
        result: e.outcome === "VERIFIED" ? "SUCCESS" as const : "DENIED" as const, actorName: e.subject?.name ?? null, targetName: null,
        method: e.method, providerType: e.providerConnection?.providerType ?? null,
        assurance: e.method === "FEDERATED_OIDC" ? "PROVIDER_ATTESTED" as const : e.phishingResistant ? "PHISHING_RESISTANT" as const : "STANDARD" as const,
        ...(e.outcome === "REJECTED" ? { reasonCode: e.reasonCode } : {}) })),
    ].sort(compareEntries);
    const entries = merged.slice(0, limit);
    return { entries, nextCursor: merged.length > limit ? encodeCursor(entries[entries.length - 1]) : null };
  });
}
