# LUXIA Identity — Customer Self-Onboarding v1: scope proposal

Status: **PROPOSAL, awaiting operator validation.** No code, migration or Production change is part of this document.
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
