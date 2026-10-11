# LUXIA Identity — First Admin and Break-glass v1: scope proposal

Status: **PROPOSAL, awaiting operator validation.** No code, migration or Production change is part of this document.
Baseline: `main` @ `627ca57`, Production `dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ` @ `5e8c887`.

## 1. Why now (evidence from Production)

The Customer Self-Onboarding v1 certification (2026-10-11) proved an operational gap. To neutralize the certification organization, the last account had to be disabled by a **provisional operator action outside the product**: one owner SQL transaction, with a `SERVICE` identity created on the spot to author the journal events. The product correctly forbids self-disabling, but it offers no supported way to:
- recover an organization whose administrator lost their only passkey;
- stop an organization safely;
- let LUXIA act in an emergency without receiving authority over the customer's data.

## 2. Observed state

| Topic | Today | Evidence |
|---|---|---|
| First administrator | Created only by the beta-code signup (founder) or by operator scripts (Legrand Tech) | `lib/onboarding/signup.ts`, `scripts/canonical-admin-v1-production.ts` |
| Self-protection | Refused: disabling one's own account, downgrading one's own lifecycle, revoking one's own access | `lib/admin/canonical-administration.ts` (`SELF_*_FORBIDDEN`) |
| **Last administrator** | **Not protected.** Another admin can disable or strip the last *other* admin. Nothing counts the remaining administrators. | no check exists |
| Lost passkey, Microsoft user | Can re-enrol a passkey from a Microsoft session (`LOCAL_IDENTITY.RECOVERY_UNLOCK`) | `app/api/auth/local/enrollment/begin/route.ts` |
| **Lost passkey, passkey-only organization** | **No path.** Recovery codes exist in the local adapter (hashed, single use), but no screen or API issues or accepts them. | `LocalRecoveryCode`, `issueRecoveryCodes` (adapter only) |
| **Stopping an organization** | **No organization status.** The only option is disabling every account, and the last one is impossible in the product. | `Organization` has no status |
| Operator emergency action | None in the product. The Lab needed raw SQL. | certification report, section "Neutralization" |
| Sovereign restore ceremony | Library and tables exist (multi-authority approvals, recovery epoch); not exposed | `lib/identity/sovereign-recovery.ts` |

## 3. Proposed scope

| # | Feature | What it does | Security notes |
|---|---|---|---|
| B1 | **Last-administrator guard** (blocker) | Any operation that would leave an organization with **no active administrator** is refused (`LAST_ADMINISTRATOR_PROTECTED`). This covers disabling an account, changing a lifecycle and revoking the admin bundle. | "Administrator" means an active human subject with an active `assignments.manage` grant. The check runs in the same transaction as the change, under an advisory lock, so two concurrent changes cannot both pass. Refusals are audited. |
| B2 | **Personal recovery codes** for passkey users | 10 single-use codes, shown **once** and stored hashed (the existing `LocalRecoveryCode`). A code lets its owner sign in **only to enrol a new passkey**, with no other access in that session. All existing codes are invalidated when new ones are issued. The founder is invited to create them right after signup. | A recovery sign-in gives a short session with one capability, enrolling a passkey, and is recorded as such in the Security Journal (assurance LOW, not phishing-resistant). Codes are never shown again. Rate limited. |
| B3 | **Organization status** | `ACTIVE`, `SUSPENDED` or `CLOSED`. In SUSPENDED or CLOSED, every sign-in is refused with the same generic answer, and existing sessions are revoked when the status changes. Data and history are kept. Only the LUXIA operator procedure (B4) changes the status in v1. | Enforced on the server at sign-in and at session resolution, with no client trust. The anti-enumeration rules are unchanged: a suspended organization answers like an unknown one. |
| B4 | **Operator break-glass procedure** (replaces raw SQL) | An operator command restricted to a closed list of actions on one organization: suspend or reactivate, revoke all sessions, disable a named account, release a domain (only if its TXT is gone), and issue a **single-use administrator recovery invitation** for a person the customer designates. Each run requires a reference (ticket or written customer request) and a reason. A dry run is the default. | LUXIA **never** receives authority in the tenant: no grant to the operator, no session, no read of business data beyond counts. Each action writes a journal event authored by a dedicated non-human `SERVICE` identity, "Opérateur LUXIA", with reference, reason and before/after counts, in the same transaction as the change. A recovery invitation uses the existing invitation rules (hash, 7 days, single use), and the role it carries is fixed by the command. |
| B5 | **Visibility for the customer** | The overview "Mise en route" shows "second administrator" and "recovery codes created" as facts. The journal labels operator actions in French ("Action opérateur LUXIA : …"). | Facts only, no score. The checklist is shown to administrators only, which is one of the planned follow-ups. |

### Out of scope (v1)

| Item | Reason |
|---|---|
| Customer self-service organization deletion | Legal and retention rules first (Billing/Legal phase) |
| Recovery by email or SMS | No messaging infrastructure; weaker than passkeys |
| Sovereign multi-authority restore in the interface | Belongs to the Backup/Restore phase |
| Dual operator approval (two LUXIA people) | Private beta has one operator; the procedure is designed so a second approval can be added later |
| Automatic "emergency admin" account with sealed credentials | A standing account with dormant authority contradicts "no implicit authority" |

## 4. Data model changes (approval requested)

| Change | Why | RLS |
|---|---|---|
| `Organization.status` (`ACTIVE` / `SUSPENDED` / `CLOSED`, default `ACTIVE`), `statusChangedAt` | B3 | `Organization` has no RLS today. The column is read at sign-in and session resolution, and is written only by the operator procedure (owner role). |
| No new table for B2 | `LocalRecoveryCode` already exists (hashed, single use, tenant scoped, forced RLS) | unchanged |
| A "recovery-only" mark on a session (`Session.scope`, default `FULL`) | B2: a recovery session can only enrol a passkey | `Session` already has forced RLS |
| Operator `SERVICE` identity | B4: one per organization, created on first use, disabled, without account, key or right | existing `Subject` rules |

## 5. Security invariants kept

- Default deny, forced RLS, no implicit authority. The operator gets no grant and no session.
- Every state change is audited in the organization's own journal, in the same transaction.
- One-time secrets (recovery codes, invitation links) are shown once and stored hashed.
- Anti-enumeration is unchanged: a suspended or closed organization looks like an unknown one.
- No Production change without review, CI on the exact SHA and the operator's explicit approval.

## 6. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| K1 | Last-administrator guard: refuse, or only warn? | **Refuse.** An organization without an administrator is the incident this phase exists to prevent. |
| K2 | Recovery codes: count, and when to offer them | **10 codes**, proposed right after signup and from "Mes clés d'accès"; regenerating invalidates the old ones |
| K3 | Who can run the operator procedure, and with what proof | **The LUXIA operator only**, with a mandatory reference (ticket or written customer request) and a reason. Dry run by default. Second approval later. |
| K4 | Recovery invitation: may LUXIA issue an ADMIN invitation for a customer that lost all administrators? | **Yes, only for a person named in the customer's written request.** Single use, 7 days, audited. LUXIA never sees the link's use. |
| K5 | Approve the migration in section 4 | **Yes**, with tests and a rollback/forward-fix note |

## 7. Order

1. B1, last-administrator guard (no migration)
2. Migration: `Organization.status`, `Session.scope`
3. B3, organization status enforced at sign-in and session resolution
4. B2, recovery codes and recovery-only session
5. B4, operator procedure, then **re-run the Lab neutralization through it** on the clone to prove that raw SQL is no longer needed
6. B5, visibility and labels
7. PostgreSQL, RLS and adversarial tests, then Production certification

## 8. Acceptance criteria

1. No operation, alone or concurrent, can leave an organization without an active administrator.
2. A passkey-only administrator who lost their passkey regains access with one recovery code, and that code cannot be used for anything else or twice.
3. A suspended organization cannot sign in, and is indistinguishable from an unknown one before authentication.
4. Every operator action is limited to the closed list, requires a reference, is audited in the organization's journal by "Opérateur LUXIA", and gives LUXIA no access.
5. The certification-lab neutralization can be replayed through the procedure, with the same before/after result and no raw SQL.
6. CI PASS on exact SHAs. Production certification with an independent read-only database cross-check.
