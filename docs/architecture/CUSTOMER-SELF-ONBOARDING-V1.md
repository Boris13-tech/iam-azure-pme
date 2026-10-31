# Customer Self-Onboarding v1: implementation and certification plan

Scope (validated with O1–O5 and 17 mandatory requirements): `docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md` (PR #31).
Migration, rollback and forward-fix: `docs/operations/CUSTOMER-SELF-ONBOARDING-V1-MIGRATION.md`.

**Status: code complete on the PR branch. Nothing is merged, deployed or migrated in Production.** Each of those steps needs review, CI on the exact SHA and the operator's explicit approval.

## What a new customer does

1. **Signup.** The LUXIA operator issues a beta code with `scripts/operators/signup-codes.ts`: `plan` writes nothing and prints a digest, then `issue` writes with that digest as the confirmation (standard, section 10), within 15 minutes, on the same database and tool commit, once per plan. The code is shown once and only its hash is stored.
2. **Organization creation.** On `/signup`, the customer enters the code, the organization name and identifier, their own name and their identifier, then creates a passkey. One transaction creates:
   - the organization;
   - its tenant;
   - its local sign-in connection;
   - the founder, their identity and their passkey;
   - the administrator access, taken from the server catalog;
   - the audit trail.
3. **First sign-in.** The founder signs in on `/login` with the organization identifier, their own identifier and the passkey.
4. **Domain.** Under **Organisation > Domaines**, the founder adds a domain and publishes the TXT record `_luxia-verification.<domain>`, then clicks **Vérifier**.
5. **Team.** Under **Organisation > Invitations**, the founder creates an invitation as Membre or Administrateur and uses **Copier le lien d'invitation**. The invitee opens the link, chooses an identifier, creates a passkey, then signs in.
6. **Checklist.** The overview shows "Mise en route" (domain verified, second administrator, team invited, first resource, first access review) until every item is done.

## Requirements traceability

| # | Requirement | Implementation | Proof (tests) |
|---|---|---|---|
| 1 | Beta code hashed, single use, expiry, status, audit | `SignupCode` holds the SHA-256 only, enforced by a CHECK. Expiry is 30 days max, statuses are ISSUED, RESERVED, CONSUMED, REVOKED and EXPIRED, and terminal states are final (trigger). Consumption writes `ORGANIZATION.CREATE` with the code id; the code row itself records issue, reservation, consumption and revocation. | `self-onboarding-postgres`, `signup-postgres`, `passkey-registration` |
| 2 | Anti-enumeration of organization discovery | No discovery endpoint. Passkey begin always answers 200 with the same fields, a fresh challenge and an **empty `allowCredentials` list**. No credential ID is sent before verification; discoverable passkeys are used, and every registration asks for one. There is a minimum response time. Completion has one generic refusal. This replaced the decoy credential IDs after finding F1 (2026-10-11): their length differed from real IDs. | `organization-login-postgres` (16-, 20-, 32- and 64-byte credential IDs; identical answers for known and unknown people) |
| 3 | Rate limiting | `RateLimitBucket` and `luxia_rate_limit_hit` store a peppered hash and never an address. Limits apply to sign-in (begin, complete, Microsoft), signup, invitation acceptance and creation, and DNS checks. The check fails closed. | `self-onboarding-postgres`, `organization-login-postgres`, `domains-invitations-postgres` |
| 4 | Slug unique, normalized, immutable | Unique index, format CHECK and reserved words. A trigger makes it immutable for every role. A change needs the explicit procedure in the migration doc. | `self-onboarding-postgres`, `organization-login-contract` |
| 5 | Atomic or compensable founder creation | A single transaction. The code is consumed inside it by `luxia_signup_consume`. | A failure injected at the last authority step leaves no organization and the code still usable (`signup-postgres`) |
| 6 | No usable organization without a first admin | The organization exists only in the transaction that creates the founder and their admin access. | `signup-postgres` |
| 7 | No admin authority from browser data | Entitlement keys come from `LUXIA_ORG_ADMIN_V1` and `GOVERNANCE_ADMIN_V2` only. Extra request fields are ignored. | `signup-postgres` (role and entitlement fields injected and ignored), `passkey-registration` |
| 8 | Invitations: opaque hashed token, single use, 7 days, revocable, tenant scoped, audited | 32-byte token in the URL fragment, shown once, hash stored (CHECK). The database sets the expiry to exactly 7 days. Forced RLS. Events: `INVITATION.CREATE`, `REVOKE` and `ACCEPT`. | `self-onboarding-postgres`, `domains-invitations-postgres` |
| 9 | Acceptance cannot choose tenant, role or privilege | Lookup by token hash only (`luxia_invitation_resolve`). Tenant, person and role come from the row and are immutable (trigger). An admin invitation needs `assignments.manage`, and the inviter must still hold it at acceptance. | `domains-invitations-postgres` (escalation refused, inviter losing authority, injected fields ignored) |
| 10 | DNS: random challenge, expiry, revalidation | 32-byte challenge shown once, hash stored, 7-day expiry, renewable. A vanished record turns VERIFIED into LOST. | `domains-invitations-postgres`, `onboarding-contract` |
| 11 | Verified domain unique across organizations | Partial unique index `lower(domain) WHERE status = 'VERIFIED'`, not RLS scoped. | `self-onboarding-postgres`, `domains-invitations-postgres` |
| 12 | Legrand Tech → `legrand-tech`, data unchanged | Explicit `UPDATE` before `NOT NULL`. | Drill on a scratch database: digest of 45 tables identical (`self-onboarding-postgres`) |
| 13 | Forced RLS, cross-tenant tests, rollback/forward-fix | Forced RLS on the 5 tables, with no policy on the internal ones. | Cross-tenant tests in both directions. Rollback rehearsed: data and schema identical, and it refuses once data exists. |
| 14 | No Microsoft provider chosen globally or by first result | The `findFirst` calls on the login page and in the Graph lookup are gone. The rule is exactly one connection of the organization's single tenant, otherwise refused. | `organization-login-postgres` (two connections, two tenants), `organization-login-contract` (repository-wide scan) |
| 15 | Nothing observable before authentication from a slug | The login page reads nothing. Signup reveals that an identifier is taken only to a valid code holder. Invitation begin shows the organization name only to a token holder. | `organization-login-postgres`, `signup-postgres` |
| 16 | No fake email or "sent" state | The only action offered is "Copier le lien d'invitation". The status reads "Invitation créée, en attente d'acceptation". | `onboarding-contract` |
| 17 | No Production change without review, CI and approval | This PR is a draft. | Not applicable |

## Decisions to confirm (operator)

1. **Fifth and sixth tables** (`RateLimitBucket`, single-row `RateLimitConfig`), needed by requirement 3 because there is no Redis or KV store.
2. **Residual risk on Microsoft sign-in**: a known organization with Entra redirects to Microsoft, an unknown one returns to the login page. This is inherent to federated sign-in. It is rate limited and shows no organization data.
3. **Hardware binding is not claimed** for passkeys created at signup or invitation. With attestation "none", it cannot be proven. The existing enrolment page still records `hardwareBound: true`, which is a separate pre-existing point to review.
4. **Members get no access** on acceptance; an administrator grants it afterwards. Administrators get the same bundle as the founder.
5. **Legrand Tech users** type `legrand-tech` once on the login page. The browser remembers it.

## Production certification plan (after approval only)

Release order: (1) rehearsal on an isolated Neon clone of Production; (2) Production migration; (3) deployment of the exact merge SHA; (4) real second organization.

| # | Proof required by the operator | How it is shown |
|---|---|---|
| 1 | Org A cannot see Org B, and B cannot see A | Signed in as each founder, the journal, identities, domains and invitations show only their own data. Cross-checked by a read-only database count per organization. |
| 2 | An unknown slug reveals nothing | `/api/auth/local/begin` gives the same status, shape and timing for an unknown slug, a known slug with an unknown identifier, and a known one. A Microsoft attempt with an unknown slug returns to `/login?error=signin`. |
| 3 | A beta code cannot be replayed | Second signup with the same code: `SIGNUP_CODE_INVALID`. Database: status `CONSUMED`, one organization. |
| 4 | An invitation cannot be replayed | Second opening of the link: `INVITATION_INVALID`. |
| 5 | An invitation cannot escalate privileges | A member invitation accepted with injected `role`, `tenantId` and `organization` fields: no assignment. Database: role and tenant unchanged. |
| 6 | A verified domain cannot be claimed twice | The same domain added by the second organization gets `DOMAIN_VERIFIED_ELSEWHERE`. |
| 7 | Founder creation cannot leave partial authority | Database: one organization, one founder, exactly the 21 catalog assignments, 4 audit events. No other subject holds admin rights. |
| 8 | The second organization signs in independently | Founder passkey sign-in on its own identifier, with VERIFIED evidence in its own journal. |
| 9 | Legrand Tech works unchanged | Business-data digest identical before and after the migration (the `Organization` row is compared without `slug`). Microsoft and passkey sign-ins with `legrand-tech`. Journal and dashboard unchanged. |
| 10 | Rollback ready | Previous deployment kept READY. Migration rollback script refused once the second organization exists (forward-fix only). |
