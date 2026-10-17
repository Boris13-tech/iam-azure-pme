# Trust-boundary registry

Standard, section 6. A PR that creates, removes or changes a boundary updates this registry in the same PR.

| Item | State |
|---|---|
| Initial content | Built on 2026-10-17 from the repository and recorded operator evidence. Each entry gives its controls with references and its assurance state (standard, section 2) |
| Public repository rule | A boundary's weaknesses that are not yet fixed are kept in the private record. An entry may say "further assessment held privately" without detail |

Columns:
- **AuthN / AuthZ:** how each side is authenticated and what it is allowed to do;
- **Failure:** the behaviour when the other side fails;
- **Evidence:** what is recorded;
- **State:** the assurance state today.

## Runtime boundaries

| ID | Boundary | What crosses | AuthN / AuthZ | Validation | Failure | Evidence | Tests | State |
|---|---|---|---|---|---|---|---|---|
| TB-01 | Browser → application (Vercel) | Sign-in flows, session cookie, administrator API calls | Session cookie (HttpOnly, Secure, SameSite=Lax, hashed at rest). Administrator API: session, then native permission check; mutations need a change ID header | Server-side organization resolution from the slug; same-origin `returnTo`; zod schemas on the API | Generic answers before authentication; rate limits on sign-in starts | Sign-in evidence; administrator journal (append-only) | `tests/security/*`, `tests/resources/*-postgres.test.ts` | PRODUCTION VERIFIED (F1, F2, B-series) |
| TB-02 | Application (`app_user`) → PostgreSQL | Every runtime query | `app_user` with NOSUPERUSER, NOBYPASSRLS; organization context set per transaction (`withTenantDb`) | FORCE row-level security on tenant tables; CHECK constraints; guard triggers | A query outside its scope returns nothing or is refused (fail closed) | Database guards raise stable codes | RLS suites across organizations; function-privilege gate; architecture test of unscoped reads | PRODUCTION VERIFIED (M2 and earlier) |
| TB-03 | Operator and migration role → PostgreSQL | Migrations, gate tools, read-only checks | Owner role (bypasses RLS), used only by gate tools and migrations | Gate tools refuse on drift; Production reads in READ ONLY transactions | Rollback scripts refuse when in use | Sealed gate evidence (private store), closures | CI drills of every rollback since B2 | PRODUCTION VERIFIED for the gates run (M1, M2, F3); further assessment held privately |
| TB-04 | Backup pipeline → PostgreSQL and backup storage | Full logical backups | Dedicated backup role, read-only on data; backups encrypted to a recipient key; by operator rule the private key is never committed, logged, stored with the backups or in Production (custody: backup design) | Inventory of tables, objects and migrations compared after restore | A missed or failed backup is detected by the freshness alert (E4); catch-up not yet proven | Backup inventory per run | CI backup round trip; restore drill B (E1) | PRODUCTION VERIFIED (E1). A 4-hour RPO is not guaranteed (standard, I6) |
| TB-05 | Application → Microsoft Entra (OIDC) | Discovery, keys, token exchange; ID token back | Per-directory issuer pinned; code + PKCE S256; state, nonce, audience, signature, algorithm checked by the F1 core; `oid` as subject; client secret from the platform environment (vault planned, F3) | Exact issuer from discovery; claims mapped to identity only, never authority | Generic refusal; existing sessions unaffected | Sign-in evidence (provider-attested) | `tests/provider-adapters/oidc-core.test.ts`, Entra contract and parity tests, callback tests | PRODUCTION VERIFIED (F1) |
| TB-06 | Application → generic OIDC providers (F4) | As TB-05, to an issuer chosen by a customer administrator | Every request through the SSRF-guarded transport (HTTPS 443, public addresses only, pinned resolution, no redirects, size and time limits); client secret only by F3 reference | Connection test, proof sign-in, activation evidence enforced by the database | Generic refusal; outage never revokes a session | Test runs (append-only), journal, sign-in evidence | F4 S1–S5 suites (CI) | IMPLEMENTED off Production (#76–#80); not in Production |
| TB-07 | Application → secret store | Provider client secrets | Today: platform environment (Production only). Planned: vault by reference, workload identity federation restricted to Production | References are locators only (database CHECKs); leases redact themselves | Planned: short cache with a stale-if-error window, then fail closed for that connection only | Planned: vault audit log | F3 secret-store suites (CI) | References table PRODUCTION VERIFIED (empty); vault DESIGNED (KV decisions taken, no resource yet) |
| TB-08 | Passkey authenticator (browser WebAuthn) → LUXIA_LOCAL | Registration and assertion ceremonies | WebAuthn ceremony verified server-side (challenge, origin, RP ID, signature, counter) | No client-chosen key accepted without a ceremony (#64) | Generic refusal; no enumeration of credentials | Sign-in evidence with honest assurance flags | Local adapter contract and crypto tests; route tests | PRODUCTION VERIFIED (#64) |
| TB-09 | Person → recovery and break-glass | Recovery codes; operator break-glass procedure | Recovery codes single use, rate-limited, giving a RECOVERY-scoped session only; break-glass through the written B4 procedure | Allow-listed recovery session scope | Limits, never a lockout of the person | Journal events with labels | B2 and B4 suites | PRODUCTION VERIFIED (B2, B4) |

## Delivery and operations boundaries

| ID | Boundary | What crosses | Controls (summary) | State |
|---|---|---|---|---|
| TB-10 | Repository → CI (GitHub Actions) | Code, workflows, CI secrets | Lockfile with `npm ci`; secret scanning with push protection; Production workflows restricted to explicit triggers. Further assessment held privately | PARTIAL (see the gap analysis) |
| TB-11 | Repository → hosting (Vercel) → Production | Builds, environment variables, deployments | Deployments of an exact commit by the operator's tool, the previous deployment recorded as the rollback target; Production-only variables separated from Preview (containment applied 2026-10-14). Further assessment held privately | PARTIAL |
| TB-12 | External scheduler → backup workflow | Hourly dispatch of the backup | The dispatch triggers only the backup workflow on the default branch; a gate skips redundant scheduled runs | PRODUCTION VERIFIED (skip path); catch-up path never observed |
| TB-13 | Operator workstation → Production tools | Gate scripts, read-only checks, CLI credentials | Short-lived CLI tokens; evidence written outside the repository; READ ONLY by default. Further assessment held privately | PARTIAL |

## Third-party services in the trust chain

| Service | Role | Region (VERIFIED where recorded) | Boundaries |
|---|---|---|---|
| Vercel | Hosting, build, environment variables | See `docs/operations/HOSTING-EU-AND-COSTS.md` | TB-01, TB-11 |
| Neon | PostgreSQL (Production and clones) | See `docs/operations/HOSTING-EU-AND-COSTS.md` | TB-02, TB-03, TB-04 |
| GitHub | Repository, CI, backup workflow | n/a | TB-04, TB-10, TB-12 |
| Microsoft Entra ID | Federated sign-in for organizations that use it | n/a | TB-05 |
| Azure | Backup schedule, key custody; Key Vault planned (France Central, KV2) | France Central (planned vault) | TB-04, TB-07, TB-12 |
