# Customer Self-Onboarding v1: Production release, Legrand Tech validated

Dates are UTC. The scope is in `docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md`; the implementation and plan are in `docs/architecture/CUSTOMER-SELF-ONBOARDING-V1.md`.
Each gate was approved explicitly by the operator. The four decisions of PR #32 were validated on 2026-10-11.

**Out of this document:** the real second organization and the Production cross-tenant certification. They need a separate approval.

## Release

| Step | Reference | Result |
|---|---|---|
| PR #32 head | `e5a3c1339f7402809ed9f313f4725d1cd28ce172` | CI run 38093381931 **PASS**. 43 onboarding tests executed, none skipped. |
| Merge (pinned to the head SHA) | `6f9de76e89261fc54dbd71895ad8ba492d8649c0` (parents `b506c97`, `e5a3c13`) | Merge tree identical to `e5a3c13`. CI run 38094537834 **PASS** (all steps). |
| Database backup before migration | Neon branch `br-plain-union-ah2o23ll` at LSN `0/3A6BEA0` | Expires 2026-10-25 |
| Production migration | `20261011000000_customer_self_onboarding_v1`, applied 01:25:12Z | `neondb_owner` on the direct endpoint. Exactly one migration was pending. |
| Production deployment | **`dpl_7ZzzEA3DbQdAACKZP4f9V947gkad` @ `6f9de76`** | READY, production target. Built by Vercel from GitHub at the exact SHA; no env change. |
| Rollback deployment | `dpl_EDZXLTXRrHDbBbVGqcEhCTF3SnpW` @ `2d7ec62` | READY |

## Rehearsal on an isolated Production clone (before any Production change)

Clone branch `br-holy-sound-ahlfpe7v`, taken from Production at LSN `0/3993A10`, with a 12-hour expiry. Scripts are owner read-only snapshots; they refuse the Production endpoint.

| Check | Result |
|---|---|
| Migration applied | PASS (19 → 20 migrations) |
| Business digest of 45 tables, before vs after (Organization compared without `slug`) | **identical** |
| Legrand Tech → `legrand-tech`, name unchanged | PASS |
| Existing functions, table ACLs, RLS, policies, triggers, default privileges, columns | unchanged; the only new column on an existing table is `Organization.slug` |
| New objects | 5 tables with forced RLS. 4 guards: no PUBLIC or app_user access. 5 entry points: definer, pinned `search_path`, app_user EXECUTE only. Partial unique index on verified domains. |
| New code as `app_user` on real data | `legrand-tech` resolves to its single tenant, with one Microsoft and one local connection. Passkey begin offers exactly its 7 active passkeys. Unknown identifiers get the same answer shape. Internal tables are closed to app_user. |
| Documented rollback | Structure identical to the Production copy, data intact |
| Re-apply after rollback | PASS, digest identical |
| Rollback once onboarding data exists | refused (`ROLLBACK_REFUSED_DATA_EXISTS`) |
| Forward-fix | Operator command issues, lists and revokes codes. Pepper rotation works. Slug change and code deletion are refused, even for the owner. |

## Production migration

| Check | Result |
|---|---|
| Snapshot before (01:24:54Z) → migration (01:25:12Z) → snapshot after (01:25:29Z) | done |
| Business digest of 45 tables, before vs after | **identical** |
| Legrand Tech → `legrand-tech`, name unchanged, still one organization | PASS |
| Existing structure and rights unchanged; new objects as rehearsed | all PASS (28 checks) |
| Production after vs clone after (structure, rights, organizations) | **identical** |

## Live verification on Legrand Tech

Unauthenticated smoke (14/14 PASS):
- `/login`, `/signup` and `/invitation` return 200, and the login page reads nothing from the database;
- `/dashboard` redirects to `/login`;
- onboarding and journal APIs return 401 without a session;
- Microsoft with `legrand-tech` redirects to Microsoft, and an unknown organization returns to `/login?error=signin`;
- passkey begin gives the same shape for an unknown organization or identifier;
- an invalid beta code or invitation token is refused.

Operator actions (T0 = 01:29:12Z), cross-checked read-only in the database:

| Check | Database | Application |
|---|---|---|
| Microsoft sign-in with `legrand-tech` | `AuthenticationEvidence` 09:48:48.636Z: FEDERATED_OIDC, VERIFIED, LOW, provider-asserted, not phishing-resistant. Session created at 09:48:48.637Z. | Journal: "Connexion attestée par Microsoft" |
| Sign-out | `SESSION.SIGN_OUT` 09:50:20.218Z. The Microsoft session was revoked at 09:50:20.244Z. | Journal: "Déconnexion" |
| Passkey sign-in | `AuthenticationEvidence` 09:51:08.731Z: PASSKEY, VERIFIED, SUBSTANTIAL, UV verified, phishing-resistant. Session created at 09:51:08.754Z. | Journal: "Clé d'accès, Résistante à l'hameçonnage" |
| Dashboard | Over 24 hours: FEDERATED_OIDC 6, PASSKEY 12, rejected 0. All-time Entra verified sign-ins: 6. | 46 indicators ok and 2 not implemented, unchanged. Values equal to the database. "Mise en route" shows real facts. |
| Sessions | 3 active: 2 opened before T0 and the new passkey session | "Mes sessions" lists 3, "Cette session" marked |
| Passkeys | 7 active | "Mes clés d'accès" lists 7; the one used shows its last use |
| Organisation page | 0 domains, 0 invitations | Page renders. Only "Créer l'invitation" is offered; no email promise. |

No sign-out was recorded before the Microsoft sign-in, and both sessions opened before T0 are still active. The first step of the sequence (sign-out) therefore did not apply to an active session: the sequence was most likely run in a window that was already signed out. This is an inference from the database, not observed directly.

## Not done (separate approval)

Second organization in Production through a real beta code, and the ten cross-tenant proofs of the certification plan.
