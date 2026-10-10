# SECURITY JOURNAL V1 — PRODUCTION CERTIFICATION: PASS

Date: 2026-10-10 (UTC). Scope: `docs/product/SECURITY-JOURNAL-V1-SCOPE.md` (S1–S4 validated), PR #29 (code) and #28 (scope).

## Release

| Step | Reference | Result |
|---|---|---|
| PR #29 merged | `cab1f205a0e259dc63d20d7aadbf45b35ce97ed1` | CI PASS (run 38084916576) |
| PR #28 merged (scope doc) | `2d7ec6231e434ff6503d1a08794dfd2274f8b587` | CI PASS (run 38084935398) |
| Production deployment | **`dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62`** | READY, active target. Built by Vercel from GitHub at the exact SHA; no env change, no migration. |
| Rollback | `dpl_PCZz9eeMFHWjqpUtFZxQ5UdXi7sU` (`278a639`) | READY |

Unauthenticated smoke:
- `/login` 200;
- `/dashboard` 307;
- `/api/canonical/security-journal`, `/api/me/sessions` and `/api/me/authenticators` return 401;
- `POST /api/me/sessions/{ref}/revoke` without a session returns 401.

## Method

1. A read-only baseline was taken at **T0 = 2026-10-10T20:47:30Z**, before deployment (`app_user`, `READ ONLY`, tenant RLS). It showed 0 sign-in evidence and 0 journal events since T0, 3 active sessions and 6 active passkeys.
2. The operator performed real actions in Chrome:
   - sign-out;
   - Microsoft Entra sign-in;
   - sign-out;
   - passkey sign-in;
   - passkey enrolment.
3. Claude performed the following:
   - read-only database cross-checks;
   - inspection of the journal, "Mes sessions" and the dashboard through the operator's authenticated Chrome (Claude in Chrome; no cookie read);
   - revocation of one old, non-current session from "Mes sessions".

## Evidence (database, read-only, since T0)

| Expected | Database | Consistency |
|---|---|---|
| W1 Entra sign-in | `AuthenticationEvidence` 20:52:35.751Z: `FEDERATED_OIDC`, `VERIFIED`, `EXTERNAL_PROVIDER`, **`LOW` / `PROVIDER_ASSERTED` / `phishingResistant=false`**, `ENTRA_OIDC_VERIFIED` | Session created at 20:52:35.752Z (same transaction). **S1 respected.** |
| W4 sign-out | `SESSION.SIGN_OUT` 20:53:47.311Z (metadata `providerType: MICROSOFT_ENTRA`) | The Entra session was revoked at 20:53:47.336Z |
| Passkey sign-in | `AuthenticationEvidence` 20:54:31.026Z: `PASSKEY`, `VERIFIED`, `LOCAL_VERIFIER`, phishing-resistant | Session created at 20:54:31.043Z |
| W5 passkey enrolment | `LOCAL_AUTHENTICATOR.ENROLL` 21:07:54.662Z (metadata `type: PASSKEY` only) | Active passkeys went from 6 to **7** |
| R2 self-revocation | `SESSION.REVOKE` 21:10:55.738Z, metadata `selfService: true, current: false` | The targeted session (opened 14:49:48Z) was revoked at 21:10:55.737Z. Active sessions went from 4 to **3**. |

Step 1 of the operator's sequence (sign-out) produced no event. The database shows that **only one session was revoked since T0** (the Entra one), so that browser had no active session to close at that point. No revocation lacks its event; the code correctly writes nothing when there is nothing to revoke.

## Production UI and API checks

- **Unified journal** (`/dashboard/audit`), newest first:
  - the sequence is self-revocation, enrolment, passkey sign-in, sign-out, Entra sign-in;
  - the Entra sign-in is labelled **"Connexion attestée par Microsoft"**, with no MFA wording anywhere;
  - the passkey sign-in is labelled "Résistante à l'hameçonnage";
  - consultations are hidden by default.
- **Journal payload** (100 entries, consultations included):
  - fields limited to `action, actorName, assurance, id, kind, method, occurredAt, providerType, result, targetName`;
  - no IP or user-agent hash, credential id, public key, sign counter or evidence digest;
  - no 64-hex value.
- **"Mes sessions"**:
  - 4 active sessions were listed, equal to the database count;
  - "Cette session" was marked correctly;
  - the revocation removed the row and was audited.
- **"Mes clés d'accès"**:
  - 7 passkeys were listed, read only;
  - the new one shows the enrolment time, and the one used at 20:54Z shows that last-use time.
- **Dashboard (R4)**:
  - `auth.entraSignInEvidence` changed from `unavailable` to `ok` with **`since: 2026-10-10T20:52:35.751Z`** (`VERIFIED: 1`, `REJECTED: 0`);
  - `auth.signIns24hByMethod` shows `FEDERATED_OIDC: 1, PASSKEY: 8`;
  - `auth.rejectedSignIns24h` shows `0`.

  These values equal an independent read-only database count (passkey verified over 24 h: 8; Entra verified overall: 1; rejected over 24 h: 0).

## Certified by CI, not exercised in Production

- **W2/W3 refusals of known identities.** Exercising them in Production would require suspending or disabling a real identity, which would mutate business data. They are covered by `tests/resources/security-journal-postgres.test.ts` (REJECTED evidence, no session) on app_user PostgreSQL/RLS.
- **W1 fail-closed.** If the evidence cannot be written, no session exists. Covered by the same suite with broken and mismatched evidence.

## Out of scope (v1, as approved)

Failures before identity resolution (S3), passkey revocation (S2), and MFA / Conditional Access evidence from Entra (needs `amr` and Graph, PR12).

**SECURITY JOURNAL V1 — PRODUCTION CERTIFICATION: PASS**
