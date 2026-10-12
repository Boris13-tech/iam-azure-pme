# First Admin / Break-glass v1: migration design for `Organization.status` and `Session.scope`

Status:
- **Design. M1 to M6 approved by the operator on 2026-10-11, with five binding additions (A1 to A5, section 10)**, which are integrated below.
- Until the operator approves the merge of this design, there is no code, no migration and no deployment.

Binding inputs:
- `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md`: 9.1 statuses, 9.2 closed actions, 9.4 recovery-only session, 9.5 Lab replay, requirement 3 (indistinguishable before authentication);
- B1 lock-order rule (`docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1.md`).

This migration only **adds the state and the database guarantees**. The application behavior is built afterwards, each part separately approved:
- B3: sign-in, session resolution and invitations;
- B2: recovery codes and the recovery-only session;
- B4: the operator procedure that changes the status.

## 1. Principles

1. **Expand only.** The current Production code (`ebb4f46`) keeps working on the migrated database without any change, so the migration can be applied before B3 is deployed. Removing old pieces is left to a later, separate migration.
2. **The database refuses what must never happen, whatever the caller.** The application code (B3, B4) refuses earlier and with the right answer. The database is the backstop, and it fails closed.
3. **Every effect of a transition stays explicit and audited.** The B4 procedure performs it and journals it with before and after counts (M1). The database checks, at commit, that the effects are complete.
4. **One lock order everywhere**, which extends the B1 rule:
   1. the tenant governance lock (advisory, one per tenant, in tenant id order);
   2. the organization row;
   3. every other row.

   A status transition is only possible while the governance lock of **every** tenant of the organization is held, and inside one atomic transaction (A1).
5. **One canonical implementation of session resolution, in the database.** It refuses SUSPENDED and CLOSED organizations for every caller (A2, A5).

## 2. Schema changes

```prisma
enum OrganizationStatus { ACTIVE SUSPENDED CLOSED }
enum SessionScope { FULL RECOVERY }

model Organization {
  // ...
  status          OrganizationStatus @default(ACTIVE)
  statusChangedAt DateTime?          // set by the database trigger, never by the application
}

model Session {
  // ...
  scope SessionScope @default(FULL)
}
```

- No reason or reference column on `Organization`. The reason, the reference and the operator identity belong to the journal event that B4 writes in the same transaction. One source of truth.
- `Tenant` gets no status: in v1 an organization has exactly one tenant, and status is an organization fact. The guards still handle several tenants.

## 3. Defaults and backfill

| Column | DDL | Existing rows |
|---|---|---|
| `Organization.status` | `ADD COLUMN "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE'` | All become ACTIVE: `legrand-tech` and `luxia-certification-lab`. The Lab stays ACTIVE (but neutralized). Closing it is a B4 action with its own approval (scope 9.5). |
| `Organization.statusChangedAt` | `ADD COLUMN ... TIMESTAMP(3)` (nullable) | NULL: never changed |
| `Session.scope` | `ADD COLUMN "scope" "SessionScope" NOT NULL DEFAULT 'FULL'` | All existing sessions become FULL. They stay valid, and nothing is revoked. |

- Both `ADD COLUMN ... DEFAULT` are metadata-only on PostgreSQL 11 and later, so no table is rewritten.
- The migration sets `lock_timeout = '5s'` so that it never queues behind a long transaction. It fails instead, and can be retried.
- It ends with assertions that make the migration fail if they are not met:
  - every organization is ACTIVE;
  - every session is FULL;
  - the count of sessions not revoked is the same before and after;
  - the session guard of 4.3 accepts every existing row as it is.

## 4. Database constraints

### 4.1 Organization status guard (`luxia_organization_status_guard`, BEFORE INSERT OR UPDATE)

- **New organizations are always ACTIVE.** An INSERT with another status is refused, for every role. Signup's SECURITY DEFINER function inserts without a status, so it gets the default.
- **Only the operator role may change the status (M3).** A status change is refused unless the current role has `rolbypassrls`:
  - in Production that is the owner, which B4 uses;
  - in CI it is the migration superuser;
  - `app_user` never has it.
- **Under the tenant governance lock, in one atomic transaction (A1).** A status change is refused (`GOVERNANCE_LOCK_REQUIRED`) unless the current transaction already holds the governance advisory lock of **every** tenant of the organization:
  - the trigger checks `pg_locks`, using the 64-bit key `hashtextextended('resource-governance:<organization>:<tenant>', 0)`, split into `classid` and `objid` with `objsubid = 1`, for the current backend, granted;
  - the trigger **checks** the lock and never takes it. Taking it here, after the row lock, would invert the lock order;
  - transaction-level advisory locks exist only inside a transaction block, so this also forces an explicit transaction: a single autocommit `UPDATE` can never satisfy the check;
  - the status change, its effects (M1) and the deferred completeness check (4.2) commit together or not at all.
- **Allowed transitions only**: ACTIVE→SUSPENDED, ACTIVE→CLOSED, SUSPENDED→ACTIVE, SUSPENDED→CLOSED. Any other change is refused.
- **CLOSED is final (M2).** Any UPDATE of a CLOSED row is refused, including the name. Reopening would need a separately reviewed procedure.
- `statusChangedAt` is set by the trigger, to `now()`, on each real change. A value sent by the caller is ignored.
- The existing slug immutability trigger stays.

### 4.2 Transition completeness (`luxia_organization_status_effects`, CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED)

This trigger runs at commit of any transaction that changed the status. It is SECURITY DEFINER, so it sees every tenant. It refuses the commit when the target state is incomplete:

| New status | Must be true at commit |
|---|---|
| SUSPENDED or CLOSED | No session of the organization with `revokedAt IS NULL` (expired ones included) |
| CLOSED | Also no invitation with `acceptedAt IS NULL AND revokedAt IS NULL`, and no domain in PENDING or VERIFIED |

The B4 procedure therefore has to:
- revoke the sessions;
- for CLOSED, revoke the open invitations, set VERIFIED domains to **LOST** (released) and PENDING domains to **EXPIRED** (M6);
- do all of this in the same transaction.

Otherwise nothing is written. SUSPENDED keeps open invitations (they cannot be accepted, see 4.4) and keeps verified domains (still owned), as 9.1 requires.

**Implementation note, verified on a Neon clone on 2026-10-11, binding for B4.** When this check fails at COMMIT, PostgreSQL refuses the commit and writes nothing. However, Prisma 5.20 does not report a failed COMMIT of an interactive transaction: `$transaction` resolves as if it had succeeded. The B4 procedure therefore:
- ends every transition with `SET CONSTRAINTS ALL IMMEDIATE`, so that a refusal surfaces as a statement error inside the transaction;
- re-reads the organization's status and counts after the commit, and compares them with the confirmed plan.

The database guarantee does not depend on either step.

### 4.3 Sessions are append-only (`luxia_session_guard`, BEFORE INSERT OR UPDATE, M5, A3, A4)

- **INSERT:**
  - the organization must be ACTIVE (`luxia_organization_lock_active`, see 4.6). No sign-in path can create a session for a SUSPENDED or CLOSED organization, even if the application check is missing;
  - `revokedAt` must be NULL;
  - with `scope = RECOVERY`: CHECK `"expiresAt" <= "createdAt" + interval '15 minutes'` (table constraint).
- **UPDATE of an active session** (`OLD.revokedAt IS NULL`):
  - **`revokedAt` may change only from NULL to a timestamp, once (A3).** An UPDATE that sets `revokedAt` may change nothing else;
  - `lastSeenAt` may change only while the session is active;
  - nothing else may change: `scope`, `expiresAt`, `organizationId`, `tenantId`, `subjectId`, `identityAccountId`, `createdAt`, `recoveryEpoch` and the hashes are immutable.
- **UPDATE of a revoked session** (`OLD.revokedAt IS NOT NULL`): **refused entirely (A4).** A revoked session is frozen, `lastSeenAt` included, and can never be un-revoked or re-dated.
- **No rule depends on clocks.** `revokedAt` and `lastSeenAt` come from the application server's clock, and `createdAt` from the database's. A revocation must never be refused because of a clock difference: refusing a revocation is the unsafe direction.
- These are the only writes the code makes today (`lastSeenAt` refresh and revocations, verified in `lib/` and `app/`). Section 3 asserts that every existing row satisfies them.
- **Known edge before B3.** Today the `lastSeenAt` refresh in `getSession` and the sign-out revocation update by id. If such an update races a revocation, it now hits a frozen row and that one request fails with a 500 instead of a 401. It still fails closed: no access is granted. B3 makes both updates conditional (`WHERE "revokedAt" IS NULL`), so a concurrent revocation becomes a no-op.

### 4.4 Invitations (extends `luxia_invitation_guard`)

- INSERT, starting an acceptance (setting `pendingChallengeHash`) and accepting (setting `acceptedAt`) all require an ACTIVE organization.
- Revoking is always allowed, so B4 can close.
- `luxia_invitation_resolve` (pre-authentication, SECURITY DEFINER) gets `AND organization is ACTIVE`. An invitation of a SUSPENDED or CLOSED organization resolves exactly like an unknown token. Its return type is unchanged, so `CREATE OR REPLACE` keeps its grants.

### 4.5 Domains (`luxia_organization_domain_guard`, now also BEFORE INSERT)

- Adding a domain or moving it to VERIFIED requires an ACTIVE organization.
- Moving it to LOST or EXPIRED is always allowed, which is how a domain is released.
- The existing unique index on verified domains is unchanged. After CLOSED, the domain is free for another organization.

### 4.6 Status lock helper (`luxia_organization_lock_active(p_organization_id)`)

- It is SECURITY DEFINER and returns nothing. It runs `SELECT status FROM "Organization" WHERE id = $1 FOR SHARE` and raises `ORGANIZATION_NOT_ACTIVE` if the row is missing or not ACTIVE.
- The guards in 4.3 to 4.5 call it.
- EXECUTE is granted to `app_user`, so that B3 can call it **first** in its transactions, right after the governance lock when it takes one.
- It reveals nothing to the browser. B3 calls it only on the server, after resolving the organization, and maps any refusal to the generic anonymous answer.

## 5. Session resolution: one canonical implementation, blocked in the database (A2, A5)

- **Canonical resolver: `luxia_session_resolve(p_hash)`.** It is SECURITY DEFINER, STABLE, and the only implementation of session resolution. It:
  - takes the SHA-256 hex of the cookie token and refuses any other format;
  - returns at most one row: the existing columns plus `scope`;
  - returns **nothing** unless the session's organization is **ACTIVE**, joined in the same query.

  SUSPENDED and CLOSED are therefore blocked **in the database, for every caller of the resolver, whatever the application code** (A5). B3 extends the same function to also refuse a non-ACTIVE subject and a DISABLED account; there is no second implementation to keep in sync.
- **`resolve_session(p_hash)` becomes a thin wrapper (A2):** `SELECT <existing columns> FROM luxia_session_resolve(p_hash) WHERE scope = 'FULL'`.
  - It is changed with `CREATE OR REPLACE` and the **same signature**. Its EXECUTE grant to `app_user` in Production comes from the activation workflow, not from a migration: recreating the function would drop that grant and break every sign-in.
  - It has no logic of its own: the status rule comes from the canonical resolver.
  - It filters out `RECOVERY`, so code that does not know about recovery sessions can **never** treat one as a full session. That covers today's `ebb4f46` and any application rollback.
  - B2 switches `getSession` to `luxia_session_resolve` and enforces the recovery-only allow-list. The wrapper is dropped in a later contract migration, together with `luxia_login_decoy`.
- **Only path from a cookie to a session.** In the code today, a cookie token becomes a session only through `resolve_session`: `SessionStore.getSession` and `revokeByToken` (verified). Every other session read happens after resolution, inside the resolved tenant. B3 adds an architecture test that forbids any token lookup outside the canonical resolver.
- **Second barrier.** A SUSPENDED or CLOSED organization has no unrevoked session at commit (4.2), and a revoked session is frozen (4.3). Even a direct read of the table finds no usable session.
- **Existing sessions**: none is revoked or changed. All are FULL, and every organization is ACTIVE, so their behavior is identical.

## 6. RLS and privileges

- `Organization` and `Tenant` keep **no RLS**, as today. Pre-authentication resolution of the slug needs them. The status is never sent to the browser before authentication (B3).
- `Session` keeps its forced tenant policy. `scope` falls under the same policy.
- **New or changed functions:**
  - all are owned by the owner, SECURITY DEFINER where they must cross tenants, with `search_path = public, pg_temp` and `REVOKE ALL ... FROM PUBLIC`;
  - trigger functions need no EXECUTE grant;
  - only `luxia_session_resolve` and `luxia_organization_lock_active` are granted to `app_user`, in a `DO` block as in the self-onboarding migration, and in the CI bootstrap;
  - `resolve_session` keeps its existing grant.
- `tests/resources/function-privileges.test.ts` and the CI bootstrap are updated in the same change, so the test still fails closed. The Production activation workflow's resolver check is extended to `luxia_session_resolve`.
- No new grant to anyone else, and no change to `app_user`'s attributes (NOSUPERUSER, NOBYPASSRLS).

## 7. Concurrency

**Lock order, everywhere:**
1. Tenant governance advisory lock(s), in tenant id order:
   - **always for a status transition** (A1, checked by 4.1);
   - for any transaction that writes grants (B1).
2. The organization row:
   - `FOR SHARE` through `luxia_organization_lock_active`, for sign-in, invitations and domains;
   - row lock through the `UPDATE`, for a transition.
3. Every other row.

B4 takes the governance lock(s), then updates the status **first**, then applies the effects, all in one transaction. B3 adds an architecture test that every transaction writing sessions, invitations or domains calls the helper first.

| Race | Outcome |
|---|---|
| Transition ‖ sign-in | If the transition goes first, the session insert waits on the share lock, then sees SUSPENDED and is refused. If the sign-in goes first, the transition's `UPDATE` waits for it, then revokes the new session too, because its next statement sees committed rows. A late session missed by the effects makes the deferred check fail: the whole transition is rolled back and the plan is recomputed. |
| Transition ‖ invitation acceptance (any role) | Both take the governance lock first (acceptance does since B1), so they are serialized. Either the acceptance completes before (the new member's sessions are then revoked by the transition) or it is refused after. |
| Transition ‖ grant writer (canonical, governance, access review) | Serialized by the governance lock. No interleaving. |
| Transition ‖ domain verification | The verification takes the share lock first. The domain is either verified before (and released by CLOSED) or refused after. |
| Two transitions | Serialized by the governance lock, then the row lock. The second one is validated against the committed state (for example, a second close sees CLOSED and is refused). |
| Transition without the governance lock | Refused by 4.1 (`GOVERNANCE_LOCK_REQUIRED`), nothing written. |
| Migration ‖ live traffic | Short `ACCESS EXCLUSIVE` on `Organization` and `Session` for `ADD COLUMN`, with `lock_timeout` at 5 s. Sign-ins wait briefly or the migration fails and is retried. |

## 8. Rollback

- **Application rollback** (Vercel, to `ebb4f46` or older) is always possible. The migration is expand-only, `resolve_session` keeps its signature, and nothing is ever SUSPENDED, CLOSED or RECOVERY before B3, B2 and B4.
- **Database rollback** is a down script, rehearsed on the clone. It:
  - drops the new triggers and functions;
  - restores the previous bodies of `resolve_session`, `luxia_invitation_resolve`, `luxia_invitation_guard` and `luxia_organization_domain_guard`;
  - drops the columns, then the enums.

  It is lossless **only while every organization is ACTIVE and no RECOVERY session exists**. The script checks this first and refuses otherwise.
- After the first SUSPENDED, CLOSED or RECOVERY row, the only option is a **forward fix**. Dropping the status would reopen a closed organization, which the scope forbids.
- Production backup: a Neon branch is taken just before the migration, as for self-onboarding.

## 9. Certification plan

**CI** (PostgreSQL, `app_user` for the runtime checks, owner for the operator checks):
- defaults and backfill, and every existing row accepted by the session guard;
- status:
  - the full transition matrix: owner allowed, `app_user` refused;
  - CLOSED final, including the name;
  - `statusChangedAt` set by the trigger;
  - A1 refusals:
    - a transition **without** the governance lock;
    - with the lock of only one of two tenants;
    - an autocommit transition;
- the deferred check: a transition without its effects fails at commit, and one with its effects passes;
- sessions:
  - insert refused for SUSPENDED and CLOSED, and insert with `revokedAt` refused;
  - `revokedAt`: NULL to timestamp works once, including with an application clock behind the database's; value to NULL, value to another value, and revocation combined with another change are all refused;
  - `lastSeenAt` is writable while active and refused after revocation;
  - a revoked session is entirely frozen;
  - RECOVERY limited to 15 minutes;
- resolution:
  - `luxia_session_resolve` returns nothing for SUSPENDED and CLOSED;
  - `resolve_session` returns exactly the FULL rows of `luxia_session_resolve`, and nothing for RECOVERY;
  - an architecture test proves the wrapper has no logic of its own (its body only selects from the canonical resolver);
- invitations:
  - resolve behaves like an unknown token;
  - creation, begin and acceptance are refused;
  - revoke is allowed;
- domains:
  - add and verify are refused;
  - release is allowed;
- concurrency races with the lock held until every operation is queued (as in B1):
  - transition against sign-in, in both orders;
  - transition against invitation acceptance;
  - transition against a grant writer;
  - two closes;

  Only the expected refusals may appear, never a deadlock;
- function privileges.

**Rehearsal on a Neon clone of Production**, reported before any Production action:
- business digest of all tables before and after: only the new columns appear;
- `legrand-tech` and the Lab both ACTIVE; Legrand's existing sessions resolve through both functions;
- the down script restores the exact previous digest, and the migration is applied again.

**Production**, after approval and on the exact SHA with CI PASS:
- backup branch first;
- migration applied with the owner on the direct endpoint;
- digests before and after, the 21 migrations listed;
- Legrand Tech: an existing session still resolves, and a new sign-in works;
- the current application keeps running with no deployment needed.

B3's own certification follows separately.

## 10. Decisions

**Approved by the operator on 2026-10-11:**

| # | Decision |
|---|---|
| M1 | The B4 procedure applies the effects of a transition (revoke sessions and invitations, release domains) explicitly and journaled; the database checks completeness at commit. |
| M2 | CLOSED freezes the whole organization row, name included. |
| M3 | Only roles with BYPASSRLS (the owner used by B4) may change the status; `app_user` never can. |
| M4 | `resolve_session` keeps its signature and grant; `luxia_session_resolve` returns `scope`; the old function is dropped in a later contract migration. |
| M5 | Sessions are append-only apart from `lastSeenAt` and a single revocation. |
| M6 | On CLOSED, PENDING domains become EXPIRED and VERIFIED ones become LOST (released). |

**Binding additions from the operator's review (2026-10-11), integrated above:**

| # | Requirement | Where |
|---|---|---|
| A1 | Every status transition runs under the tenant governance lock, in one atomic transaction. | 1.4, 4.1, 7 |
| A2 | `resolve_session` is a wrapper of the canonical resolution, not a parallel implementation. | 5 |
| A3 | `revokedAt` changes only from NULL to a timestamp, once. | 4.3 |
| A4 | `lastSeenAt` is immutable after revocation; a revoked session is frozen. | 4.3 |
| A5 | SUSPENDED and CLOSED are blocked in the database for every session resolution, not only in the application. | 5 |
