# F3: provider secrets in a vault, per connection, never global, never in Preview

Phase F3 of `SOVEREIGN-PROVIDER-FEDERATION-LAYER-DESIGN.md` (sections 4.6 and 6, decision D4: Azure Key Vault now, behind a port).

| Item | State |
|---|---|
| Port, adapters, cache, guard | **IMPLEMENTED off Production** (this PR) |
| Vault resource, wiring, secret migration | **DESIGNED**: each is an operator gate (section 8) |

Evidence labels:
- **VERIFIED:** observed (code, API, documentation);
- **ASSUMPTION:** to confirm.

## 1. Today (VERIFIED, 2026-10-14)

- **Port:** `SecretResolver.withSecret(context, reference, consumer)` with a `SecretLease`. The lease is redacted in `toString` and `toJSON`, and copies are zeroed after use.
  - `SecretCustody` (versioned handles, states `ACTIVE`/`VERIFY_ONLY`/`REVOKED`/`COMPROMISED`/`RETIRED`) exists for identity keys.
- **Only adapter:** `EnvironmentSecretResolver`, which reads `process.env[key]`. It is built in two composition roots: the Entra runtime and LUXIA_LOCAL (TOTP seeds; there are none in Production).
- **Finding M2 is confirmed in Production.** The single Microsoft connection signs in through the **global** variables `ENTRA_AUTH_CLIENT_ID`/`ENTRA_AUTH_CLIENT_SECRET`, through the fallback in `connection-config.ts`. No per-connection variable exists.
  - The Graph client (`GRAPH_*`) reads and **writes** users of the Microsoft tenant (`lib/graph.ts`).
- **Environment separation:** Production secrets must never be readable by Preview deployments.
  - A containment plan for the current state is tracked with the operator (F3-a). It is not detailed in this public repository until it is applied.
  - The structural fix is section 3.

## 2. Target

| Invariant | How |
|---|---|
| **Per connection** | Every provider secret belongs to one connection and one purpose (`oidc-client`, `directory`), recorded as a **reference**, never a value. Reference format: `akv://<vault>/<name>`, with the version pinned in `SecretReference.version` |
| **Never global** | No fallback from a connection to a shared variable. The fallbacks in `connection-config.ts` are removed once the connection's reference exists |
| **Production never reads the environment** | `assertSecretStoreAllowed` refuses an `environment` (or unknown) store when `VERCEL_ENV` or `APP_ENV` is `production`. It is wired at the composition roots with the rollout |
| **Active and candidate versions** | Rotation:<br>1. write the new value as a new vault version (candidate);<br>2. test the connection with the candidate (F5 test);<br>3. promote it: requires step-up (K3) and is journaled `PROVIDER.SECRET.ROTATE` with the reference and version only;<br>4. keep the previous version `VERIFY_ONLY` for a grace period;<br>5. disable it |
| **No value leaves the lease** | Errors carry a reason and the vault and secret names only, never the value, the URL or the token (tested) |
| **Replaceable store** | The core sees the port only (architecture test). Vault-specific code lives in `lib/provider-adapters/infrastructure/secret-stores/`, over REST, with no vault SDK |

**Data model (design, migration in the F3 rollout).** `ProviderSecretReference`:
- columns: `organizationId`, `providerConnectionId`, `purpose`, `store`, `locator`, `activeVersion`, `candidateVersion`, `rotatedAt`, `revokedAt`;
- forced RLS, append-only history;
- unique per (connection, purpose).

## 3. Reaching the vault without a stored secret

- **Platform identity:** Vercel issues each deployment a short-lived OIDC token (VERIFIED, Vercel documentation "OIDC Federation, Azure", 2026-10-14):
  - issuer `https://oidc.vercel.com/<team>`;
  - subject `owner:<team>:project:<project>:environment:<preview|production|development>`;
  - recommended audience `api://AzureADTokenExchange`.
- **The federated credential in Entra trusts `environment:production` only.** Entra rejects a Preview deployment's token, so **Preview cannot obtain the vault token at all**. This is the structural fix for the environment-separation problem, not a convention.
- **`FederatedWorkloadTokenProvider`** exchanges the platform assertion for a Key Vault token:
  - grant `client_credentials` with `client_assertion` (jwt-bearer);
  - caches it until 5 minutes before expiry;
  - one request at a time.
  - **No client secret is stored anywhere.**
- **Wiring the assertion source:** `getVercelOidcToken` from `@vercel/oidc` is a small, official dependency, added at wiring time. **ASSUMPTION:** it works inside the Next.js route handlers of this app; to verify on a preview with a non-Production federated credential.

## 4. Adapters (implemented, tested off Production)

| Module | Role |
|---|---|
| `reference.ts` | Parses `akv://` and `env://` locators. Refuses paths, traversal, bad names and versions |
| `azure-key-vault.ts` | `GET /secrets/{name}/{version}?api-version=7.4` with the bearer token. Rules: `redirect: "error"`; timeout 3 s; 401/403 denied (final); 404 missing (final); 429/5xx/timeout unavailable (retryable); disabled or empty secret refused |
| `federated-token.ts` | Secretless token, as described in section 3 |
| `caching.ts` | TTL of 5 minutes; **stale-if-error** for up to 60 minutes after the last successful read, for **transient** failures only. A denied or missing secret evicts the entry at once. Entries are per organization and connection, and zeroed on eviction |
| `runtime-guard.ts` | Production refuses the environment store |

**Tests:**
- `tests/provider-adapters/secret-stores.test.ts`: 11 tests against local fake vault and token endpoints. They cover the outcomes, redaction, single-flight, refresh, the cache window, tenant isolation and a 90-minute outage simulation. Two mutations of the cache and the guard are caught.
- `tests/security/secret-store-architecture.test.ts`: no vault SDK; endpoints named only in the adapters; test hooks never used by the application; the core depends on the port only; a ratchet on the two composition roots.

## 5. What depends on the vault (dependency measured)

| Flow | Needs a provider secret | When the vault is down |
|---|---|---|
| LUXIA_LOCAL passkey sign-in, B2 recovery | **No** (public keys in the database) | **Unaffected** (R3) |
| Existing sessions, authorization, administration | No | Unaffected (R5) |
| Microsoft sign-in (begin and callback) | Yes: the OIDC client secret, read at discovery and token exchange | Served from the cache up to 60 minutes after the last successful read, then a generic refusal for that connection only |
| Graph directory reads and writes | Yes: the directory secret | Same rule. Admin directory actions show "unavailable" |
| Secret rotation | Yes | Postponed. The active version keeps working |

**Simulation (tested):** a 90-minute vault outage with a sign-in every 5 minutes. The first 11 sign-ins (up to 55 minutes) are served, then the connection fails closed; local sign-in never depends on it.

**Availability:** Key Vault's service level (99.99%, ASSUMPTION from Azure's published SLA) is above the current application hosting's.

**Common mode with the backup chain:** the backup chain uses a different vault (`luxia-bkp-kv-284e`), and **the application vault must be separate** (section 8). A compromise or misconfiguration of one does not reach the other.

## 6. Cost (VERIFIED, Azure Retail Prices API, France Central, EUR, 2026-10-14)

- **Key Vault Standard:** €0.0264 per 10,000 operations. No monthly fee for the vault itself; Managed HSM is not used.
- **Today** (one connection, a few sign-ins a day): under 1,000 operations a month, so **under €0.01 a month**.
- **Upper bound at the 5-minute TTL:** one read per secret, per warm function instance, per 5 minutes. For 2 secrets and 20 warm instances all month: 2 × 20 × 12 × 24 × 30 = 345,600 operations ≈ **€0.91 a month**.
- **Token requests** to Entra are free.
- **This is new spend outside the backup authorization.** It needs the operator's explicit approval (section 8), even though it is negligible.

## 7. Reducing vendor lock-in

- **The port is the contract.** The core never imports a store (architecture test).
- **REST over SDK:** the vault adapter is about 80 lines of `fetch`. A second store is a second adapter selected by the reference scheme. Examples: `vault://` for an OpenBao or HashiCorp Vault hosted in the EU, or an EU cloud secret manager. **ASSUMPTION:** candidates, to evaluate when hosting moves to the EU (E3).
- **References, not values, live in LUXIA's database.** Moving a connection to another store means copying the value into the new store, writing a new reference, testing, then promoting, through the same journaled flow as a rotation.
- **The identity of the deployment is federated (OIDC).** It is not a cloud-specific secret: the same platform token pattern works with other stores that accept OIDC workload federation. **ASSUMPTION** per store.

## 8. Rollout (each step after F2 is PRODUCTION VERIFIED; gates in bold)

1. **Operator: create the application vault.**
   - France Central, RBAC mode, purge protection, separate from the backup vault.
   - An Entra app registration for LUXIA's workload, with **only** "Key Vault Secrets User" on that vault.
   - Federated credential: issuer `https://oidc.vercel.com/<team>`, subject `…:environment:production`, audience `api://AzureADTokenExchange`.
   - Spend: under €1 a month (section 6).
2. **Operator: put the current Microsoft OIDC and Graph secrets into the vault** as per-connection secrets.
   - The operator does it in the portal; Claude never sees the values.
   - Then the `ProviderSecretReference` migration (expand only, with a rehearsal, **a Production migration gate**) records the references.
3. Code (autonomous):
   - composition roots use `CachingSecretResolver(AzureKeyVaultSecretResolver(FederatedWorkloadTokenProvider))`, plus `assertSecretStoreAllowed`;
   - `connection-config.ts` reads the connection's references;
   - global fallbacks are removed;
   - first on a preview bound to a **non-Production** test vault and federated credential.
4. **Operator: deploy**, then the Microsoft sign-in, a Graph read and the read-only proof.
5. **Operator: remove the global Production variables** (`ENTRA_AUTH_CLIENT_SECRET`, `GRAPH_CLIENT_SECRET`), then **rotate both secrets** in Entra. Old copies anywhere become dead values. Rollback until the old secrets are deleted: restore the variables.
6. **Certification (PRODUCTION VERIFIED):**
   - sign-in and Graph through the vault;
   - the environment store refused in Production (guard active);
   - no secret-bearing variable with a Preview target;
   - the old secrets' key ids absent in Entra;
   - a vault outage drill on a non-Production deployment.
