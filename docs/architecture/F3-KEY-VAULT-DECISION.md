# F3: Key Vault decision note

Status: **DESIGNED, for the operator's decision.** Nothing in this note has been created, configured or paid for.

It completes `F3-SECRET-STORE-DESIGN.md`:
- section 3: reaching the vault without a stored secret;
- section 6: costs;
- section 8: rollout.

Evidence labels:
- **VERIFIED:** observed (Azure Retail Prices API, Vercel and Azure documentation, Production read-only).
- **ASSUMPTION:** to confirm.

## 1. Why now

| Fact | State |
|---|---|
| Microsoft sign-in secret | **One global variable**, `ENTRA_AUTH_CLIENT_SECRET`, for the only Microsoft connection (finding M2). It has a Production target only (VERIFIED 2026-10-14) |
| The Entra application's only client secret | **Expires on 2026-12-29** (VERIFIED, metadata only). It must be rotated before that date in any case, which is the natural moment to move it into the vault |
| Graph | Variables removed from Production (G-R1, 2026-10-14). Out of scope until F5 |
| F3 code | Not merged (#69). Vault adapter, secretless federation, cache and guard are implemented and tested. The guard is **not wired** |
| References table | Rehearsed (0 failures). The Production gate is ready; the table stays empty until this decision |

## 2. Options

| Option | For | Against | Verdict |
|---|---|---|---|
| **A. Azure Key Vault Standard, France Central, reached by Vercel OIDC federation (no stored credential)** | Already designed and tested (adapter over REST, ~80 lines). Per-secret RBAC. Audit log. EU region. Negligible cost | One more Azure resource; one more availability dependency for Microsoft sign-in only | **Recommended** |
| B. Keep the environment variable | Nothing to do | Global secret (M2); any Production deployment reads it; rotation is manual; no per-connection secrets | Rejected: it does not meet F3 |
| C. EU-sovereign store (self-hosted OpenBao/Vault, or an EU cloud secret manager) | Leaves the US hyperscaler | Hosting, operations and backups of the store itself; LUXIA's hosting is not in the EU yet (E3) | Later, as a second adapter behind the same port (design section 7) |

## 3. Architecture (option A)

```
Vercel Production function
  │ 1. reads its own short-lived OIDC token (Vercel, per deployment)
  ▼
Entra ID: app registration "LUXIA workload: secret reader" (no client secret)
  │ 2. federated credential: issuer https://oidc.vercel.com/<team>,
  │    subject owner:<team>:project:<project>:environment:production,
  │    audience api://AzureADTokenExchange  → access token for Key Vault
  ▼
Key Vault "<luxia-app-secrets>" (France Central, RBAC, purge protection)
  │ 3. GET /secrets/<name>/<version>  (role: Key Vault Secrets User on that secret only)
  ▼
CachingSecretResolver (5 min, stale-if-error 60 min) → the Microsoft OIDC client secret, in a lease, never logged
```

- **The application vault is separate from the backup vault** (`luxia-bkp-kv-284e`): a compromise or misconfiguration of one does not reach the other.
- **Reference recorded in LUXIA:**
  - one `ProviderSecretReference` row for Legrand Tech's Microsoft connection;
  - purpose `OIDC_CLIENT`;
  - locator `akv://<vault>/<name>`, with the version pinned.

  It holds no value. The database refuses any other shape.
- **What stays independent of the vault:** passkey sign-in, recovery, existing sessions, authorization and administration (design section 5).

## 4. Minimal permissions

| Principal | Granted | Never |
|---|---|---|
| **Workload app registration** (Vercel Production) | One federated credential, for Production only. Role **Key Vault Secrets User**, assigned **on each secret** it needs, not on the vault | No client secret, no certificate, no API permission (no Graph), no list or write on the vault |
| **Operator** (human) | **Key Vault Secrets Officer** on this vault, to write the secret value in the portal | Nothing on the backup vault beyond what exists |
| **Claude** | Nothing on the data plane. Read-only metadata (vault properties, role assignments, secret **names and versions**) when the operator asks | Never `secret show` or any value; never a write |
| **Vault settings** | RBAC authorization (no access policies), soft delete 90 days, **purge protection on**, diagnostic setting for `AuditEvent` | Public network access cannot be restricted to Vercel: Vercel has no fixed egress on this plan. Access rests on Entra authentication and per-secret RBAC (ASSUMPTION: to re-evaluate with E3 hosting) |

## 5. Preview and Production separation

- **The federated credential trusts `environment:production` only.**
  - A Preview or Development deployment presents a token with another subject, and Entra refuses to exchange it.
  - **Preview cannot read the Production secret at all.** This is enforced by Entra, not by convention.
- **The environment variable is removed from Production at the end of the rollout.** No secret-bearing variable then has a Preview target.
- **Optional, later:** a separate non-Production vault and app registration, trusted for `environment:preview`, holding test secrets of a test Entra application. It would let the vault path be tested on previews (design section 8, step 3).

## 6. Cost (EUR, France Central)

| Item | Price | Expected |
|---|---|---|
| Key Vault Standard operations | €0.0264 per 10,000 (VERIFIED 2026-10-14) | Today, under 1,000 a month: **under €0.01**. Upper bound at the 5-minute TTL (2 secrets, 20 warm instances, all month): about **€0.91** |
| Vault itself | No monthly fee (Standard; no Managed HSM) | €0 |
| Entra app registration, federated credential, token requests | Free | €0 |
| Audit logs, if sent to the existing Log Analytics workspace | First 5 GB of ingestion a month free, then €2.43 per GB; retention €0.11 per GB a month (VERIFIED, Azure Retail Prices API, 2026-10-16) | A few MB a month: **€0** (ASSUMPTION on volume, to watch) |
| **Total** | | **Under €1 a month** |

This is **new spend outside the backup authorization** (€10 a month, backup only). It needs the operator's explicit approval, even though it is negligible.

## 7. Rollout and rollback (each line is an operator gate)

| # | Step | Proof | Rollback |
|---|---|---|---|
| 0 | References migration (gate prepared, table kept empty) | `f3-gate.sh`: before, apply, after, rollback, reapply; backups verified | Rollback SQL (lossless while empty) |
| 1 | Create the vault, the workload app registration, its federated credential and nothing else. **Spend starts** | Metadata only: region, RBAC mode, purge protection, the federated credential's subject, 0 role assignments yet | Delete the federated credential and the app registration. The vault is soft-deleted (purge protection keeps its name 90 days, at no cost) |
| 2 | Vercel: enable OIDC federation for the project (team issuer) | A Production function can read its own token (no value logged) | Disable it |
| 3 | **Rotate** the Microsoft client secret into the vault: a new Entra secret, written by the operator directly into the vault. The old secret stays valid | The secret's name and version exist; Claude never sees the value | Delete the new version; the old secret still works |
| 4 | Role **Key Vault Secrets User** on that one secret for the workload. Record the `ProviderSecretReference` row (first write to the table) | Database invariants (rehearsed 18/18) | Revoke the reference (never deleted) and remove the role |
| 5 | Code: the Microsoft connection resolves its secret through the vault when it has a reference. The environment fallback stays. Deploy | Microsoft sign-in 11/11; a vault read in the audit log; passkey 6/6 | Redeploy the previous deployment |
| 6 | Wire the guard (Production refuses the environment store) and remove the global fallback. Deploy | Same proofs. A deployment without a vault reference refuses Microsoft sign-in (generic answer) | Redeploy the previous deployment |
| 7 | Remove `ENTRA_AUTH_CLIENT_SECRET` from Vercel Production, then **revoke the old Entra secret** | The old key id is absent in Entra; sign-in through the vault | Until step 7: restore the variable. After the revocation: forward only (a new secret into the vault) |

**When the vault is unavailable:**
- Microsoft sign-in is served from the cache for up to 60 minutes, then fails closed for that connection only.
- Passkey sign-in and recovery are unaffected (tested in a 90-minute outage simulation).

## 8. Decisions (operator, 2026-10-16)

| # | Decision | Recommendation | Operator |
|---|---|---|---|
| KV1 | Approve option A and its spend (under €1 a month), outside the backup authorization | Yes | **YES** |
| KV2 | Region and naming: France Central; a dedicated vault for application secrets, separate from the backup vault | Yes | **YES** |
| KV3 | Audit logs (`AuditEvent`) to the existing Log Analytics workspace | Yes (free tier) | **YES** |
| KV4 | Use the rotation the 2026-12-29 expiry requires anyway to put the new Microsoft secret straight into the vault (step 3) | Yes, in November, well before the expiry | **YES** |
| KV5 | A non-Production vault for previews | Later (optional) | **LATER** |
| KV6 | Order: references migration gate (step 0) first, then steps 1 to 7, each as its own gate | Yes | **YES** |

Approving these decisions creates nothing: **no Azure resource exists yet** (2026-10-16). Step 0 (the references migration) is PRODUCTION VERIFIED; each of steps 1 to 7 is still its own gate, run only on the operator's word.

## 9. Open assumptions to verify before or at step 1

- Vercel's OIDC token works inside this application's Next.js route handlers (`@vercel/oidc`). Test on a Preview with a **non-Production** test credential, or on the first Production step with the environment fallback still in place.
- Audit log volume stays within the free tier.
- Key Vault's service level (99.99%, Azure's published SLA) holds for the vault's tier.
