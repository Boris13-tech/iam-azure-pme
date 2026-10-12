# First Admin / Break-glass v1: implementation notes

Scope and decisions: `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md` (K1 to K5 approved). This file records how each part is built, one section per part.

## B1, last-administrator guard (no migration)

**Invariant (administrative continuity).** A change is refused with `LAST_ADMINISTRATOR_PROTECTED` (409) when it would take the tenant from at least one **durable administrator** to none. A tenant that already has none is not blocked: unrelated work continues, and it can be repaired, for example by granting `assignments.manage` to someone. Once repaired, the tenant is protected again.

**Durable administrator** (`lib/admin/last-administrator.ts`, `durableAdministratorWhere`). This is narrower than "has administrator rights". A person counts only if all of these are true:
- they are a `HUMAN` subject in the `ACTIVE` lifecycle;
- they have at least one `ACTIVE` identity account **of their own**. The relation joins on (organization, tenant, subject), so another tenant's or another person's account never counts;
- they hold an `assignments.manage` grant that is native (not `LEGACY_ROLE`, as in `requireNative`), already effective (`validFrom` empty or past), and **without an end date** (`validUntil` empty).

A temporary administrator is functionally an administrator, but cannot satisfy this invariant: their grant removes itself when it expires, with no action anyone could refuse. Future-dated and expired grants do not count either.

The overview item "second administrator" uses the same definition. Its label reads « Avoir un second administrateur permanent, qui peut se connecter ».

**Mechanism.** All of it runs in the transaction of the change.
1. **One tenant lock**, `pg_advisory_xact_lock(hashtextextended('resource-governance:<organization>:<tenant>', 0))`. The SoD trigger already takes this lock on every Assignment write, and every governance writer takes it first. The guard reuses it instead of adding a second lock: two locks taken in different orders (one directly, one through the trigger) could deadlock.
2. **The lock comes before any row lock**, in every transaction that can write grants:
   - the canonical operations, including `grantAssignment`;
   - `operation()`, the access reviews and the bundles;
   - ADMIN invitation acceptance, which locked the invitation and person rows before the trigger lock;
   - the legacy dual write.

   Before this rule, invitation revocation could deadlock with an acceptance, independently of B1.
3. The guard counts, sets a savepoint, applies the change, then counts again. Under READ COMMITTED, counts read after the lock include every change committed by an earlier holder. Two concurrent removals therefore cannot both pass.
4. On refusal, the guard rolls back to the savepoint. The DENIED event is then committed in the same transaction (`<OPERATION>.DENIED`, `reasonCode: LAST_ADMINISTRATOR_PROTECTED`, actor and target), and nothing of the change remains.

**Paths.**

| Path | Can it remove a durable administrator? | Guard |
|---|---|---|
| Disable an identity account | Yes | Lock, then guard, then audited refusal |
| Update a subject (any lifecycle away from ACTIVE; DISABLED and RETIRED also revoke every grant) | Yes | Lock, then guard, then audited refusal |
| Revoke a catalog grant | Yes | Lock, then guard, then audited refusal |
| Revoke or update a resource grant, revoke a resource entitlement | No: resource-scoped only | Guard as defense in depth; the refusal is audited by `operation()` |
| Access review REVOKE decision | No: review items hold resource grants only | Guard as defense in depth; refusal audited |
| Roll back the v2 governance bundle | No: the bundle does not contain `assignments.manage` | Guard as defense in depth |
| Legacy dual write | No: it revokes `LEGACY_ROLE` grants only | Reviewed; takes the lock first |
| Invitation acceptance | No: it only activates | Reviewed; takes the lock first |

**Architecture test** (`tests/security/last-administrator-architecture.test.ts`). It parses the source and checks that every writer of subjects, identity accounts, grants or entitlements in `lib/` and `app/` sits **inside the arguments of a guard call**. A change prepared outside the guard and passed to it does not count.

The two reviewed writers are checked one by one against the content that makes them harmless (`source: "LEGACY_ROLE"`, activation to `ACTIVE`). They are not just counted.

The test also forbids:
- raw `UPDATE`/`DELETE` on these tables;
- nested `updateMany`/`deleteMany` writes.

It checks the lock key against the SoD trigger and the lock order. A self-test proves that the scanner flags a real unguarded writer.

**Out of B1 scope:**
- A lost passkey or a locked local identity does not change the count. B2 (recovery codes) handles that case.
- Operator scripts under `scripts/` act outside the product. B4 replaces them with closed actions.

**Tests** (`tests/resources/last-administrator-postgres.test.ts`, PostgreSQL as `app_user`):
- direct removals of the only durable administrator are refused, audited, and leave the subject, account, sessions and grants unchanged;
- one of two can go, never the last;
- the counting rules: temporary, future, expired, legacy, no account, service;
- the account belongs to the same subject and tenant (foreign key refused, other tenant counts zero);
- a tenant at zero is not frozen and can be repaired, then is protected;
- concurrency, with every operation queued on the lock in `pg_locks` before release:
  - four pair scenarios and one three-way scenario;
  - two mixed scenarios run in two orders: administrator removals with a resource revoke and an account disable; ADMIN acceptance with invitation revoke, suspension and resource revoke.

  The mixed scenarios allow only the expected business refusals. A deadlock or any other error fails the test;
- resource governance and the bundle cannot reach `assignments.manage`;
- the savepoint rollback keeps the rest of the transaction.

## B3, organization lifecycle enforcement

Scope approved by the operator on 2026-10-11. It builds on the migration `20261011180000_organization_status_session_scope` (design: `FIRST-ADMIN-BREAK-GLASS-V1-MIGRATION-DESIGN.md`).

**Before authentication, SUSPENDED and CLOSED look exactly like an unknown organization.**
- `resolveLoginOrganization` returns `null` unless the organization is ACTIVE. Every caller already answers `null` generically:
  - passkey begin: same anonymous answer, same timing floor;
  - passkey completion: `LOCAL_AUTHENTICATION_FAILED` (401);
  - Microsoft sign-in: `/login?error=signin`.
- If the organization stops being ACTIVE during the Microsoft round trip, the callback returns the same generic `/login?error=signin`, with no session. The refusal is still recorded for the known identity.
- An invitation of a non-ACTIVE organization resolves like an unknown token (`INVITATION_INVALID`).

**Session resolution goes through the canonical resolver only.**
- Migration `20261011200000_session_resolve_subject_account` extends `luxia_session_resolve`, with the same signature, so grants are kept. It now also refuses a session whose subject is not ACTIVE, or whose identity account is not ACTIVE. `resolve_session` wraps it and inherits the rule. Rollback: `docs/operations/B3-SESSION-RESOLVE-ROLLBACK.sql`, always lossless.
- `getSession` reads `luxia_session_resolve` and accepts FULL sessions only. A RECOVERY session is read only through the B2 allow-list (section B2 below).

**Conditional writes.** These no longer fail on a concurrent revocation: a session revoked in the meantime is frozen, and the write becomes a no-op or a clean 404.
- the `lastSeenAt` refresh;
- sign-out, which also records `SESSION.SIGN_OUT` once;
- administrator session revocation.

**Lock order** (B1 rule, extended):
1. the tenant governance lock, when the transaction takes one;
2. the organization row (`lockOrganizationActive`, `FOR SHARE`);
3. the first write.

This applies to every transaction that creates a session, an invitation or a domain, or starts, accepts or verifies one. `tests/security/organization-lifecycle-architecture.test.ts` enforces the order per function, and fails on any new writer of that kind. Authenticated writes refuse with an audited denial (`ORGANIZATION_NOT_ACTIVE`).

**Transition primitive** (`lib/organizations/lifecycle.ts`, `transitionOrganization`). It is operator-only: the database refuses any other role, and nothing in `lib/` or `app/` calls it. B4 will wrap it. In one transaction, it:
1. takes the governance locks of every tenant;
2. changes the status;
3. applies the effects. Suspension revokes every active session at once; closing also revokes the open invitations and releases the domains. Reactivation revokes nothing and brings nothing back, because revoked sessions are frozen;
4. runs `SET CONSTRAINTS ALL IMMEDIATE`.

`readOrganizationLifecycle` re-reads the committed state (finding P1). CLOSED is final.

**Tests:**
- `tests/resources/organization-lifecycle-postgres.test.ts`, on PostgreSQL through the real routes;
- the suspended-organization case in `tests/security/oidc-callback.test.ts`;
- `tests/security/organization-lifecycle-architecture.test.ts`;
- a unit test of the session refusal.

## B2, recovery codes and the recovery-only session

Design approved by the operator on 2026-10-11 (R1 to R6): `FIRST-ADMIN-BREAK-GLASS-V1-B2-RECOVERY-DESIGN.md`. Self-service only: no operator action, no permission, no grant (B4 is separate).

**Migration** `20261012090000_recovery_codes_b2` (expand only). Rollback: `docs/operations/B2-RECOVERY-CODES-ROLLBACK.sql`.
- `LocalRecoveryCode` gets `batchId` and `revokedAt`, a CHECK that new hashes are SHA-256 hex, and an index of usable codes.
- Backfill: every row written before B2 becomes its own batch, and an unused one is revoked (Production had 0 rows).
- The guard `luxia_recovery_code_guard` (trigger, owner-only):
  - creation: ACTIVE organization, unused and unrevoked, at most 10 usable codes per account, counted under the account's local identity row lock;
  - afterwards only `usedAt` or `revokedAt` changes, from NULL to a timestamp, once, one of them; consumption needs an ACTIVE organization;
  - a used or revoked code is frozen, and no row is ever deleted.
- The rollback drops the guard and the CHECK first. It then marks every revoked unused code as used, so that none can become usable again, closes open RECOVERY sessions, and drops the rest.

**Codes** (`lib/auth/recovery.ts`).
- 20 Crockford base32 characters (100 bits), shown as `XXXXX-XXXXX-XXXXX-XXXXX`, returned once by the generation answer.
- Stored only as `SHA-256("luxia-recovery-code:v1:" + identityAccountId + ":" + code)`, in hex.
- Input is normalized: case, spaces and hyphens, `O` read as `0`, `I` and `L` read as `1`.
- No expiry (R1).
- The older adapter helpers are closed: the Prisma store stores and accepts no code.

**Generation and revocation** (`/api/me/recovery-codes`, `/api/me/recovery-codes/revoke`). FULL session only, with the `x-luxia-change-id` header.
- Generation needs the session's own LUXIA local account and a passkey sign-in less than 15 minutes old (R2): the session and its VERIFIED passkey evidence.
- One transaction: organization lock, then the person's local identity row lock; unused earlier codes revoked; 10 hashes stored; `RECOVERY_CODES.GENERATE` in the journal.
- 5 batches per day per person.
- "Revoke all" revokes every unused code, with `RECOVERY_CODES.REVOKE`.
- The status answer gives only the number of codes left, the batch date, and whether a recovery used the current batch (R5 notice).

**Recovery sign-in** (`POST /api/auth/local/recovery`).
- Every refusal is the same 401 `LOCAL_AUTHENTICATION_FAILED`, after a 400 ms minimum duration.
- Limits: 10 per hour per client, 5 per hour per (organization, identifier). There is no lockout (R3); a lock that has expired no longer refuses.
- Success, in one transaction, in this order:
  1. organization lock;
  2. check of the person, account and local identity;
  3. conditional consumption of the code;
  4. VERIFIED evidence (`CUSTOM`, `LOCAL_RECOVERY_CODE_VERIFIED`, LOW);
  5. a RECOVERY session of exactly 15 minutes;
  6. `RECOVERY.SIGN_IN`.
- A known person who is refused gets a REJECTED evidence with the precise reason.

**The recovery-only session.**
- `getAuthContext` / `requireAuth` never return it, so every page and API refuses it (401 or redirect), even for an administrator.
- `getRecoveryContext` returns a branded `RecoveryContext`, which has no `AuthContext` shape, so tsc refuses it in any permission check.
- Its callers are allow-listed:
  - enrolment begin and complete (`/api/auth/recovery/enrollment/*`);
  - the `/recovery` page.
- Sign-out revokes any scope. Nothing refreshes or extends the session.

**Enrolment ends the recovery** (R4). In one transaction:
1. organization lock;
2. the recovery session is revoked, once, so a second completion is refused;
3. the single-use challenge (purpose RECOVERY, accepted by no other flow) is consumed;
4. the previous passkeys and security keys of the account are revoked. TOTP is not touched: it is not used as a sign-in authenticator in the product (the only local sign-in route accepts passkeys, and no route enrols or verifies a TOTP; operator decision, 2026-10-12);
5. the new passkey is created;
6. every other session of the account ends;
7. `RECOVERY.PASSKEY_ENROLLED` and `LOCAL_AUTHENTICATOR.ENROLL` are written.

The cookie is cleared, and the person signs in with the new passkey. The remaining codes stay valid (R5). A notice that cannot be dismissed asks for a new batch, on the overview and on the Authentication page.

**Tests:**
- `tests/resources/recovery-postgres.test.ts`, PostgreSQL through the real routes:
  - generation, sign-in, refusals and limits;
  - the session refused by 14 routes;
  - enrolment;
  - the database guard;
  - the section 7 races, with real lock waits;
- `tests/security/recovery-architecture.test.ts`: allow-list, type separation, lock order, no permission or B4 logic, rollback order;
- `tests/security/recovery-codes.test.ts`;
- the B3 lock-order map and the function privilege gate, extended.

## B4, the operator break-glass procedure

Design approved on 2026-10-12 (D1 to D7, Q1): `FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md`. Runbook: `docs/operations/B4-BREAK-GLASS-RUNBOOK.md`.

**Code.**
- `lib/operators/break-glass.ts` holds the closed list, the authority matrix, the plan and the apply logic.
- `scripts/operators/break-glass.ts` is the operator command. It runs as the owner, on the direct endpoint, with a BYPASSRLS role.
- No route, page or other library reaches the module (architecture test).

**Inputs.**
- `validateInput` accepts only the known fields. It checks the action against the reference type (D7, Q1):
  - `LUXIA_CERTIFICATION`: only on the fixed list of certification organizations;
  - `VERIFIED_CUSTOMER_REQUEST`: only the actions listed in `requestedActions`;
  - `legrand-tech`: only its own verified request.
- A verified request needs two distinct methods and the SHA-256 of the document (D1).
- Each action takes exactly its own target.

**Plan.**
- `computePlan` reads:
  - the organization and its status;
  - the counts, including the durable administrators and those who can still sign in;
  - the target;
  - the operator subject;
  - any earlier status change that was not journaled (a status change with no later `BREAK_GLASS.ORGANIZATION.*` event; the event time is the database transaction time, the same as `statusChangedAt`);
  - for `RELEASE_DOMAIN`, the DNS answer of two public resolvers.
- It refuses what the rules refuse:
  - status preconditions;
  - D2 (last administrator outside SUSPENDED);
  - D3 (an administrator who can still sign in);
  - a TXT record still present.
- The plan is canonical JSON. Its SHA-256 is the digest, and it expires after 15 minutes (D5).

**Apply.** One owner transaction, in this order:
1. governance locks of every tenant, then the organization row lock (`FOR UPDATE`);
2. the plan recomputed from the same inputs, refused unless the digest matches (invariant: no widening of authority);
3. the disabled `SERVICE` operator subject, created on first use;
4. the action:
   - status changes go through the B3 `transitionOrganization`;
   - `DISABLE_ACCOUNT` goes through `preserveLastAdministratorUnlessSuspended`, which is the B1 guard except in an organization already SUSPENDED (D2);
5. the `BREAK_GLASS.*` journal event, with `changeId = break-glass:<digest>`; the unique index refuses a replay (D6);
6. `SET CONSTRAINTS ALL IMMEDIATE`;
7. a committed re-read compared with the expected result (P1).

**Recovery invitation (D3).** Migration `20261012180000_break_glass_operator_invitation`, expand only. Rollback: `docs/operations/B4-BREAK-GLASS-ROLLBACK.sql`.
- `Invitation.issuedByOperatorChangeId`, the break-glass event, set for an ADMIN invitation only.
- The invitation guard:
  - only a BYPASSRLS role can set the column;
  - the database fixes the lifetime at 24 hours;
  - the column is immutable;
  - acceptance requires the break-glass event that names this invitation.
- The state CHECK allows 24 hours for operator invitations, and 7 days otherwise.
- Acceptance grants the administrator bundle on the event's authority alone; the operator holds nothing. The token is printed once and stored nowhere.

**Tests:**
- `tests/resources/break-glass-postgres.test.ts`: every action, refusals, replay, D2, D3 with a real acceptance, the race, and the Lab sequence;
- `tests/security/break-glass.test.ts`: matrix, inputs, digest;
- `tests/security/break-glass-architecture.test.ts`;
- the B1 and B3 architecture maps, extended;
- the PGlite drill of the migration and its rollback.
