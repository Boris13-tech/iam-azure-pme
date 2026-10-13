# LUXIA Sovereign Provider & Federation Layer: design (rewrite of PR #12)

Status: **APPROVED by the operator on 2026-10-13** (decisions in section 9).
- No migration and no Production change before each phase is rehearsed and passes its gate.
- F1 may start.

Origin: operator decision of 2026-10-13.
- PR #12 joins the critical path to commercial launch. It is **never merged as it stands**: it is rewritten on today's `main`.
- **The principle: providers plug into LUXIA; LUXIA does not depend on them.**
- Commercial order: E1 → **PR #12 Sovereign Providers** → Ops/Monitoring → final legal review → pilot offer → 3 to 5 customers → billing, SLA, pentest → GA.

Evidence labels: VERIFIED (read in the code or the database), ASSUMPTION (to confirm).

## 1. The ten rules, made testable

| # | Operator rule | Invariant the code must hold | Proof (test or certification) |
|---|---|---|---|
| R1 | Authority lives in LUXIA | A provider produces only a `VerifiedExternalIdentity`: issuer, connection, subject, display attributes. Nothing a provider returns can create, change or remove an `Assignment`, an `Entitlement`, a permission or a session scope | Architecture test: no adapter writes those tables. Postgres test: a provider claim of `groups`/`roles` changes nothing |
| R2 | Provider-neutral core | No `MICROSOFT_ENTRA`, `GOOGLE`, `graph.microsoft.com` or `tid` outside `lib/provider-adapters/implementations/*` | Architecture test (import and string scan of `lib/auth`, `lib/admin`, `app/api`) |
| R3 | LUXIA_LOCAL first-class | Passkey and recovery sign-in work with every external connection DISABLED or QUARANTINED, and with no outbound network | Postgres plus route test with the network stubbed to fail |
| R4 | Generic OIDC first | Entra and Google are **profiles** of one OIDC core: the same discovery, JWKS, code + PKCE, state, nonce and claim checks. A profile adds only an issuer template, a subject claim and extra claim checks | Contract test run against the generic core with each profile; live certification (section 7) |
| R5 | Offline / degraded continuity | A provider outage never revokes a valid LUXIA session. New sign-ins through that provider fail generically; local sign-in is unaffected; operations already authorized continue under their policy | Test: provider unreachable → existing sessions still resolve; sign-in returns the generic error |
| R6 | No automatic authority import | A group or role claim from a provider is ignored unless an **explicit, tenant-scoped, journaled, revocable mapping** exists. v1 has no mapping table at all; group sync is out of scope | Test: groups in the token are ignored; no table maps them |
| R7 | Tenant isolation | `ProviderConnection` and every new table: RLS **forced**, tenant-scoped reads and writes, connection usable only by its own organization | RLS suites across two organizations |
| R8 | Fail closed | Unknown issuer, metadata issuer ≠ configured issuer, invalid or unknown JWKS key, `alg=none` or an unexpected algorithm, wrong `aud`, expired token, nonce or state mismatch, Entra `tid` ≠ connection scope, connection not ACTIVE → the **same generic refusal** as an unknown organization | Negative test table, one case each |
| R9 | Evidence | Create, configure, activate, disable, quarantine, release, test, discovery dry run, secret rotation: each writes one `PROVIDER.*` journal event, with a French label (B5 guard) | Journal test plus the label guard (`activity-labels`) |
| R10 | Replaceability | An organization moves Entra → generic OIDC → private IdP **without touching its Subjects, Assignments or journal**: a new connection, re-linking of IdentityAccounts to the same Subjects, then the old connection disabled | Rehearsal on a clone: migrate a test organization from one connection to another; authority digest identical before and after |

Unchanged throughout: B1 (last administrator), B2 (recovery), B3 (organization status), B4/B5 (operator break-glass), T0 (append-only), RLS. The existing suites must stay green at every phase.

## 2. What `main` has today (VERIFIED, 2026-10-13)

**Already right (keep):**
- **Canonical authority:**
  - `Subject` ← `IdentityAccount(providerConnectionId, externalObjectId)`;
  - `Assignment`, `Entitlement` and `Session` belong to LUXIA;
  - `IdentityAccount` is unique per `(organizationId, providerConnectionId, externalObjectId)`.
- **Ports already in `lib/provider-adapters`:**
  - `ProviderAdapter` with declared capabilities;
  - `AuthenticationProvider` (begin, complete, logout, `VerifiedExternalIdentity`);
  - `SecretResolver` with `SecretLease`;
  - `ProviderAdapterRegistry`.
- **Entra sign-in** uses `openid-client` with a **tenant-pinned issuer** (`login.microsoftonline.com/{directoryTenantId}/v2.0`), with PKCE, state and nonce.
- **LUXIA_LOCAL:** passkeys, recovery codes, a recovery-only session.

**Provider-centric or fragile spots on `main`, to fix in this work:**

| # | Where | Problem |
|---|---|---|
| M1 | `lib/auth/organization-login.ts` `resolveLoginOrganization` | Returns `entraConnectionId` and `localConnectionId`, hard-coded: the core knows Entra by name (R2) |
| M2 | `microsoft-entra/connection-config.ts` | Client id and secrets come from per-connection environment variables, then **fall back to global variables** (`GRAPH_CLIENT_ID`, `ENTRA_AUTH_CLIENT_SECRET`, …). Every organization without its own variables shares one credential (R7). A secret per tenant in deployment variables does not scale either |
| M3 | `ProviderConnection` | No status, no configuration, no kill switch; **RLS not forced** (table listed without FORCE in the 2026-10-13 inventory) |
| M4 | `lib/jwt.ts` → `microsoft-entra/token-verifier.ts` | Legacy verifier: shared JWKS (`common`), issuer accepted by prefix, any tenant. **Not called at runtime** (only an architecture test cites it) → delete |
| M5 | `ProviderType` | No `OIDC_GENERIC`. `CUSTOM` exists but has no contract |

## 3. PR #12, file by file

PR #12: `feat/providers-management-v1` @ `d604a48`, base 2026-10-03, 141 commits behind `main`, 46 files, +2823 lines, conflicting.
- **Reuse** = keep the idea or the code, adapted to the new contract.
- **Rewrite** = the need is right, the form is wrong.
- **Obsolete** = superseded.

This first pass is based on reading the main files. Each "reuse" is re-read line by line when its phase starts.

| Files | Verdict | Why |
|---|---|---|
| `lib/provider-adapters/implementations/managed-http/oidc-http.ts` | **Reuse** (core) | SSRF guard: public IPv4 only, the resolved address pinned with TLS on the host name, no redirects. It becomes the HTTP transport of the OIDC core |
| `lib/provider-management/token-manager.ts`, `scoped-token-store.ts` | **Reuse** (concept) | Ephemeral token cache, single flight, the scope checked again even on a cache hit, an allow-list of audit metadata |
| `entra-token-acquirer.ts` | Reuse inside the Entra profile | Client credentials for directory reads, UUID checks |
| `docs/operations/PROVIDER-DENIAL-AUDIT-V1.md` + `tests/certification/provider-denial-audit-rls.test.ts` | **Reuse** (rule) | Every refusal journaled **before** any network call, and fail closed if the journal fails |
| `scripts/provider-certification/*` (7) + `scripts/setup-provider-certification-runtime.cjs` | Reuse the harness, rewrite the secrets | Live certification with a guard that fails if a secret appears in any output; secret injection moves to the SecretStore port |
| `tests/provider-adapters/oidc-ssrf.test.ts`, `token-manager.test.ts`, `token-custody-architecture.test.ts` | Reuse | Their intentions remain valid |
| `lib/provider-management/contracts.ts` | **Rewrite** | Provider-centric core: `clientId` must be a UUID (Entra), and the attribute mapping is limited to `userPrincipalName` and `primaryEmail`. Secret references are environment-variable names |
| `lib/provider-management/service.ts` | Rewrite | The pattern stays (`withTenantDb`, `changeId`, journal); the model changes (section 5) |
| `managed-http/driver.ts`, `versioned-entra-driver.ts` | **Rewrite** | One driver branching on the provider type (Entra Graph, Google Directory, OIDC). Replaced by one adapter per profile behind the generic contract |
| `app/api/canonical/provider-management/**` (4) | Rewrite | `requireCanonicalAccess("providers", …)` and `changeId` stay; the endpoints follow the new lifecycle |
| `app/dashboard/providers/**` (2), `app/dashboard/layout.tsx` | **Rewrite** | Written before the interface overhaul of 2026-10-10; Microsoft Entra selected by default; LUXIA_LOCAL missing |
| `prisma/migrations/20261003000000_…`, `20261004090000_…` | **Obsolete** | Dated before the 25 applied migrations, and an obsolete model. Re-created |
| `prisma/schema.prisma` (+67) | Rewrite | No QUARANTINED state; `enabled` only drives management, not sign-in (no kill switch) |
| `docs/operations/*` (4 others) | Input only | The live certification method and the token management notes are worth re-reading |
| `.github/workflows/ci.yml`, `lib/admin/canonical-administration.ts`, `app/api/canonical/providers/route.ts` | Obsolete | Superseded by `main` |
| Other tests (provider-management RLS, contracts, managed driver, live runner, preflight, token store RLS) | Rewrite against the new model | Their intentions are kept, re-expressed for the new contract |

**Proposal:**
- once this design is approved, **close PR #12** with a note pointing here;
- **keep the branch** as a reference and never delete it.

Any change to PR #12 waits for the operator's approval.

## 4. Target architecture

### 4.1 Layers

1. **Core:** organizations, Subjects, IdentityAccounts, assignments, sessions, journal, policies. It knows "a connection of type X in state Y", never a provider by name.
2. **Federation port:**
   - `FederationProvider.begin(connection) → redirect`;
   - `complete(connection, callback) → VerifiedExternalIdentity`;
   - `test(connection) → health`;
   - `discover(connection) → dry run` (optional capability).
3. **Adapters:**
   - `LUXIA_LOCAL` (unchanged);
   - **`OIDC_GENERIC` (the core)**;
   - profiles `MICROSOFT_ENTRA` and `GOOGLE_WORKSPACE` on top of it;
   - later SAML, SCIM and LDAP behind the same port.
4. **Secret port:** `SecretStore.resolve(reference) → SecretLease`, with adapters (section 4.6).

### 4.2 Generic OIDC core

**Configuration (not secret, validated by the profile):** issuer, client id, secret reference, allowed algorithms, claim of the stable subject, scopes.

**Discovery:**
- `.well-known/openid-configuration` is read through the SSRF-guarded transport;
- **the published issuer must equal the configured issuer exactly**;
- every endpoint must be HTTPS on a public host.

**Keys:**
- the JWKS is cached with an expiry;
- an unknown `kid` triggers at most one reload, rate limited;
- `alg` must be in the configured list (RS256 by default, never `none` or HS*).

**Flow:**
- authorization code with PKCE S256, single-use state and nonce, both bound to the browser and to the connection;
- `openid-client` stays the implementation; it is already a dependency.

**ID token checks:**
- `iss` and `aud` exact;
- `azp` when there are several audiences;
- `exp`, `nbf`, `iat` with 120 s of tolerance;
- nonce.

**Identity:** `(providerConnectionId, subject claim)`. Never e-mail as the identity key, because e-mail can be reassigned.

**Refusals:** every refusal returns the generic error of the sign-in page. The precise reason goes to the sign-in evidence (`AuthenticationEvidence`, `REJECTED`) and to the journal, never to the browser.

### 4.3 Profiles

| Profile | Issuer | Subject claim | Extra checks |
|---|---|---|---|
| `OIDC_GENERIC` | configured | `sub` | none |
| `MICROSOFT_ENTRA` | `https://login.microsoftonline.com/{directoryTenantId}/v2.0` | `oid` | `tid` = directory of the connection; the `common` and `organizations` endpoints are never used |
| `GOOGLE_WORKSPACE` | `https://accounts.google.com` | `sub` | `hd` = the verified domain of the connection |
| Private IdP (Keycloak, Authentik, …) | `OIDC_GENERIC` with an operator issuer policy | `sub` | private address allowed **only** by an explicit, journaled operator policy (rule R10) |

### 4.4 Connection lifecycle (kill switch)

**States:**

| From | Action | To |
|---|---|---|
| DRAFT | `test` | TESTING |
| TESTING | `activate` | ACTIVE |
| ACTIVE | `disable` | DISABLED |
| DISABLED | `activate` | ACTIVE |
| ACTIVE | `quarantine` | QUARANTINED |
| QUARANTINED | `release` | DISABLED |

What each state allows:
- **Sign-in through a connection is accepted only in ACTIVE.** This check sits in the core, in the same place as B3's organization status.
- DISABLED and QUARANTINED answer exactly like an unknown organization.
- **DISABLED:** no new sign-in. Existing sessions continue until they expire (R5).
- **QUARANTINED:** no new sign-in, and **the sessions opened through that connection are revoked**. Proposal; the operator decides (D3). It is the security switch for a compromised IdP.
- Every transition runs under the organization's governance lock, and is journaled.
- **Disabling or quarantining a connection never deletes a Subject, an IdentityAccount or an Assignment.**
- **LUXIA_LOCAL can be neither disabled nor quarantined while an organization's last durable administrator depends on it** (B1 extended).

### 4.5 Attributes, groups and authority

- Allowed attributes: display name, e-mail as contact information, preferred user name. They are stored as **display data**.
- Group and role claims are **ignored** in v1, and the evidence does not even record them.
- A future group mapping (v2) will be a separate decision, with its own table:
  - tenant-scoped;
  - one explicit, journaled and revocable row per group → entitlement link;
  - subject to SoD;
  - never active by default.

### 4.6 Secrets by reference

- The database stores only a **reference**, for example `kv://luxia-bkp-kv-284e/oidc-<connection>` with a version, never a value.
- **Adapters:**
  - `AzureKeyVaultSecretStore`, available now, in France Central;
  - `EnvironmentSecretStore` for development and CI only, **refused in Production**;
  - later, other sovereign stores.
- **Removed:**
  - the fallback to global environment variables (M2);
  - environment-variable names as references (#12).
- Resolution goes through the existing `SecretLease`: the value is used in memory and never logged.
- **Rotation:**
  - `candidateVersion` → test → `activeVersion`;
  - `PROVIDER.SECRET.ROTATE` is journaled;
  - #12's credential-version idea is kept.

### 4.7 Isolation

- `ProviderConnection` gets **FORCE ROW LEVEL SECURITY**, with tenant policies.
- The new tables (`ProviderConnectionState`, `ProviderSecretReference`, `ProviderTestRun`) get the same RLS.
- Every operation goes through `withTenantDb`.
- The sign-in route reads only the connections of the organization named by its slug, as today.

### 4.8 Journal

| Event | When |
|---|---|
| `PROVIDER.CONNECTION.CREATE` | creation (DRAFT) |
| `PROVIDER.CONNECTION.CONFIGURE` | configuration change, with a hash of the new configuration |
| `PROVIDER.CONNECTION.TEST` | test, with its result |
| `PROVIDER.CONNECTION.ACTIVATE` | |
| `PROVIDER.CONNECTION.DISABLE` | |
| `PROVIDER.CONNECTION.QUARANTINE` | with the number of sessions revoked |
| `PROVIDER.CONNECTION.RELEASE` | |
| `PROVIDER.SECRET.ROTATE` | reference and version only |
| `PROVIDER.DISCOVERY.DRY_RUN` | counts only |
| `PROVIDER.<operation>.DENIED` | every refusal, journaled **before** any network call (#12) |
| `IDENTITY.ACCOUNT.RELINK` | the R10 move |

Every event has its French label, enforced by the B5 guard.

### 4.9 Replaceability (R10)

To move an organization from connection A to connection B:
1. Create B and test it.
2. **Re-link.** For each IdentityAccount of A, an administrator confirms its link to a B identity. The proposal comes from a verified claim (for example the same verified e-mail), never decided automatically.
3. Activate B.
4. Disable A.

The Subjects, Assignments, journal and recovery codes do not move.

**Proof:** a digest of the organization's authority (Subjects, Assignments, Entitlements), identical before and after, on a clone.

## 5. Data model delta (outline, not final SQL)

- `ProviderType`: add `OIDC_GENERIC`. Whether to remove `CUSTOM` is decided by usage (D6).
- `ProviderConnection`:
  - new columns: `status` (enum above, default DRAFT; **existing ACTIVE connections migrated to ACTIVE**), `statusChangedAt`, `configuration` (JSONB validated per profile), `configurationHash`, `issuer`, `clientId`, `subjectClaim`, `allowedAlgorithms`;
  - FORCE RLS.
- `ProviderSecretReference`: connection, purpose (`oidc-client`, `directory-read`), store, reference, `activeVersion`, `candidateVersion`, `revokedAt`. RLS.
- `ProviderTestRun`: results of tests and dry runs, counts and safe codes only. RLS, append-only (T0 style).
- `Session`: `providerConnectionId` exists through the IdentityAccount. QUARANTINE revokes through the B3/B4 path (append-only revocation).
- **No group-mapping table in v1.**

Each migration follows the house rule:
- expand first;
- a written, rehearsed rollback;
- a clone rehearsal;
- data unchanged except the new columns;
- an operator gate before Production.

## 6. Phases

| Phase | Content | Visible change for customers |
|---|---|---|
| **F0** | This design, then the operator's decisions | none |
| **F1** | Extract the generic OIDC core from today's Entra gateway. Make Entra a profile. Delete M4. Generalize M1 to "the ACTIVE connections of the organization". **No change in behaviour**, proven by regression and a live Entra certification | none |
| **F2** | Connection lifecycle and sign-in kill switch, FORCE RLS on `ProviderConnection`, the `PROVIDER.*` journal with labels. Migration plus rehearsal | administrators can disable or quarantine a provider |
| **F3** | SecretStore with Azure Key Vault. Remove the global environment fallback (M2). Move the existing Entra secret into the vault | none (secrets move) |
| **F4** | Generic OIDC connections created by an administrator, with tests and the admin UI (rewritten); certification on a real generic OIDC IdP | new: sign in with any compliant OIDC IdP |
| **F5** | Management: connection test and directory discovery as a dry run, reusing #12's concepts (journaled denial before the network, token custody) | visible test results |
| **F6** | Google Workspace profile | Google sign-in |
| Later | SAML, SCIM, LDAP live; group mapping (v2) | separate decisions |

**Order of value:**
- F1 and F2 make the core sovereign and give the security switch;
- F4 is the commercial promise ("any compliant IdP");
- F6 is a convenience.

## 7. Certification plan

| Target | How | Who |
|---|---|---|
| LUXIA_LOCAL | Existing suites, plus R3: every external connection disabled, no network | Claude, CI and a clone |
| Microsoft Entra | Live sign-in on the operator's tenant after F1, on Preview then Production, plus the negative cases (wrong `tid`, tampered token, replayed state) | Claude and the operator (human sign-in) |
| Generic OIDC | Live sign-in against a real compliant IdP (D2), plus the negative table of section 1 (R8) | Claude and the operator |
| Replaceability | Clone rehearsal: a test organization moved Entra → generic OIDC, authority digest identical | Claude |
| Isolation | RLS suites across two organizations for every new table | CI |

## 8. Risks

| Risk | Mitigation |
|---|---|
| F1 breaks the operator's real Entra sign-in | No behaviour change, regression, a Preview deployment, then a human sign-in; rollback by redeploying the previous release (no migration in F1) |
| A QUARANTINE that revokes too much | Revocation scoped to sessions of that connection only; a dry run first (count), as in B4 |
| Secrets moved to Key Vault leave Azure as a single dependency (it already holds the backups) | The SecretStore is a port: a second store is possible. Sign-in itself never needs Azure (only the client secret does, and it is cached as a lease) — ASSUMPTION, to measure in F3 |
| The scope of a generic IdP is very large (vendor differences) | Strict OIDC only (code + PKCE, a signed ID token). Implicit and hybrid flows are refused. Each vendor proven by certification, not assumed |

## 9. Decisions for the operator

**Decided on 2026-10-13, confirmed directly:**
- D1: approved;
- D2: Google as plain OIDC, plus a temporary self-hosted Keycloak in the EU;
- D3: QUARANTINE revokes the sessions of the connection, after a dry run that counts them;
- D5: close PR #12 and keep its branch.

D4 and D6 follow the recommendations below.


| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve the ten invariants (section 1), the target architecture and the phases F0 to F6 | Yes |
| D2 | Which real IdP certifies "generic OIDC" in F4 | **Two:**<br>• a free public OIDC (Google accounts as plain OIDC), at no cost;<br>• a self-hosted Keycloak in the EU, to prove the private IdP (R10), only for the certification time (a few euros).<br>Avoid paid US identity platforms for this proof |
| D3 | QUARANTINE also revokes the sessions opened through the connection | Yes, with a dry run that counts them first |
| D4 | Secret store for provider secrets | Azure Key Vault now (already in place, France Central), behind a port. Re-evaluate an EU-law store when hosting moves |
| D5 | Close PR #12 after approving this design, and keep its branch | Yes |
| D6 | The fate of `ProviderType.CUSTOM` | Keep it unused until a census in F2 decides |
