# First Admin / Break-glass v1, B2: personal recovery codes and the recovery-only session (design)

Status:
- **Design. Decisions R1 to R6 approved by the operator on 2026-10-11, with a precision on R5** (section 12).
- No code, no migration and no deployment until the operator approves the merge of this design, then each later step separately.

Binding inputs:
- `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md`: requirement 2 and section 9.4;
- the operator's B2 requirements (2026-10-11);
- what is already in Production:
  - the migration `Organization.status` + `Session.scope` (the `RECOVERY` scope, its 15-minute CHECK, and append-only sessions);
  - B3 (one canonical resolver, FULL-only resolution, lock order).

Production facts (read-only, 2026-10-11):
- 0 rows in `LocalRecoveryCode`;
- 0 RECOVERY sessions;
- 3 local identities, 1 of them ACTIVE (Legrand Tech).

The `LocalRecoveryCode` table and two adapter helpers already exist (`issueRecoveryCodes`, `consumeRecoveryCode`), but no route calls them. B2 replaces those helpers.

**Out of scope, kept for B4:** any operator action, operator-issued recovery invitation, or LUXIA access. B2 is self-service only.

## 1. Principles

1. **A recovery code opens one thing only.** It gives a 15-minute session that can enrol a new passkey for its own account, then sign out. Nothing else, ever, and never an administrator permission.
2. **The server decides, at session resolution, for every route.** The browser and the middleware decide nothing.
3. **Secrets are shown once and stored as hashes.** Single use, no resurrection, no expiry surprises.
4. **Same lock order and the same "fail closed" rules as B1 and B3.** Every change is audited in the canonical journal.

## 2. Recovery codes

| Rule | Design |
|---|---|
| Who | A person with an ACTIVE **LUXIA local identity** (passkey account), for that account only. Microsoft-only accounts get no codes: Microsoft handles their recovery. |
| Generation | **10 codes**, in a self-service action from the Authentication page. It needs a FULL session **signed in with a passkey less than 15 minutes ago** (decision R2), so a stolen old session cannot plant a backdoor. |
| Format | 20 characters from the Crockford base32 alphabet (**100 bits** of entropy each), shown as `XXXXX-XXXXX-XXXXX-XXXXX`. Input is normalized: upper case, no spaces or hyphens, `O` read as `0`, `I` and `L` read as `1`. |
| Shown once | Returned once in the generation response, displayed with "copy" and "download as text", then never again: no endpoint can read a code. The page keeps them only in memory. |
| Storage | Only `codeHash = SHA-256("luxia-recovery-code:v1:" + identityAccountId + ":" + normalizedCode)`, in hex. Domain separation and the account binding mean the same code can never match another account. With 100 bits per code, a pepper adds nothing: no env change. |
| Batch | Each generation is a **batch** (`batchId`). Generating a new batch **revokes every unused code of earlier batches** of that account, in the same transaction. |
| Single use | Consuming a code sets `usedAt` once, with a conditional update. The database guard (section 4) refuses any second write. |
| Invalidation | A code becomes permanently unusable when: (a) it is used; (b) a new batch is generated; (c) the person runs "revoke all my codes" (`revokedAt`); (d) indirectly, while the organization, subject, identity account or local identity is not ACTIVE, recovery sign-in is refused (section 5). That last case revokes nothing, so the codes work again once everything is ACTIVE. |
| No resurrection | `usedAt` and `revokedAt` go from NULL to a timestamp **once**. A used or revoked code is frozen, rows are never deleted, and the rollback (section 10) keeps them unusable. |
| Expiry | **None** (decision R1). Codes end by use, a new batch or revocation. The existing 30-day helper is retired. |
| Visibility | The Authentication page shows only "N codes left" and the generation date. B5 adds "recovery codes created" to the overview. |

## 3. Recovery sign-in (before authentication)

Endpoint: `POST /api/auth/local/recovery`, body `{ organization, principalName, code }`. It is a single step, with no challenge, because the code is the credential.

**Anti-enumeration.** Every refusal is **the same response**: HTTP 401 `{ "error": "LOCAL_AUTHENTICATION_FAILED" }`, the generic one already used by passkey completion, behind the same **400 ms minimum duration**. The refusals covered are:
- unknown organization;
- SUSPENDED or CLOSED organization (B3);
- unknown person;
- person, account or local identity not ACTIVE;
- wrong code, used code or revoked code;
- rate limit reached.

No answer says which part failed.

**Rate limits** (existing database limiter, peppered keys):
- `recovery` per client: 10 per hour;
- `recovery-identity` per (organization, person): 5 per hour.

No lockout: failed recovery attempts do not lock the identity, so an attacker cannot lock out the real person (decision R3). A LOCKED local identity, locked by passkey failures, is refused generically until its lock expires.

**Atomic success**, in one transaction and in this order:
1. `lockOrganizationActive` first (B3 lock order);
2. resolve and check the person, account and local identity (all ACTIVE);
3. consume the code (`usedAt`, conditional);
4. write the sign-in evidence (VERIFIED, method `CUSTOM`, reason `LOCAL_RECOVERY_CODE_VERIFIED`, assurance LOW, not phishing-resistant, user verification `NOT_VERIFIED`);
5. create the session with **`scope = RECOVERY`** and `expiresAt = now + 15 minutes` (the database CHECK enforces it);
6. write the journal event `RECOVERY.SIGN_IN`.

If any step fails, nothing remains: the code is not consumed, and there is no session and no evidence.

**Refusal evidence.** For a known person with a wrong code, a REJECTED evidence is written in a separate transaction (pattern W2). The response is the same as for an unknown person.

## 4. Data model and database guarantees (one small migration)

`LocalRecoveryCode` gets:
- `batchId TEXT NOT NULL`;
- `revokedAt TIMESTAMP(3)`;
- a CHECK `codeHash ~ '^[0-9a-f]{64}$'`.

The trigger `luxia_recovery_code_guard` (BEFORE INSERT, UPDATE or DELETE):
- **INSERT:**
  - the organization must be ACTIVE (`luxia_organization_lock_active`);
  - `usedAt` and `revokedAt` must be NULL;
  - at most 10 usable codes per identity account after the insert.
- **UPDATE:**
  - only `usedAt` or `revokedAt` may change, from NULL to a timestamp, once, and not both in the same statement;
  - every other column is immutable;
  - a used or revoked row is frozen.
- **DELETE:** refused, so evidence is kept.

**Backfill and rollback.** Production has 0 rows. If the rehearsal finds any, the migration revokes them and gives each its own `batchId`: they were never shown by the product. Rollback is in section 10.

Sessions need no new column: the `RECOVERY` scope and its 15-minute CHECK already exist in Production, and sessions are append-only.

## 5. The recovery-only session

The "recovery-only" (`RECOVERY_ONLY`) session is a session with `scope = RECOVERY`. That enum value is already in Production since the status and scope migration, so no new scope value is needed.

**Server-side enforcement at resolution, for every route.**
- `getSession` resolves through `luxia_session_resolve` (B3).
- A **RECOVERY** session is returned **only** when the caller asks explicitly, through a separate function, `getRecoverySession()`. That function returns a distinct `RecoveryContext` type, which has no `AuthContext` shape: it cannot be passed to `checkPermission`, `requireNative`, `operation()` or any administration function.
- Every existing entry point keeps using `getAuthContext` / `requireAuth`, which refuse RECOVERY sessions: 401 for APIs, redirect for pages. This covers the dashboard, the journal, the sessions page, administration, recovery-code generation and every other page or API.

**Allow-list.** Exactly three server entry points accept a recovery session:
1. passkey enrolment **begin** for the session's own identity account;
2. passkey enrolment **complete**, for the same account;
3. sign-out (`/auth/logout`).

The page `/recovery` is the only page a recovery session can render. It offers « Ajouter une nouvelle clé d'accès » and « Se déconnecter », and nothing else: no navigation, no data, no names beyond the person's own display name.

An architecture test fails if any other file in `lib/` or `app/` calls `getRecoverySession`.

**Never an administrator.** A recovery session satisfies no permission, even for an administrator. The type separation makes this structural, and a PostgreSQL test proves that every administration route refuses it.

**15 minutes, hard limit.** The database CHECK enforces it. The session is never extended, `lastSeenAt` refreshes do not extend it, and a new code is needed after it expires.

## 6. Enrolment ends the recovery session

`enrollment/complete` with a recovery session does all of this **in one transaction**:
- organization lock first;
- create the new passkey for the session's own identity account;
- **revoke the recovery session**;
- **revoke every other session of that identity account**;
- **revoke the previous passkeys of that account** (decision R4): passkeys and security keys. TOTP is not touched, because it is not used as a sign-in authenticator in the product;
- write `RECOVERY.PASSKEY_ENROLLED` (with the number of passkeys and sessions revoked) and `LOCAL_AUTHENTICATOR.ENROLL`.

The response clears the cookie. The person then **signs in normally with the new passkey**, which gives a FULL session.

The remaining codes of the batch stay technically valid (R5). The interface **pushes strongly for a new batch right away**, as section 9 describes.

**Anti-replay:**
- the enrolment challenge is single use (existing `LocalAuthChallenge` rules);
- a recovery session can complete **one** enrolment: the second completion finds the session revoked and is refused;
- a consumed code can never open a second session.

## 7. Concurrency (tested with real races, as in B1 and B3)

| Race | Expected outcome |
|---|---|
| Two recovery sign-ins with the same code | One session; the other gets the generic 401. The conditional update and the guard decide. |
| Regeneration ‖ recovery sign-in with an old code | Either the code is consumed first (a session exists, and the new batch revokes the remaining old codes), or it is revoked first and the sign-in gets the generic 401. Never both. |
| Two enrolment completions in one recovery session | One passkey; the second is refused (the session is already revoked). |
| Organization suspension ‖ recovery sign-in | B3 lock order: the sign-in is refused, or the session it created is revoked by the suspension. |
| "Revoke all codes" ‖ recovery sign-in | Either consumed then the rest revoked, or revoked then refused. |
| Recovery session expiry ‖ enrolment | An expired session is refused at resolution, and the transaction re-checks `expiresAt`. |

## 8. Audit (canonical journal and sign-in evidence)

| Event | When | Metadata (no code, no hash, no IP) |
|---|---|---|
| `RECOVERY_CODES.GENERATE` | a new batch | batch id, count 10, number of earlier codes revoked |
| `RECOVERY_CODES.REVOKE` | "revoke all my codes" | number revoked |
| `RECOVERY.SIGN_IN` | successful recovery sign-in | method, assurance LOW; a VERIFIED evidence is written in the same transaction |
| sign-in evidence REJECTED | known person, refused code | reason only |
| `RECOVERY.PASSKEY_ENROLLED` | enrolment that ends the recovery | sessions revoked, passkeys revoked |
| `SESSION.SIGN_OUT` | sign-out of a recovery session | existing event |

French journal labels (B5): « Codes de récupération générés », « Codes de récupération révoqués », « Connexion de récupération », « Clé d'accès ajoutée par récupération ».

## 9. Interface (French, sober, facts only)

- **Authentication page:**
  - section « Codes de récupération »: « Générer 10 codes »;
  - the codes are shown once, with copy and download, and « J'ai enregistré mes codes »;
  - « N codes restants »;
  - « Révoquer tous mes codes ».
- **Sign-in page:** link « J'ai perdu ma clé d'accès ». The form asks for the organization, the identifier and the code, with the same generic error as for any failure.
- **`/recovery`:** « Votre session de récupération expire dans 15 minutes. » Then « Ajouter une nouvelle clé d'accès » and « Se déconnecter ».
- **After a recovery (R5, strong recommendation).** Until the person generates a new batch, a persistent notice is shown at the top of the overview and of the Authentication page: « Vous avez utilisé un code de récupération. Générez dès maintenant un nouveau lot : les codes restants de l'ancien lot restent valides jusqu'à ce moment. » It has one primary button, « Générer un nouveau lot ».
  - The notice cannot be dismissed. It disappears only when a new batch exists.
  - The fact behind it (a batch partly consumed by a recovery) is read from the database: no flag is stored in the browser.
  - B5 adds the same fact to the « Mise en route » checklist.

## 10. Rollback (defined before implementation)

- **Application:** rolling back to the B3 deployment (`8aec711`) is always safe. That code never calls the code helpers through a route, and it refuses RECOVERY sessions at resolution (FULL only), as does the `resolve_session` wrapper.
- **Database:** a rollback script, rehearsed on a clone. It:
  - first sets `usedAt = revokedAt` on every revoked row that is unused, so that **no revoked code can become usable again** once `revokedAt` is dropped;
  - revokes every RECOVERY session that is still open;
  - drops the guard, the CHECK, then `batchId` and `revokedAt`.

  This keeps every code that was ever invalidated invalid, so it is safe even after codes were issued.
- **Production:** a backup branch is taken just before the migration, as for the previous migrations.

## 11. Certification plan

**CI** (PostgreSQL, `app_user`, real routes):
- generation:
  - 10 codes, shown once, only hashes stored;
  - a new batch revokes the old codes;
  - "revoke all";
  - generation refused without a recent passkey sign-in, and for a Microsoft-only account;
- recovery sign-in:
  - the success path (RECOVERY session, 15 minutes, evidence and journal);
  - every refusal gives the identical 401 shape;
  - rate limits;
  - SUSPENDED and CLOSED organizations behave like unknown ones;
- the session:
  - refused by every other route, including the dashboard, journal, sessions, administration and code generation;
  - accepted only by the three allowed entry points;
  - never satisfies a permission;
  - expires at 15 minutes;
- enrolment:
  - ends the session;
  - revokes the other sessions and the previous passkeys (R4);
  - the new passkey signs in FULL;
- the database guard: single use, no resurrection, frozen rows, no delete, at most 10 usable codes;
- the concurrency races of section 7;
- architecture tests: the allow-list, the type separation, lock order (extends the B3 test), and no operator logic.

**Clone rehearsal** of the migration: digest, guard behavior, rollback (including the "no resurrection" rule) and re-apply.

**Production**, each step approved separately: migration, deployment, then a human ceremony on a **dedicated test identity**, not on the operator's own account, because R4 revokes the previous passkeys. The ceremony:
1. generate the codes;
2. sign out;
3. recover with one code;
4. check that every normal page is refused;
5. enrol a new passkey (Windows Hello);
6. sign in with it;
7. check that the code cannot be reused.

## 12. Decisions (approved by the operator on 2026-10-11)

| # | Decision | Operator precision |
|---|---|---|
| R1 | **Codes do not expire automatically.** They end by use, a new batch or revocation. | Their security comes from entropy, single use, revocation and rate limiting. |
| R2 | **Generating a batch requires a passkey authentication less than 15 minutes old**, for a LUXIA local identity. | 15 minutes at most. |
| R3 | **No account lockout after failed recovery attempts**: rate limits and anti-abuse protections only (5 per hour per person, 10 per hour per client). | This prevents a denial of service against the owner. |
| R4 | **After a successful recovery and the enrolment of a new passkey, the previous passkeys of the account and its other sessions are revoked**, in the same transaction. | It is the safest choice. Precision of 2026-10-12: "passkeys" means passkeys and security keys; TOTP is not touched, because it is not used as a sign-in authenticator in the product. |
| R5 | **The remaining codes of the batch stay technically valid after a recovery, and the interface pushes strongly for a new batch right away** (section 9). | A stricter policy, "recovery = mandatory rotation of the batch", may be decided later if the user experience allows it. It is out of scope for B2. |
| R6 | **Production certification only with a dedicated test identity**, never the operator's Legrand account. | R4 would revoke the operator's own passkeys and sessions. |
