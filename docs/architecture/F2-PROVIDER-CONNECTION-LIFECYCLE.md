# F2: ProviderConnection lifecycle and sign-in kill switch

Phase F2 of the approved design in `SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md`, sections 4.4, 4.7 and 4.8.

| Item | State |
|---|---|
| Status | **PRODUCTION VERIFIED**, 2026-10-15: M1 and the F2 code, on the non-destructive path (section 5.2) |
| M1 rehearsal on a fresh clone of Production | **VERIFIED**, 2026-10-15: apply, lossless rollback and re-application (section 4.2) |
| Production M1 | **PRODUCTION VERIFIED**, 2026-10-15 16:17Z, with the pre-F2 code still running (section 5.1) |
| F2 code in Production | **PRODUCTION VERIFIED**, 2026-10-15: `d631edb` deployed 17:02Z (section 5.2) |
| DISABLE, QUARANTINE, RELEASE, ACTIVATE | **VERIFIED** by CI and the rehearsals. Their Production proof needs a test connection supported by F4 |
| M2 (RLS) rehearsal on a fresh clone of Production | **VERIFIED**, 2026-10-15: isolation of every organization, sign-in paths, lossless rollback and re-application (section 4.3) |
| Production M2 (RLS) | **PRODUCTION VERIFIED**, 2026-10-15 22:05Z: every organization isolated, sign-ins and backups work under it (section 5.3) |

Evidence labels:
- **VERIFIED:** read in the code, CI, or the Production database (read-only).
- **ASSUMPTION:** to confirm.

## 1. Production starting point (VERIFIED, read-only, 2026-10-14)

| Fact | Value |
|---|---|
| Organizations | 3 |
| Connections | 4: 3 `LUXIA_LOCAL` and 1 `MICROSOFT_ENTRA`. No `CUSTOM` and no other type (decision D6 below) |
| Connections without a tenant scope | 0 |
| Accounts | LUXIA_LOCAL: 2 ACTIVE and 2 DISABLED. Microsoft: 1 ACTIVE |
| Open sessions | 1 (Microsoft, FULL) |
| Row-level security on `ProviderConnection` | **None: neither enabled nor forced** (finding M3) |
| `app_user` privileges on `ProviderConnection` | SELECT, INSERT, UPDATE, **DELETE** |
| Triggers on `ProviderConnection` | None |
| SQL functions that read it | None |
| `neondb_owner` | `BYPASSRLS`, not a superuser |
| `app_user` | No `BYPASSRLS` |

The application today reads connections **outside any tenant scope** in four places:
- `app/auth/login/route.ts`;
- `app/auth/callback/route.ts`;
- both functions of `microsoft-entra/connection-config.ts`.

This is why row-level security comes in a second migration (section 4).

## 2. What F2 changes

**State machine.** It is enforced by the database and offered to administrators:

| From | Action (administrator) | To | Effect |
|---|---|---|---|
| ACTIVE | `DISABLE` | DISABLED | No new sign-in. Open sessions continue until they expire (R5) |
| DISABLED | `ACTIVATE` | ACTIVE | Sign-in again |
| ACTIVE or DISABLED | `QUARANTINE` | QUARANTINED | No new sign-in, and **every open session opened through the connection is revoked**, in the same transaction (D3) |
| QUARANTINED | `RELEASE` | DISABLED | Never straight back to ACTIVE: activation is a separate, explicit step |
| DRAFT → TESTING → ACTIVE | (F4) | | Not offered in F2: activation follows a real connection test |

**Guarantees, where they are enforced:**

| Guarantee | Database (`20261014090000`) | Application |
|---|---|---|
| Sign-in only through an ACTIVE connection | Trigger `session_guard_provider_connection`: every `Session` INSERT share-locks the connection and refuses `PROVIDER_CONNECTION_NOT_ACTIVE` | Resolver filters `status: "ACTIVE"`. `createSession` gives the reason. The callback checks it **before any call to the provider** |
| Allowed transitions only | `luxia_provider_connection_guard` | `CONNECTION_ACTIONS` (same pairs, architecture test) |
| Every transition under the organization's governance lock | Guard: checks every tenant's advisory lock, never takes it | `operation()` takes it first |
| Quarantine leaves no open session | Deferred constraint trigger, `SECURITY DEFINER`, so it sees every tenant | The revocation runs in the same transaction, then `SET CONSTRAINTS ALL IMMEDIATE` (finding P1) |
| A connection is never deleted | Guard refuses DELETE, for the owner too. `app_user` loses DELETE and TRUNCATE | No delete path |
| Identity of a connection never changes | `id`, organization, type and creation date are immutable. The external scope can change only in DRAFT/TESTING | — |
| LUXIA_LOCAL is always ACTIVE | Guard (created ACTIVE, never changes) | `LOCAL_CONNECTION_PROTECTED` |
| No blind or stale change (D3) | — | Dry run first. The change carries the plan digest of `{organization, tenant, connection, action, status, statusChangedAt}` and is refused when the state moved |
| Journal (R9, T0) | Append-only (T0) | `PROVIDER.CONNECTION.PLAN`, `.DISABLE`, `.ACTIVATE`, `.QUARANTINE`, `.RELEASE`, each `.DENIED` with its reason. French labels (B5) |
| Nothing else changes | — | No Subject, IdentityAccount, Assignment or connection is deleted. Authority counts are tested before and after |

**New external connections start as DRAFT.**
- `POST /api/canonical/providers` now creates any non-local connection as DRAFT, so it signs nobody in until F4 tests and activates it.
- Before F2, a connection created there could sign people in at once.
- The four existing Production connections stay ACTIVE.

**Administrator API.** `POST /api/canonical/providers/{id}/lifecycle` with `{action}` is the dry run; adding `planDigest` performs the change.
- Requires `providers.manage` and an `x-luxia-change-id` header.

## 3. Decisions taken in F2 (within the approved design)

| # | Decision | Why |
|---|---|---|
| F2-1 | LUXIA_LOCAL can never be disabled or quarantined. This is stricter than the design's "while the last administrator depends on it" | It removes a lockout path entirely. Rule R3 makes local sign-in the sovereign fallback. It can be widened later, with B1 proofs |
| F2-2 | DISABLED → QUARANTINED is allowed. It is not in the design's table | A disabled but compromised IdP still has live sessions. Quarantine must be able to end them |
| F2-3 | RELEASE goes to DISABLED, never ACTIVE | The design table already says so. Re-enabling trust is a second, deliberate step |
| F2-4 | The plan digest is stateless | Nothing to store or expire. A moved state simply refuses |
| D6 | `CUSTOM` stays in the enum, unused | Production has 0 rows. Removing an enum value is a contract migration, not worth it now |

**Multi-tenant note.**
- v1 has exactly one tenant per organization (the sign-in resolver refuses more).
- With several tenants, an administrator's revocation sees only their own tenant's sessions. The completeness check would then fail the quarantine: it fails closed, it never leaves sessions open.

## 4. Migrations, rollback and order

| Step | What | Reversible by | Gate |
|---|---|---|---|
| **M1** `20261014090000_provider_connection_lifecycle` | Expand only. A status column defaulting to ACTIVE (metadata-only, no row rewritten). Guards. The session trigger. The lock helper. Revoke DELETE/TRUNCATE from `app_user`. Post-condition checks | `docs/operations/PROVIDER-CONNECTION-LIFECYCLE-ROLLBACK.sql`. It refuses once any status has changed (forward fix only) | **Operator: Production migration** |
| Deploy | The application of this PR | Redeploy the previous deployment. The pre-F2 code works on M1 | Low-risk deploy rule |
| **M2** (next PR) | `ENABLE` + `FORCE ROW LEVEL SECURITY` on `ProviderConnection`, with the organization policy | `DISABLE ROW LEVEL SECURITY` | **Operator: Production migration**, only after the code that reads connections inside a scope is in Production |

**Compatibility of the old application with M1:**
- it never sets or reads the status;
- it inserts with the ACTIVE default;
- it never deletes a connection.

**Compatibility of the new application:**
- it reads connections only inside `withTenantDb` (architecture test);
- it therefore works before and after M2.

Proven in CI on a scratch database, by `provider-connection-lifecycle-postgres.test.ts`:
- Production-shaped seed;
- digest of every table, identical after M1;
- rollback identical: data, function and trigger definitions, `app_user` privileges;
- M1 applies again;
- the rollback refuses once a status is in use.

**Rehearsal on a Production clone, before the gate:**
1. Neon branch of Production.
2. Before digest.
3. M1, then digest identical and every connection ACTIVE.
4. Functional checks as `app_user`:
   - sign-in refused through a DISABLED connection;
   - quarantine revokes only its sessions;
   - DELETE refused.
5. Rollback, then digest identical.
6. M1 again.
7. Delete the branch.

### 4.1 Rehearsal evidence, 2026-10-14 (VERIFIED)

**Branch:**
- An ephemeral branch in the EU drill project, restored by Neon from the E1 Drill B branch (`br-raspy-frost-b9j52do9`), then deleted.
- The Production project had no free branch slot. Freeing one means deleting a backup branch, which is an operator decision.

**Content:**
- **The real Production rows:** the encrypted backup of 2026-10-13, with 3 organizations and 4 connections, including Legrand Tech.
- 121 test organizations created after it, when the application suites ran during Drill B. In total: 153 connections, 93 open sessions.
- The real roles `neondb_owner` and `app_user`.

**Procedure:** the Production gate's own, `prisma migrate deploy` as the owner on the direct endpoint. Exactly one migration was pending: M1.

| Step | Result |
|---|---|
| Before | Digest `a268d90195b0`. 153 connections, 0 not ACTIVE. 93 open sessions. `app_user` DELETE = true |
| M1 | Applied. **Digest identical**. 0 not ACTIVE. Same open sessions. `app_user` DELETE = false |
| Rollback | **Digest identical. Function, trigger and privilege definitions identical** (`0ab3ad7798f7`). Status column gone. Migration record removed |
| M1 again | Applied. Digest identical |
| `app_user` session through an ACTIVE external connection / ACTIVE local connection | Accepted / accepted |
| `app_user` DELETE of a connection / owner DELETE | `permission denied` / `PROVIDER_CONNECTION_IMMUTABLE` |
| Status change without the governance lock | `GOVERNANCE_LOCK_REQUIRED` |
| DISABLE, then a sign-in through it | Accepted, then `PROVIDER_CONNECTION_NOT_ACTIVE`. The open session is kept (R5) |
| Disable LUXIA_LOCAL | `PROVIDER_CONNECTION_LOCAL_ALWAYS_ACTIVE` |
| Quarantine without revoking / with revoking | `PROVIDER_CONNECTION_QUARANTINE_INCOMPLETE_SESSIONS` / accepted. Federated open sessions: 0. Local: 1 (kept) |
| QUARANTINED straight to ACTIVE | `PROVIDER_CONNECTION_STATUS_TRANSITION` |
| Rows outside the test organization changed by the checks | 0 |
| Rollback once a status is in use | `ROLLBACK_REFUSED_CONNECTION_STATUS_IN_USE` |

The script, kept out of the repository, prints only digests, counts and codes:
- it stops on the Production endpoint, on a pooled endpoint, or on any pending migration other than M1;
- it deletes the branch on exit.

### 4.2 Fresh rehearsal on a clone of Production, 2026-10-15 (VERIFIED)

Run `20261015T155202Z`, code `c2c1ac5` (this PR's head). **43 checks, 0 failures.**

**Branch:**
- A Neon branch of Production `main` itself, taken at 15:52Z: the current state, after G1, with the real roles. No data left the Production project.
- Deleted only after the evidence was written and verified. The Production project's other branches were left untouched.

**Evidence:**
- One manifest per phase: BEFORE, AFTER-M1, AFTER-ROLLBACK, AFTER-REAPPLY.
- Each manifest holds the data digest, the open sessions, a full `pg_dump --schema-only`, and every function, trigger, grant, type and `ProviderConnection` column.
- Each also holds a read-only snapshot of Production.
- Written once, then made read-only. All are listed in `INDEX.sha256` (`3b8c01dab4f4…`), and every hash was checked again after the run.

| Phase | Data | Full schema | Definitions | State |
|---|---|---|---|---|
| BEFORE | `f8ab856d3a1e` | `5a63eb6fe301` | `9016c89ff7db` | 4 connections. `app_user` DELETE = true. No status column. Last migration `20261013090000` |
| AFTER-M1 | `f8ab856d3a1e` | `e6a7e3a4b58f` | `6a512e4763b9` | 4 connections, **0 not ACTIVE**. `app_user` DELETE = false, TRUNCATE = false |
| AFTER-ROLLBACK | `f8ab856d3a1e` | `5a63eb6fe301` | `9016c89ff7db` | Identical to BEFORE: state, privileges, type removed, columns, migration history |
| AFTER-REAPPLY | `f8ab856d3a1e` | `e6a7e3a4b58f` | `6a512e4763b9` | Identical to AFTER-M1 |

**Verdicts:**

| # | Proof | Checks |
|---|---|---|
| 0 | The clone is the current Production after G1: same data, same definitions, same markers (last migration, G1 event, 0 passkeys claiming hardware binding) | 4/4 |
| 1 | **Safe apply:** data and sessions identical, the 4 connections ACTIVE, DELETE and TRUNCATE revoked from `app_user` | 5/5 |
| 2 | **Lossless rollback:** back to BEFORE exactly. Data, sessions, full schema, functions, triggers, privileges (DELETE restored), types, columns, state and migration history | 9/9 |
| 3 | **Reproducible:** M1 applies again. Data and sessions identical. Schema, definitions and state the same as the first application | 5/5 |
| 4 | **Production unchanged during the whole run:** its definitions, markers and data are identical in all four manifests. Still no status column | 4/4 |
| 5 | Guards on the clone, with a test organization created there after the manifests were sealed. Same results as the table in 4.1, and 0 existing connections touched | 15/15 |
| — | Evidence integrity: 8 files, read-only, hashes verified | 1/1 |

### 4.3 M2 (row-level security) rehearsal on a fresh clone of Production, 2026-10-15 (VERIFIED)

Run `20261015T213831Z`, code `bf2335a` (#67). **0 failures.**

**Branch:**
- A Neon branch of Production `main` with M1 and the F2 code in place, taken at 21:38Z.
- Deleted only after the evidence was verified. The Production project's other branches were left untouched.

The evidence standard is that of section 4.2:
- one immutable manifest per phase;
- a read-only snapshot of Production in each;
- `INDEX.sha256` = `589c019d705d…`.

Each manifest also records what `app_user` (the runtime) sees, without context and inside each organization's context.

| Phase | Data | Full schema | Definitions | Runtime view |
|---|---|---|---|---|
| BEFORE | `32776657fda3` | `e6a7e3a4b58f` | `fdd949998883` | 4 connections without context; **from any organization's context, all 4, 2 or 3 of them foreign** (finding M3) |
| AFTER-M2 | `32776657fda3` | `e31636851362` | `31aa741dc9cd` | **0 without context; inside each organization, exactly its own, 0 foreign** |
| AFTER-ROLLBACK | `32776657fda3` | `e6a7e3a4b58f` | `fdd949998883` | Identical to BEFORE |
| AFTER-REAPPLY | `32776657fda3` | `e31636851362` | `31aa741dc9cd` | Identical to AFTER-M2 |

**Verdicts:**

| # | Proof | Checks |
|---|---|---|
| 0 | The clone is the current Production (M1, the F2 code). Before M2, the runtime sees every connection | 4/4 |
| 1 | **Safe apply:** ENABLE and FORCE ROW LEVEL SECURITY, one policy. 0 rows without context, every organization isolated. Data, sessions and authority (Subjects, IdentityAccounts, Assignments, every column) identical. The 4 connections ACTIVE. Nothing else in the schema changed. `luxia_backup` keeps BYPASSRLS | 11/11 |
| 2 | **Lossless rollback:** data, sessions, full schema, definitions (RLS flags and policies included), state, markers and runtime view back to BEFORE | 7/7 |
| 3 | **Reproducible:** M2 applies again to the same schema, definitions, state and runtime view; data identical | 5/5 |
| 4 | **Production unchanged during the whole run.** Still without M2 | 5/5 |
| 5a | The **real application code**, as `app_user`, on the re-applied clone (17 checks, see below) | 1/1 |
| 5b | SQL guards with a test organization created in the clone (listed below), and Legrand Tech's connections untouched (every column) | 10/10 |
| — | Evidence integrity | 1/1 |

**5a, the real application code** (17 checks):
- The unscoped client sees 0 connections. Inside Legrand Tech's scope it sees exactly its 2 connections, and another organization's connection by id is not found.
- **Microsoft path:** `resolveLoginOrganization`, the login route read, the configuration resolver, `locateMicrosoftEntraConnection` and the callback's account lookup. Then a session with its VERIFIED evidence, through the session trigger. It resolves, and sign-out reads the connection through the session.
- **Passkey path:** the begin route read and the local adapter's challenge. Then a session of the local account, which resolves and signs out.
- Every session open before still resolves (no mass sign-out).

**5b, the SQL guards:**
- A test organization's context sees only its own 2 connections.
- A cross-organization INSERT is refused by row-level security.
- A cross-organization UPDATE changes 0 rows, and so does a cross-organization DISABLE, even while holding the other organization's lock.
- `app_user` DELETE is still refused.
- Under RLS, a session opens through an ACTIVE connection, DISABLE works under the lock, a session through the DISABLED connection is refused (`PROVIDER_CONNECTION_NOT_ACTIVE`), and quarantine with revocation works.

**Code audit:**
- Only two SQL functions read `ProviderConnection`: `luxia_provider_connection_effects` and `luxia_provider_connection_lock_active`. Both are SECURITY DEFINER, owned by `neondb_owner` (BYPASSRLS).
- `luxia_session_resolve` does not read it.
- The application reads connections, and their relations, inside a tenant scope only.
- The Production gate tool was first exercised end to end, refusals included, on a disposable clone of Production.

## 5. Production certification (after the gates)

**PRODUCTION VERIFIED needs:**
- M1 applied, with digests before and after;
- the application deployed;
- the operator's Microsoft and passkey sign-ins still work;
- read-only proof that:
  - every connection is ACTIVE;
  - no session was revoked;
  - nothing else changed.

The kill switch is then exercised **only on a test organization**, never on Legrand Tech:
1. DISABLE, then a refused sign-in.
2. QUARANTINE, then only that connection's sessions are revoked.
3. RELEASE, then ACTIVATE.

All of it is journaled.

### 5.1 M1 in Production, 2026-10-15 (PRODUCTION VERIFIED)

Operator gate, approved by the operator. The running application stayed the pre-F2 deployment (`cfb8be2`) throughout.

The gate tool uses the same evidence standard as the rehearsal:
- immutable manifests and an `INDEX.sha256`;
- `apply` refuses if the data or the definitions moved since BEFORE, or if the migration differs from the rehearsed one;
- `after` compares Production with the rehearsal's exact hashes.

It was first exercised end to end, refusals included, on a disposable clone of Production.

| Step | Result |
|---|---|
| Independent backup just before | `20261015T161451Z-d74566`: snapshot 16:14:51Z, 51 tables, 25 migrations, verified |
| BEFORE (read-only) | Data `f8ab856d3a1e`, schema `5a63eb6fe301`, definitions `9016c89ff7db`: **the rehearsed BEFORE**. 4 connections. Only M1 pending |
| M1 | 16:17:01Z → 16:17:10Z, `prisma migrate deploy` as the owner. Data and definitions re-checked unchanged just before |
| AFTER (read-only), 9/9 | **Data identical**. Sessions unchanged. 4 connections, 0 not ACTIVE. `app_user` DELETE = false, TRUNCATE = false. Schema `e6a7e3a4b58f` and definitions `6a512e4763b9`: **the rehearsed AFTER-M1**. G1 markers unchanged |
| Anonymous smoke test | 20/20 |
| Operator's Microsoft sign-in, 16:20:39Z | 11/11: VERIFIED evidence and a new FULL session through the ACTIVE connection. Accounts, subjects, assignments, connections and passkeys unchanged. Journal and evidence append-only |
| Operator's sign-in with an existing passkey, 16:25:43Z | 6/6: `LOCAL_PASSKEY_ASSERTION_VERIFIED`, a new FULL session through the ACTIVE `LUXIA_LOCAL` connection, no enrollment. Every connection still ACTIVE and unchanged |

**Rollback:** still possible, and lossless while every connection is ACTIVE and unchanged, which holds until the F2 code is deployed.

### 5.2 F2 code in Production, 2026-10-15 (PRODUCTION VERIFIED)

Operator gate, approved by the operator. The operator's conditions:
- no test organization or account is created in Production;
- Legrand Tech's real Microsoft connection is never disabled or quarantined;
- the state-changing transitions keep their proof from CI and the rehearsals until F4 brings a properly supported test connection.

| Step | Result |
|---|---|
| First hourly backup after M1 | `20261015T165400Z-f75b79`: 16:54Z, 51 tables, **26 migrations**, verified |
| Merge | #66 merged as `d631edb`, its tree identical to the tested head. `main` CI green on `d631edb` |
| Deploy | `d631edb` at its exact SHA, READY 17:02:29Z. The previous deployment, `cfb8be2`, is the rollback |
| Anonymous smoke test | 20/20, and the lifecycle route answers 401 without a session |
| Operator's Microsoft sign-in, 20:53:52Z | 11/11: VERIFIED evidence and a new FULL session through the ACTIVE connection. Nothing else changed |
| Operator's sign-in with an existing passkey, 21:16:05Z | 6/6: `LOCAL_PASSKEY_ASSERTION_VERIFIED`, a new FULL session through the ACTIVE `LUXIA_LOCAL` connection, no enrollment |

Every organization was compared, read-only, between 17:00:44Z (before the deploy) and 21:17:03Z. All 11 checks pass:
- **Connections:** the 4 connections are ACTIVE and never changed (status and `statusChangedAt`).
- **Authority:** Subjects, IdentityAccounts and Assignments are identical, every row and every column.
- **Sessions:**
  - No session was deleted, and already-revoked sessions are unchanged.
  - The only new sessions (2) and the only revocation (1) belong to the operator, in Legrand Tech.
  - No open session rests on a non-ACTIVE organization, account or connection.
- **Journal and evidence:** append-only. Every earlier row is identical, and the new rows are dated after the baseline.

### 5.3 M2 (row-level security) in Production, 2026-10-15 (PRODUCTION VERIFIED)

Operator gate, approved by the operator. The running application stayed the F2 deployment (`d631edb`) throughout.

The gate tool uses the standard of sections 4.3 and 5.1. It was first exercised end to end, refusals included, on a disposable clone of Production.

| Step | Result |
|---|---|
| Independent backup just before | `20261015T220301Z-09d7eb`: 22:03Z, 26 migrations, verified |
| BEFORE (read-only) | Schema `e6a7e3a4b58f` and definitions `fdd949998883`: **the rehearsed BEFORE**. Only M2 pending. The runtime saw all 4 connections from any organization's context |
| M2 | 22:05:01Z → 22:05:10Z, `prisma migrate deploy` as the owner. Data and definitions re-checked unchanged just before |
| AFTER (read-only), 12/12 | ENABLE and FORCE ROW LEVEL SECURITY, one policy. **`app_user` sees 0 connections without context, and in each organization exactly its own, 0 foreign.** Data, sessions and authority identical. The 4 connections ACTIVE. Schema `e31636851362` and definitions `31aa741dc9cd`: **the rehearsed AFTER-M2**. `luxia_backup` keeps BYPASSRLS |
| Anonymous smoke test | 20/20 |
| Operator's Microsoft sign-in, 22:06:59Z | 11/11 |
| Operator's sign-in with an existing passkey, 22:08:39Z | 6/6: through the ACTIVE `LUXIA_LOCAL` connection, no enrollment |
| Every organization, 22:03:40Z → 22:09:12Z | 11/11: connections, authority (every column), sessions coherent, journal and evidence append-only |
| Next hourly backup | `20261015T225341Z-4d1bc1`: 22:53Z, 51 tables, **27 migrations**, verified. Backups read through row-level security |

**Rollback:** `docs/operations/PROVIDER-CONNECTION-RLS-ROLLBACK.sql`. Lossless, since no data is involved, and possible at any time.
