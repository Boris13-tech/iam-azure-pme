# LUXIA Identity — Customer Self-Onboarding v1: scope proposal

Status: **VALIDATED and SHIPPED.** The operator validated this scope (decisions O1 to O5 and the 17 mandatory requirements of section 9), as recorded in `docs/architecture/CUSTOMER-SELF-ONBOARDING-V1.md`. It shipped in PR #32 (`6f9de76`) and PR #35 (finding F1), and was certified in `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md` and `docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`. This file is the record of the approved scope as written before the code. Later changes are in the architecture and certification documents, not here.

Original status: proposal awaiting operator validation; no code, migration or Production change was part of this document.
Baseline: `main` @ `b506c97`, Production `dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW`.

## 1. Observed state (code and Production, 2026-10-10)

| Onboarding step | Today | Evidence |
|---|---|---|
| Create Organization / Tenant | **Operator only** (SQL script) | only `scripts/production-identity-bootstrap-apply.sql` and test scripts insert into `Organization` / `Tenant` |
| Establish first admin | **Operator only** (bootstrap script plus `LUXIA_ORG_ADMIN` bundle) | `scripts/canonical-admin-v1-production.ts`, `lib/auth/native-role-catalog.ts` |
| **Sign in when more than one customer exists** | **Not possible** | `app/login/page.tsx` takes the **first** `MICROSOFT_ENTRA` and the first `LUXIA_LOCAL` connection in the whole database (`findFirst`, no organization filter). A second customer would be routed to the first one. |
| Verify domain | **Absent** | `Organization` has no domain field |
| Invite team | **Absent** | An admin can create a person (JML) but cannot give them a way to sign in: passkey enrolment requires an existing session, and linking Entra requires knowing the user's object id |
| Configure auth / connect provider | Partial | `POST /api/canonical/providers` exists. Live Entra / Google / OIDC certification is blocked in PR12. |
| Register resources, define entitlements, assign access, governance | **Available** in the product | Resources, onboarding, SoD, Access Reviews pages |
| Audit of every step | Available | Security Journal v1 (certified) |
| Email delivery | **Absent** | no email library or provider |

Conclusion: the steps **before** the first sign-in (organization, first admin, routing, invitations) are missing. The steps **after** it largely exist.

## 2. Goal of v1

A new company can go from nothing to a working, administered environment **without SQL, Neon access, operator scripts or LUXIA support**:

> Create organization → first admin with a passkey → sign in to *its own* organization → verify its domain → invite its team (passkeys) → (existing) resources, entitlements, access, governance

Every step is recorded in the Security Journal.

## 3. Scope

| # | Feature | What it does | Security notes |
|---|---|---|---|
| F1 | **Organization-aware sign-in** (blocker) | The login page asks for the organization identifier (a unique, readable slug, e.g. `legrand-tech`, remembered in the browser). It then offers only that organization's sign-in methods. `findFirst` over all organizations is removed. | No organization enumeration: an unknown slug looks the same as a known one with no methods. Existing Production: `legrand-tech` is assigned by migration. |
| F2 | **Signup by beta code** | Public page "Créer une organisation", gated by a **single-use signup code** issued by the LUXIA operator (private beta). One atomic transaction creates the Organization, its Tenant, the founder Subject, the LUXIA_LOCAL identity and the founder's **passkey**, then grants `LUXIA_ORG_ADMIN` and the governance bundle. | The code is single-use, expiring, stored hashed, and consumed atomically. This is the explicit first-admin ceremony; there is no implicit owner and no other path. Everything is audited (`ORGANIZATION.CREATE`, `ORGANIZATION.FIRST_ADMIN`). |
| F3 | **Domain verification (DNS TXT)** | An admin adds a domain, receives a TXT value (`luxia-verification=…`), then LUXIA checks DNS. The domain becomes **verified**. | A domain can be verified by only one organization. Verified domains are a prerequisite for later email-domain discovery and provider binding. No email needed. |
| F4 | **Team invitations by link** | An admin invites a person (name, role: member or admin). LUXIA creates the Subject in `PROVISIONING` and a **single-use invitation link** that the admin copies and sends. The invitee opens it, chooses an identifier and enrols a passkey. The identity becomes `ACTIVE` with the chosen baseline access. | The token is single-use, expires after 7 days, is stored hashed, and is bound to the organization, tenant and subject. Revocable. Audited (`INVITATION.CREATE / ACCEPT / REVOKE`). Granting admin requires `assignments.manage`. |
| F5 | **Onboarding checklist** | Real-data checklist on the overview: domain verified, second admin present, team invited, first resource registered, first review campaign. Each item links to its page. | Computed from canonical data, no score |

### Out of scope (v1)

| Item | Reason |
|---|---|
| Fully open signup (no code) | Needs abuse protection (rate limiting, CAPTCHA-free proof, email verification). Private beta first. |
| Email delivery of invitations | No email infrastructure; a provider choice is needed (later slice) |
| "Sign in with Microsoft" for new customers, Entra/Google/OIDC/SCIM provisioning | Depends on PR12 live certification and a multi-tenant app registration |
| Email-domain discovery at login | Comes after F3 (verified domains) |
| Billing, plans, legal acceptance | Later roadmap phases |
| Several tenants per organization created by the customer | v1 creates one tenant ("Production") per organization |

## 4. Data model changes (migrations: necessity demonstrated, approval requested)

| Change | Why | RLS |
|---|---|---|
| `Organization.slug` (unique, readable) plus a data migration for `legrand-tech` | F1 routing (identifiers are unique per tenant only, not globally) | organization-level read for the login lookup only, through a narrow SECURITY DEFINER function (as `resolve_session` does) |
| `SignupCode` (hash, expiry, consumedAt, issuedBy) | F2 | operator-managed, no tenant |
| `OrganizationDomain` (domain, status, txtToken hash, verifiedAt) | F3 | tenant/org scoped, forced RLS |
| `Invitation` (tokenHash, subjectId, role, expiresAt, acceptedAt, revokedAt) | F4 | forced RLS, plus a SECURITY DEFINER lookup by token hash for the unauthenticated invitee |

No existing table is altered except `Organization` (one nullable-then-backfilled column). No data is deleted.

## 5. Security invariants kept

- Default deny, forced RLS on every new tenant table.
- `app_user` gets no new privileges beyond grants on new tables and EXECUTE on the narrow lookup functions (no PUBLIC EXECUTE).
- **No implicit first owner.** The founder is created only by the F2 ceremony.
- Single-use, expiring, hashed tokens.
- No enumeration of organizations, invitations or domains.
- Every step is audited in the Security Journal.
- No secret, token or IP stored.

## 6. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| O1 | Signup gating | **Single-use beta codes** issued by the LUXIA operator (fits the Private Beta phase) |
| O2 | Founder authentication | **Passkey (LUXIA_LOCAL)** at signup. Microsoft sign-in for new customers comes with PR12. |
| O3 | Approve the 4 migrations in §4 | **Yes** (each with forced RLS and tests) |
| O4 | Invitation delivery | **Link copied by the admin** in v1. Email comes later with a chosen provider. |
| O5 | Organization identifier at login | **Slug field on the login page, remembered in the browser**. Domain discovery comes later. |

## 7. Order and complexity

| Step | Content | Complexity |
|---|---|---|
| 1 | Migrations (slug, signup codes, domains, invitations) with RLS, grants and lookup functions; tests | M |
| 2 | F1 organization-aware login; Production keeps working with `legrand-tech` | M |
| 3 | F2 signup by code with atomic founder ceremony, plus an operator command to issue codes | L |
| 4 | F4 invitations (create, copy link, accept with passkey, revoke) | L |
| 5 | F3 DNS TXT domain verification | M |
| 6 | F5 onboarding checklist | S |
| 7 | Certification: a fresh organization created end to end in Production (beta code, founder passkey, domain TXT, invitation, invitee sign-in), isolation from Legrand Tech, journal evidence, DB cross-check | L |

## 8. Acceptance criteria

1. With two organizations in Production, each person signs in to **their own** organization only. An unknown slug reveals nothing.
2. A beta code creates exactly one organization with exactly one founder admin. A replayed or expired code is refused, and nothing is created.
3. A domain is verified only with the exact TXT record, and by at most one organization.
4. An invitation is accepted once and binds a passkey to the invited person only. Expired, revoked or replayed links are refused.
5. Every step appears in the Security Journal of the right organization, and nowhere else.
6. No SQL, Neon access or operator script is needed after the beta code is issued.
7. CI PASS on exact SHAs. Production certification uses a real new organization and an independent read-only database cross-check.

---

## 9. Mandatory security requirements (operator, 2026-10-10)

Validated with O1–O5 as recommended. These requirements are binding for the implementation:

1. Beta code: **hashed** in the database, single use, expiry, status and audit. **Never stored in clear.**
2. Organization discovery is **anti-enumeration**: the same response structure and comparable behaviour for a valid or unknown identifier.
3. **Rate limiting** on organization discovery, beta-code consumption, invitations and DNS verification.
4. Organization `slug`: unique, normalized, **immutable** (or changed only through an explicit procedure).
5. Organization + Tenant + founder Subject + IdentityAccount + passkey + admin entitlements: **atomic**, or compensable with no exploitable partial state.
6. No organization may exist in a usable state without a valid first administrator.
7. No admin authority may be granted implicitly from browser-supplied data.
8. Invitations: **opaque hashed tokens**, single use, 7-day expiry, revocable, tenant-scoped, audited.
9. Accepting an invitation can never select another tenant, role or privilege level than the one the invitation defines.
10. DNS verification uses a **random unique challenge with expiry and revalidation**. A typed domain is never considered verified.
11. **Global uniqueness** of a verified domain across organizations.
12. Legrand Tech → `legrand-tech` migration: explicit and tested, without modifying existing business data.
13. All four migrations: **forced RLS**, cross-tenant tests, documented rollback / forward-fix path.
14. No Microsoft provider chosen globally or by "first result" after this slice.
15. No data of an organization is observable before authentication just because its slug is known.
16. No fake email and no fake "invitation sent" state: v1 shows only **"Copier le lien d'invitation"**.
17. No Production deployment or Production migration without review, CI and explicit operator approval.

Implementation order: (1) migrations, RLS and backfill → (2) organization-aware login and anti-enumeration → (3) beta-code bootstrap → (4) founder passkey and first-admin authority → (5) DNS verification → (6) invitations → (7) checklist → (8) PostgreSQL/RLS/adversarial tests → (9) certification on a real second organization.

Production certification must prove:
- Org A cannot see Org B, and Org B cannot see Org A;
- an unknown slug reveals nothing;
- a beta code cannot be replayed;
- an invitation cannot be replayed and cannot escalate privileges;
- a verified domain cannot be claimed twice;
- founder creation cannot leave partial authority;
- the second organization can sign in independently;
- Legrand Tech continues to work unchanged.

## 10. Implementation design (how each requirement is met)

| Req. | Design |
|---|---|
| 1 | `SignupCode(id, codeHash = SHA-256(code), status ISSUED / RESERVED / CONSUMED / REVOKED / EXPIRED, expiresAt, issuedBy, consumedAt, organizationId)`. The code is shown once to the operator (operator CLI) and only its hash is stored. Consumption is a conditional update (`status` still usable and not expired) inside the founder transaction. Every state change is audited. |
| 2, 15 | **No discovery endpoint returning organization data.** The login page always shows the same two methods. The slug travels with the sign-in request, and the server resolves organization, tenant and connection itself. Passkey sign-in: begin returns the **same JSON shape** for a known or unknown slug/identifier, with a decoy challenge for unknown ones, and completion fails with the same generic error. No organization name, user or method list is ever returned before authentication. This also fixes a **pre-existing identifier enumeration** in passkey sign-in (unknown identifier answered with an error, known one with a challenge). |
| 2 (residual) | Microsoft sign-in: a known organization with an Entra connection redirects to Microsoft, while an unknown or non-Entra one returns the generic error. That redirect is inherent to federated sign-in (home-realm discovery). Mitigated by rate limiting, and no organization data is revealed. **Accepted residual risk, to be confirmed by the operator.** |
| 3 | `RateLimitBucket(keyHash, windowStart, count)`. **5th table, needed by requirement 3** (there is no Redis/KV). `keyHash = SHA-256(pepper, scope, client key)`, with the pepper generated in the database and readable only by a `SECURITY DEFINER` function. No raw IP is stored, and buckets expire with their window. Scopes: `login-begin`, `signup`, `invitation-accept`, `invitation-create`, `dns-verify`. |
| 4 | `Organization.slug` is unique and not null. Format: 3 to 40 characters, lower-case letters, digits and inner hyphens, trimmed and lower-cased, with a reserved list (`admin`, `api`, `login`, `luxia`, …). **Immutable in v1**: no update path, enforced by a database trigger. Any change needs a future, explicit operator procedure. |
| 5, 6, 7 | The WebAuthn ceremony takes two requests. *Begin* (code + slug + names + identifier) validates and **reserves** the code and stores the pending challenge on the `SignupCode` row; **no organization is created**. *Complete* (attestation) runs **one database transaction**: it verifies the attestation, consumes the code, then creates Organization, Tenant, LUXIA_LOCAL connection and tenant scope, founder Subject (ACTIVE), IdentityAccount, LocalIdentity, the passkey, and the `LUXIA_ORG_ADMIN` v1 and governance assignments, plus audit. Any failure rolls back everything. The admin entitlement keys come only from the **server-side catalog**, never from the request. |
| 8, 9 | `Invitation(id, tokenHash, organizationId, tenantId, subjectId, role MEMBER / ADMIN, invitedBy, expiresAt = +7 days, acceptedAt, revokedAt)` with forced RLS. The token is shown once, as a link to copy. Acceptance (begin/complete like the signup) resolves the invitation **only by token hash** through a `SECURITY DEFINER` lookup. Tenant, subject and role come from the invitation row, never from the request. Completion is one transaction: authenticator, identity, `PROVISIONING → ACTIVE`, the role's server-side entitlements and `acceptedAt`. Creating an ADMIN invitation requires `assignments.manage`. |
| 10, 11 | `OrganizationDomain(id, organizationId, tenantId, domain (normalized), status PENDING / VERIFIED / EXPIRED / LOST, challengeHash, challengeExpiresAt = +7 days, verifiedAt, lastCheckedAt)` with forced RLS. The challenge is 32 random bytes and appears **once** as TXT `luxia-verification=<value>`; it can be regenerated. Verification resolves TXT (`node:dns`) and compares hashes. Revalidation runs on demand: a missing TXT turns VERIFIED into LOST and releases the domain. A **partial unique index** on the lower-cased domain where `status = 'VERIFIED'` applies across all organizations. |
| 12 | The migration sets `slug = 'legrand-tech'` for organization `4841428a-80b4-4f07-bb3f-c94612dfd4a2` explicitly, before `NOT NULL`. Test: business-table digests are unchanged before and after. |
| 13 | Forced RLS on `OrganizationDomain`, `Invitation`, `SignupCode` and `RateLimitBucket`. The last two have **no app_user policy at all**; they are reachable only through definer functions. Cross-tenant tests for each. Rollback / forward-fix notes go in the migration directory. |
| 14 | All provider discovery without an organization filter is removed (`app/login/page.tsx`, and local begin accepting a client-supplied connection id). A test forbids reintroducing it. |
| 16 | The UI only offers "Copier le lien d'invitation", and the status reads "Invitation créée, en attente d'acceptation". There is no email, and the UI never shows "envoyée". |
| 17 | Production migration only through the existing gated path, after review, CI and explicit approval. |
