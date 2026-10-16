# F4: generic OIDC connections, created and tested by an administrator

Phase F4 of `SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md`:
- sections 4.2 to 4.4 and 4.9;
- phases table, F4 row: "sign in with any compliant OIDC IdP";
- decision D2: Google as plain OIDC, plus a temporary EU Keycloak.

| Item | State |
|---|---|
| This document | **DESIGNED**. Decisions F4-1 to F4-7 **taken by the operator on 2026-10-16**, F4-5 modified (section 9) |
| Code | In progress off Production, one draft PR per slice: S1 #76 (guarded transport), S2 #77 (data model), then S3 onwards |
| Production | Nothing from F4. F3's references table is in Production (empty, 2026-10-16). Activating a generic connection in Production still needs F3's vault (the client secret is read by reference) and the operator's gates |

Evidence labels:
- **VERIFIED:** read in `main` (`f395eeb`) or observed.
- **ASSUMPTION:** to confirm.

## 1. What `main` has today (VERIFIED, 2026-10-16)

| Area | State | Consequence for F4 |
|---|---|---|
| **Generic OIDC core** (F1, `lib/provider-adapters/implementations/oidc/gateway.ts`) | Code + PKCE S256, single-use state and nonce, discovery of the **exact** issuer, ID token verified against the issuer's JWKS (non-repudiation checks on), algorithm pinned (RS256, PS256 or ES256), configured issuer re-checked, subject claim per profile. The client secret is read through a lease (`SecretResolver`) | **Reused as is.** F4 adds no OIDC logic of its own |
| **Profiles** | `MICROSOFT_ENTRA` only (`oid`, `tid` = directory). `FEDERATED_SIGN_IN_PROVIDER_TYPES = ["MICROSOFT_ENTRA"]` | Add `OIDC_GENERIC` (`sub`) |
| **Configuration** | Entra's issuer comes from the connection's `externalScopeId`. Client id and secret come from global environment variables (finding M2, closed by F3) | A generic connection needs **its own** issuer, client id and secret reference, stored per connection |
| **Outbound requests** | **There is no SSRF guard anywhere.** The core fetches whatever issuer it is given | **Finding F4-S1 (P1 for F4):** once an administrator can type an issuer, the server fetches a URL chosen by a customer. It must never reach a private address, Azure's metadata service, the database, or loopback. The guard is the **first** slice |
| **Creating a connection** | `POST /api/canonical/providers` accepts nine types, including `CUSTOM`, with a free `externalScopeId`. Non-local connections start DRAFT (F2) | `OIDC_GENERIC` gets a strict schema; the other unused types stay out of the UI |
| **Lifecycle** | DISABLE, ACTIVATE (from DISABLED), QUARANTINE, RELEASE (F2). **No way from DRAFT to ACTIVE**: the database allows DRAFT → TESTING → ACTIVE under the governance lock, and the application offers neither | F4 adds the **test** and the first **activation**, each backed by evidence |
| **Linking a person to a connection** | `linkIdentityAccount`: an administrator **types** the provider's object id | Acceptable for Entra's `oid`, which is visible in Entra. For a generic `sub` it is error-prone: linking must be **proven** (section 4) |
| **Test identity provider** | `tests/provider-adapters/oidc-core.test.ts` runs a complete local IdP: discovery, JWKS, token endpoint and signed tokens | Reused for every F4 test, CI included. No external IdP is needed until certification |

## 2. Scope

**In F4:**
1. The SSRF-guarded transport for every request to an IdP: discovery, JWKS, token.
2. `OIDC_GENERIC` connections with a per-connection configuration: issuer, client id, secret reference (F3), algorithm and scopes.
3. **Test** (DRAFT → TESTING): discovery, metadata and keys are checked without any user. The result is recorded.
4. **Proof sign-in, then activation** (TESTING → ACTIVE): an administrator signs in once through the connection, and only then can it be activated.
5. Sign-in and callback for any ACTIVE federated connection, not just Microsoft.
6. **Proven linking:** a person already signed in to LUXIA proves an identity at the new IdP. This is also the basis of R10's re-link.
7. The `PROVIDER.*` and `IDENTITY_ACCOUNT.*` journal events, with French labels (B5), and the administrator API and UI.

**Not in F4:**
- Google's `hd` check (F6);
- group or role mapping (v2, rule R6);
- SAML, SCIM, LDAP;
- directory reads (F5);
- IdPs on private addresses (section 3, F4-4);
- client authentication `none` (public clients) and `private_key_jwt` (decision F4-5: not in F4).

## 3. Security model

**SSRF-guarded transport.** It is a `fetch` replacement given to `openid-client` as `customFetch`, so the OIDC core does not change.
- **URL:**
  - `https:` only;
  - port 443 only (decision F4-4);
  - no user info, no fragment.
  - The issuer has no query either.
- **Address:**
  - the host is resolved once;
  - **every** resolved address must be public;
  - the connection goes to that resolved address, so DNS rebinding cannot change it afterwards;
  - the TLS certificate is still checked against the host name.
- **Refused ranges (IPv4):** loopback, RFC 1918, link-local (Azure's metadata service at 169.254.169.254 included), CGNAT, `0.0.0.0/8`, multicast, broadcast, documentation and benchmarking ranges.
- **Refused ranges (IPv6):** loopback, unspecified, ULA `fc00::/7`, link-local `fe80::/10`, multicast. IPv4-mapped addresses are checked as IPv4.
- **Response:**
  - redirects are refused;
  - 5 s timeout;
  - at most 512 KB;
  - JSON content type for discovery and JWKS.
- **Every refusal** is a safe reason code: `OUTBOUND_SCHEME`, `OUTBOUND_PORT`, `OUTBOUND_PRIVATE_ADDRESS`, `OUTBOUND_REDIRECT`, `OUTBOUND_TOO_LARGE` or `OUTBOUND_TIMEOUT`. It goes to the test run or the sign-in evidence, never to the browser.
- **Endpoints taken from discovery** (authorization, token, JWKS, end session) pass the same guard. The authorization endpoint is only shown to the browser, but it must still be `https:` on a public host.

**Keys and tokens:**
- the algorithms are those of the core (RS256, PS256, ES256);
- JWKS keys must be RSA of at least 2048 bits, or EC P-256;
- the test refuses a JWKS with no usable key.

**Configuration integrity:**
- The configuration is **immutable once the connection is ACTIVE** (decision F4-3). Changing an IdP means a new connection and a re-link (R10), never an in-place edit.
- Every test run and proof sign-in records the `configurationHash` it tested. Activation requires a passing test **and** a proof sign-in, both on the current hash.

## 4. Flows

| Flow | Who | Steps | Journal |
|---|---|---|---|
| **Create** | Administrator (`providers.manage`) | `OIDC_GENERIC`, a name, the issuer, the client id. The connection is DRAFT, with no secret yet | `PROVIDER.CONNECTION.CREATE` |
| **Attach the secret** | Administrator, after F3's vault exists | Records a `ProviderSecretReference` (purpose `OIDC_CLIENT`). The value goes into the vault, never into LUXIA | `PROVIDER.SECRET.REFERENCE` |
| **Test** | Administrator | DRAFT → TESTING, after a passing check of discovery (exact issuer), the guarded endpoints, the keys and the algorithm. The result is recorded in `ProviderTestRun`, whatever it is | `PROVIDER.CONNECTION.TEST` (success or denial with its reason) |
| **Proof sign-in** | The administrator, at the IdP | A sign-in through the TESTING connection, with purpose `ACTIVATION_PROOF`. It opens **no session**; it proves the whole flow and records the result | `PROVIDER.CONNECTION.PROOF` |
| **Activate** | Administrator | TESTING → ACTIVE. It needs a passing test and a passing proof on the current `configurationHash`. Dry run first, then the plan digest (F2 pattern) | `PROVIDER.CONNECTION.ACTIVATE` |
| **Link (proven)** | The person, already signed in to LUXIA with a FULL session | Starts a link with purpose `LINK`, signs in at the IdP, and the callback creates the `IdentityAccount` (that person, that connection, `sub`). Refused if the `sub` is already linked to anyone, or if the person already has an account on that connection | `IDENTITY_ACCOUNT.LINK` with `proven: true` |
| **Sign in** | Anyone with a linked account | The same core as Microsoft; the connection must be ACTIVE (F2 kill switch). An unknown `sub` gets the generic refusal: no automatic account creation | `AuthenticationEvidence` VERIFIED or REJECTED |
| **Re-link (R10)** | Each person, invited by an administrator | Proven link on the new connection, then the old connection is disabled. The authority digest stays identical (rehearsal) | as above |

`AuthTransaction` gains a `purpose` column: `SIGN_IN` (default, the current behaviour), `LINK` or `ACTIVATION_PROOF`. For LINK, it also stores the subject that started the link. The callback refuses a purpose that does not match the connection's state.

## 5. Data model (expand only; one migration per slice, each rehearsed on a fresh clone)

| Change | Notes |
|---|---|
| `ProviderType` += `OIDC_GENERIC` | `ALTER TYPE … ADD VALUE`, not used in the same transaction (PostgreSQL 17) |
| **`ProviderOidcConfiguration`**, 1 to 1 with a connection | Columns: `issuer`, `clientId`, `clientAuthMethod` (`client_secret_basic`, preferred and the default, or `client_secret_post`; decision F4-5), `idTokenAlgorithm`, `scopes`, `configurationHash`, timestamps. **FORCE RLS** by organization. Guard: writable only while the connection is DRAFT or TESTING; never deleted. Keeping it separate from `ProviderConnection` leaves F2's guard and M2's policy untouched |
| **`ProviderTestRun`** | Columns: `kind` (`DISCOVERY` or `PROOF`), outcome, reason code, `configurationHash`, safe metadata (issuer, endpoint hosts, key count and types), the subject who ran it, the time. **Append-only** (T0 pattern) and FORCE RLS |
| `AuthTransaction` += `purpose`, `subjectId` | Nullable, with a CHECK that LINK carries a subject. Existing rows are SIGN_IN |

**No change to Subjects, Assignments, Entitlements or the journal tables:** authority stays in LUXIA (R1, R6).

## 6. Slices (off Production, each a draft PR with CI)

| # | Slice | Proof |
|---|---|---|
| S1 | **Guarded transport** (`lib/provider-adapters/infrastructure/outbound/`), plugged into the OIDC core as `customFetch` | Unit tests for every range and refusal; DNS-rebinding test with a resolver stub; the existing core tests unchanged; architecture test: no IdP request without the guard |
| S2 | `OIDC_GENERIC` profile, `ProviderOidcConfiguration`, `ProviderTestRun` (migration + rollback + rehearsal) | Postgres suites: RLS across two organizations, immutability after activation, append-only test runs |
| S3 | **Test** action (DRAFT → TESTING), against the local IdP | Pass, plus each failure: wrong issuer, private address, no keys, weak key, `alg=none` in metadata |
| S4 | Generic sign-in and callback, with `purpose` | The negative table of rule R8, one case each; existing Microsoft sign-in unchanged (F1 tests) |
| S5 | **Proof sign-in and activation** | Activation refused without a passing proof on the current hash |
| S6 | **Proven linking** | Refusals: `sub` already linked, second account on the connection, no FULL session, RECOVERY session |
| S7 | Administrator API and UI (rewritten provider pages) | Route tests; labels (B5); permissions (`providers.manage`) |
| S8 | **R10 rehearsal on a clone**: a test organization moved from one connection to another | Authority digest identical before and after |

**Certification, after S1 to S8, and after F3's vault for the secrets.** The same steps run twice:
1. Google accounts as plain OIDC (free). The operator creates the OAuth client in Google Cloud: an account action, no spend.
2. An EU Keycloak, public HTTPS on port 443, only for the certification time. **Spend:** an operator decision.

Each certification creates, tests, proves, activates, links and signs in, runs the R8 negative cases live, then disables and quarantines the connection. That last step is also the **Production proof of the F2 transitions** on a test connection, which F2 left to F4.

## 7. What stays true throughout

- **R3:** passkey and recovery sign-in never depend on any external IdP.
- **R5:** an IdP outage never revokes a session.
- **R6:** claims never become authority.
- **B1 to B5, T0, M2:** unchanged. The existing suites stay green at every slice.
- **No IdP is reached from Preview with a Production secret:** F3's federation is trusted for Production only.

## 8. Risks

| Risk | Mitigation |
|---|---|
| SSRF through an administrator-supplied issuer | Slice S1 first: address pinning, redirects refused, size and time limits, tested against every range and against rebinding |
| A wrong link gives a person someone else's access | Linking is proven by the person themselves, inside a FULL session; a `sub` is linked at most once; never automatic; journaled |
| Vendor drift ("compliant" IdPs that are not) | Strict OIDC only; each vendor certified, not assumed. A test that fails keeps the connection out of ACTIVE |
| Secrets for generic IdPs | Only by reference (F3). Without the vault, no `OIDC_GENERIC` connection can pass its proof in Production |

## 9. Decisions (taken by the operator on 2026-10-16)

| # | Decision | Operator |
|---|---|---|
| F4-1 | Activation needs a passing test **and** a proof sign-in by an administrator, both on the current configuration | Approved |
| F4-2 | For `OIDC_GENERIC`, linking is **only** by proof (no typed `sub`); the typed link stays for Entra's `oid` until R10 | Approved |
| F4-3 | The configuration is immutable once ACTIVE; a change means a new connection and a re-link | Approved |
| F4-4 | Port 443 only, public addresses only; **no exception for private IdPs** in F4. Keycloak is certified on public HTTPS. A private-IdP policy is a later, separate decision | Approved |
| F4-5 | **Modified.** `OIDC_GENERIC` accepts `client_secret_basic` and `client_secret_post`, **`client_secret_basic` preferred** (the default). The secret is **always** obtained by F3 reference. `none` and `private_key_jwt` are **not** part of F4 | Approved as modified |
| F4-6 | Certification IdPs: Google (free; the operator creates the OAuth client), then an EU Keycloak (spend decided at that time) | Approved |
| F4-7 | Order: slices S1 to S8 off Production now; certification after F3's vault | Approved |

**Still the operator's, by gate:**
- merging and deploying any F4 slice;
- the F4 Production migration (after a fresh-clone rehearsal);
- the vault, Azure and Vercel configuration;
- any spend.
