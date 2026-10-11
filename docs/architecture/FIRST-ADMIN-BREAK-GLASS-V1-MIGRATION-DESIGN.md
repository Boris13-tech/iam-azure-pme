# First Admin / Break-glass v1: migration design for `Organization.status` and `Session.scope`

Status: **design proposal, for operator approval.** Until it is approved there is no code, no migration and no deployment.

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
3. **Every effect of a transition stays explicit and audited.** The B4 procedure performs it and journals it with before and after counts. The database only checks, at commit, that the effects are complete.
4. **One lock order everywhere**, which extends the B1 rule: tenant governance lock (advisory), then the organization row, then other rows.

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
- `Tenant` gets no status: in v1 an organization has exactly one tenant, and status is an organization fact.

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
  - the count of sessions not revoked is the same before and after.

## 4. Database constraints

### 4.1 Organization status guard (`luxia_organization_status_guard`, BEFORE INSERT OR UPDATE)

- **New organizations are always ACTIVE.** An INSERT with another status is refused, for every role. Signup keeps working: its SECURITY DEFINER function relies on the default.
- **Only the operator role may change the status.** A status change is refused unless the current role has `rolbypassrls`:
  - in Production that is the owner, which B4 uses;
  - in CI it is the migration superuser;
  - `app_user` never has it.

  This works with today's grants (`app_user` keeps UPDATE on the table) and does not depend on role names.
- **Allowed transitions only**: ACTIVE→SUSPENDED, ACTIVE→CLOSED, SUSPENDED→ACTIVE, SUSPENDED→CLOSED. Any other change is refused.
- **CLOSED is final.** Any UPDATE of a CLOSED row is refused, including the name. Reopening would need a separately reviewed procedure.
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
- for CLOSED, revoke the open invitations, set VERIFIED domains to **LOST** (released) and PENDING domains to **EXPIRED**;
- do all of this in the same transaction.

Otherwise nothing is written. SUSPENDED keeps open invitations (they cannot be accepted, see 4.4) and keeps verified domains (still owned), as 9.1 requires.

### 4.3 Sessions (`luxia_session_guard`, BEFORE INSERT OR UPDATE)

- **INSERT:** the organization must be ACTIVE (`luxia_organization_lock_active`, see 4.6). No sign-in path can create a session for a SUSPENDED or CLOSED organization, even if the application check is missing.
- **INSERT with `scope = RECOVERY`:** CHECK `"expiresAt" <= "createdAt" + interval '15 minutes'` (table constraint).
- **UPDATE:** only two columns stay writable, which are the only ones the code writes today (verified in `lib/` and `app/`):
  - `lastSeenAt`;
  - `revokedAt`, set **once**, from NULL to a value. A revoked session can never be un-revoked or re-dated.

  Every other column is immutable: `scope`, `expiresAt`, `organizationId`, `tenantId`, `subjectId`, `identityAccountId`, `createdAt`, and the hashes.

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
- EXECUTE is granted to `app_user`, so that B3 can call it **first** in its transactions (section 7).
- It reveals nothing to the browser. B3 calls it only on the server, after resolving the organization, and maps any refusal to the generic anonymous answer.

## 5. Existing sessions and session resolution

- **Today**, `getSession` reads `SELECT * FROM resolve_session(hash)`, a SECURITY DEFINER function. Its EXECUTE grant to `app_user` in Production comes from the activation workflow, not from a migration. **Recreating it would drop that grant and break every sign-in.** It is therefore changed with `CREATE OR REPLACE` and the **same signature**:
  - it returns nothing when the organization is not ACTIVE. Every route refuses at resolution, as soon as the status changes, even with the current code;
  - it returns nothing for a `RECOVERY` session. Code that does not know about recovery sessions (today's `ebb4f46`, or a rollback) can therefore **never** treat one as a full session.
- **New** `luxia_session_resolve(hash)` returns the same columns plus `scope`, again only for an ACTIVE organization. It is granted to `app_user` in a `DO` block, as in the self-onboarding migration, and in the CI bootstrap. B2 switches `getSession` to it and enforces the recovery-only allow-list. The old `resolve_session` is dropped in a later contract migration, together with `luxia_login_decoy`.
- Existing sessions: none is revoked or changed. All are FULL, and every organization is ACTIVE, so their behavior is identical.

Observation for B3, outside this migration: `getSession` checks neither the subject lifecycle nor the identity account status. B3 should also make the new resolver refuse a non-ACTIVE subject or a DISABLED account.

## 6. RLS and privileges

- `Organization` and `Tenant` keep **no RLS**, as today. Pre-authentication resolution of the slug needs them. The status is never sent to the browser before authentication (B3).
- `Session` keeps its forced tenant policy. `scope` falls under the same policy.
- **New or changed functions:**
  - all are owned by the owner, SECURITY DEFINER where they must cross tenants, with `search_path = public, pg_temp` and `REVOKE ALL ... FROM PUBLIC`;
  - trigger functions need no EXECUTE grant;
  - only `luxia_session_resolve` and `luxia_organization_lock_active` are granted to `app_user`.
- `tests/resources/function-privileges.test.ts` and the CI bootstrap are updated in the same change, so the test still fails closed.
- No new grant to anyone else, and no change to `app_user`'s attributes (NOSUPERUSER, NOBYPASSRLS).

## 7. Concurrency

**Lock order, everywhere:**
1. Tenant governance advisory lock(s), when the transaction writes grants; in tenant id order.
2. The organization row:
   - `FOR SHARE` through `luxia_organization_lock_active`, for sign-in, invitations and domains;
   - row lock through the `UPDATE`, for a transition.
3. Every other row.

The guards re-take the share lock as a backstop. B3 adds an architecture test that every transaction writing sessions, invitations or domains calls the helper first. B4 takes the governance lock(s), then updates the status **first**, then applies the effects.

| Race | Outcome |
|---|---|
| Transition ‖ sign-in | If the transition goes first, the session insert waits on the share lock, then sees SUSPENDED and is refused. If the sign-in goes first, the transition's `UPDATE` waits for it, then revokes the new session too, because its next statement sees committed rows. If B4 revoked sessions *before* updating the status, the deferred check finds the late session and the whole transition fails: nothing is written and the plan is recomputed. |
| Transition ‖ invitation acceptance | The acceptance takes the share lock first (B3), so either it completes before the transition (and the member is ACTIVE, then sessions are revoked as usual) or it is refused after. |
| Transition ‖ domain verification | Same: the domain is either verified before (and released by CLOSED) or refused after. |
| Two transitions | The row lock serializes them. The second one is validated against the committed state (for example, a second close sees CLOSED and is refused). |
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
- defaults and backfill;
- the full transition matrix (owner allowed, `app_user` refused, CLOSED final including the name, `statusChangedAt`);
- the deferred check: a transition without its effects fails at commit, and one with its effects passes;
- sessions:
  - insert refused for SUSPENDED and CLOSED;
  - un-revoke refused, `scope` immutable;
  - RECOVERY limited to 15 minutes;
  - `resolve_session` and `luxia_session_resolve` both return nothing for a non-ACTIVE organization, and `resolve_session` returns nothing for RECOVERY;
- invitations:
  - resolve behaves like an unknown token;
  - creation, begin and acceptance are refused;
  - revoke is allowed;
- domains:
  - add and verify are refused;
  - release is allowed;
- concurrency races with the lock held until every operation is queued (as in B1):
  - transition against sign-in, in both orders;
  - transition against acceptance;
  - two closes;

  Only the expected refusals may appear, never a deadlock;
- function privileges.

**Rehearsal on a Neon clone of Production**, reported before any Production action:
- business digest of all tables before and after: only the new columns appear;
- `legrand-tech` and the Lab both ACTIVE; Legrand's sessions resolve;
- the down script restores the exact previous digest, and the migration is applied again.

**Production**, after approval and on the exact SHA with CI PASS:
- backup branch first;
- migration applied with the owner on the direct endpoint;
- digests before and after, the 21 migrations listed;
- Legrand Tech: an existing session still resolves, and a new sign-in works;
- the current application keeps running with no deployment needed.

B3's own certification follows separately.

## 10. Decisions for the operator

| # | Question | Recommendation |
|---|---|---|
| M1 | Who applies the effects of a transition (revoke sessions and invitations, release domains)? | **The B4 procedure, explicitly and journaled; the database only checks completeness at commit.** The alternative, a trigger that does the effects silently, is simpler but hides them from the journal and from the dry-run counts. |
| M2 | Does CLOSED freeze the whole organization row, or only its status? | **The whole row.** "Definitive end of service" leaves nothing to edit. |
| M3 | Who may change the status in the database? | **Only roles with BYPASSRLS** (the owner used by B4). `app_user` never can, even through a bug. |
| M4 | How should session resolution change without breaking Production? | **Keep `resolve_session` (same signature, refuses non-ACTIVE organizations and RECOVERY sessions) and add `luxia_session_resolve` with `scope`.** The old one is dropped in a later contract migration. |
| M5 | Should the migration also make sessions append-only, apart from `lastSeenAt` and a single revocation? | **Yes.** It costs one trigger, the completeness check of M1 relies on it, and no current code writes anything else. |
| M6 | What happens to PENDING domains on CLOSED? | **EXPIRED**, while VERIFIED ones become **LOST** (released). |
