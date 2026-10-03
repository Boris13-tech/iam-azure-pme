import { afterEach, describe, expect, it, vi } from "vitest";
import { withTenantDb } from "../../lib/db/scoped-client";
import {
  CanonicalAdminError,
  createSubject,
  disableIdentityAccount,
  recordDeniedAdminAccess,
  updateSubject,
} from "../../lib/admin/canonical-administration";
import { SessionCreationDeniedError, SessionStore } from "../../lib/auth/session-store";
import { ENTITLEMENT_CATALOG_V1, LEGACY_ADMIN_ENTITLEMENT_KEYS_V1 } from "../../lib/auth/entitlements-catalog";
import { LUXIA_ORG_ADMIN_V1 } from "../../lib/auth/native-role-catalog";

vi.mock("../../lib/db/scoped-client", () => ({ withTenantDb: vi.fn() }));

const auth = { organizationId: "org-a", tenantId: "tenant-a", subjectId: "actor-a" };

describe("Canonical Administration v1", () => {
  afterEach(() => vi.clearAllMocks());

  it("defines the native role as an exact provider-neutral bundle", () => {
    expect(LUXIA_ORG_ADMIN_V1).toEqual({
      key: "LUXIA_ORG_ADMIN",
      version: 1,
      sourceRef: "native-role:LUXIA_ORG_ADMIN:v1",
      entitlements: [
        "subjects.read", "subjects.create", "subjects.update",
        "identity_accounts.read", "identity_accounts.link", "identity_accounts.disable",
        "assignments.read", "assignments.manage",
        "sessions.read", "sessions.revoke",
        "providers.read", "providers.manage",
        "resources.read", "resources.manage",
        "audit.read",
      ],
    });
    for (const key of LUXIA_ORG_ADMIN_V1.entitlements) {
      expect(ENTITLEMENT_CATALOG_V1).toContain(key);
    }
  });

  it("does not expand the legacy administrator mapping", () => {
    expect(LEGACY_ADMIN_ENTITLEMENT_KEYS_V1).not.toContain("subjects.read");
    expect(LEGACY_ADMIN_ENTITLEMENT_KEYS_V1).not.toContain("assignments.manage");
    expect(LEGACY_ADMIN_ENTITLEMENT_KEYS_V1).not.toContain("providers.manage");
  });

  it("creates a subject and its canonical audit event in the same tenant transaction", async () => {
    const auditFind = vi.fn().mockResolvedValue(null);
    const subjectCreate = vi.fn().mockResolvedValue({ id: "subject-new", type: "HUMAN" });
    const auditCreate = vi.fn().mockResolvedValue({ id: "event-1" });
    vi.mocked(withTenantDb).mockImplementationOnce(async (scope, work) => {
      expect(scope).toEqual(auth);
      return work({
        canonicalAdminAuditEvent: { findUnique: auditFind, create: auditCreate },
        subject: { create: subjectCreate },
      } as never);
    });

    await createSubject(auth, { name: "Alice", type: "HUMAN" }, "change-subject-1");

    expect(subjectCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: "org-a", tenantId: "tenant-a", name: "Alice", type: "HUMAN",
    }) });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: "org-a",
      tenantId: "tenant-a",
      actorSubjectId: "actor-a",
      targetSubjectId: "subject-new",
      operation: "SUBJECT.CREATE",
      changeId: "change-subject-1",
      result: "SUCCESS",
    }) });
  });

  it("creates a joiner in PROVISIONING without activating it implicitly", async () => {
    const subjectCreate = vi.fn().mockResolvedValue({
      id: "subject-joiner", type: "HUMAN", lifecycleState: "PROVISIONING",
    });
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-joiner" }),
      },
      subject: { create: subjectCreate },
    } as never));

    await createSubject(auth, {
      name: "New Joiner", type: "HUMAN", lifecycleState: "PROVISIONING",
    }, "change-joiner");

    expect(subjectCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      organizationId: "org-a",
      tenantId: "tenant-a",
      lifecycleState: "PROVISIONING",
    }) });
  });

  it("suspends a subject and revokes active sessions within the same tenant", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue({ count: 2 });
    const assignmentUpdate = vi.fn();
    const auditCreate = vi.fn().mockResolvedValue({ id: "event-suspend" });
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: {
        findUnique: vi.fn().mockResolvedValue(null), create: auditCreate,
      },
      subject: {
        findFirst: vi.fn().mockResolvedValue({ id: "subject-1", lifecycleState: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({ id: "subject-1", lifecycleState: "SUSPENDED" }),
      },
      session: { updateMany: sessionUpdate },
      assignment: { updateMany: assignmentUpdate },
    } as never));

    await updateSubject(auth, "subject-1", { lifecycleState: "SUSPENDED" }, "change-suspend");

    expect(sessionUpdate).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a", tenantId: "tenant-a", subjectId: "subject-1", revokedAt: null,
      },
      data: { revokedAt: expect.any(Date) },
    });
    expect(assignmentUpdate).not.toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      operation: "SUBJECT.UPDATE",
      metadata: expect.objectContaining({
        lifecycleFrom: "ACTIVE", lifecycleTo: "SUSPENDED", revokedSessions: 2,
      }),
    }) });
  });

  it("retires a subject, revokes sessions and assignments, and rejects reactivation", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const assignmentUpdate = vi.fn().mockResolvedValue({ count: 3 });
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "event-retire" }),
      },
      subject: {
        findFirst: vi.fn().mockResolvedValue({ id: "subject-1", lifecycleState: "ACTIVE" }),
        update: vi.fn().mockResolvedValue({ id: "subject-1", lifecycleState: "RETIRED" }),
      },
      session: { updateMany: sessionUpdate },
      assignment: { updateMany: assignmentUpdate },
    } as never));

    await updateSubject(auth, "subject-1", { lifecycleState: "RETIRED" }, "change-retire");

    expect(assignmentUpdate).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a", tenantId: "tenant-a", subjectId: "subject-1", status: "ACTIVE",
      },
      data: { status: "REVOKED", validUntil: expect.any(Date) },
    });

    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: { findUnique: vi.fn().mockResolvedValue(null) },
      subject: {
        findFirst: vi.fn().mockResolvedValue({ id: "subject-1", lifecycleState: "RETIRED" }),
        update: vi.fn(),
      },
    } as never));
    await expect(updateSubject(auth, "subject-1", { lifecycleState: "ACTIVE" }, "change-reactivate"))
      .rejects.toMatchObject({ code: "INVALID_SUBJECT_LIFECYCLE_TRANSITION:RETIRED:ACTIVE", httpStatus: 409 });
  });

  it("fails closed when a target is outside the scoped tenant", async () => {
    const update = vi.fn();
    const auditCreate = vi.fn();
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: { findUnique: vi.fn().mockResolvedValue(null), create: auditCreate },
      subject: { findFirst: vi.fn().mockResolvedValue(null), update },
    } as never));

    await expect(updateSubject(auth, "subject-in-other-tenant", { name: "No" }, "change-x"))
      .rejects.toMatchObject({ code: "SUBJECT_NOT_FOUND", httpStatus: 404 });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("disables an identity account, revokes its sessions, and records evidence atomically", async () => {
    const accountUpdate = vi.fn().mockResolvedValue({ id: "ia-1", subjectId: "subject-1" });
    const sessionUpdate = vi.fn().mockResolvedValue({ count: 2 });
    const auditCreate = vi.fn().mockResolvedValue({ id: "event-1" });
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: { findUnique: vi.fn().mockResolvedValue(null), create: auditCreate },
      identityAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: "ia-1", status: "ACTIVE" }),
        update: accountUpdate,
      },
      session: { updateMany: sessionUpdate },
    } as never));

    await disableIdentityAccount(auth, "ia-1", "disable-ia-1");

    expect(accountUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "DISABLED" }),
    }));
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { identityAccountId: "ia-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      operation: "IDENTITY_ACCOUNT.DISABLE",
      targetSubjectId: "subject-1",
      metadata: { identityAccountId: "ia-1", sessionsRevoked: 2 },
    }) });
  });

  it("rejects secret-like audit metadata before touching the database", async () => {
    const { createResource } = await import("../../lib/admin/canonical-administration");
    await expect(createResource(auth, {
      name: "unsafe",
      type: "APPLICATION",
      metadata: { clientSecret: "must-not-be-recorded" },
    }, "change-unsafe")).rejects.toBeInstanceOf(CanonicalAdminError);
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("records denied canonical administration attempts without legacy audit", async () => {
    const auditCreate = vi.fn().mockResolvedValue({ id: "event-denied" });
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      canonicalAdminAuditEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: auditCreate,
      },
    } as never));

    await recordDeniedAdminAccess(auth, "providers", "manage");

    expect(auditCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      operation: "AUTHORIZATION.DENIED",
      result: "DENIED",
      metadata: { resource: "providers", action: "manage" },
    }) });
  });

  it("cannot create a session for a disabled identity account", async () => {
    const sessionCreate = vi.fn();
    vi.mocked(withTenantDb).mockImplementationOnce(async (_scope, work) => work({
      identityAccount: {
        findFirst: vi.fn().mockResolvedValue({
          id: "identity-1",
          status: "DISABLED",
          subject: { lifecycleState: "ACTIVE" },
        }),
      },
      session: { create: sessionCreate },
    } as never));

    await expect(SessionStore.createSession({
      organizationId: auth.organizationId,
      tenantId: auth.tenantId,
      subjectId: "subject-1",
      identityAccountId: "identity-1",
    })).rejects.toBeInstanceOf(SessionCreationDeniedError);
    expect(sessionCreate).not.toHaveBeenCalled();
  });
});
