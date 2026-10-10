# DASHBOARD V1 — PRODUCTION CERTIFICATION: PASS

Date: 2026-10-10. Scope: Enterprise Identity Security Dashboard v1 (`docs/product/ENTERPRISE-IDENTITY-SECURITY-DASHBOARD-V1-SCOPE.md`, decisions D1–D5).

## Release chain

| Step | Reference | Result |
|---|---|---|
| PR #22: sessions list projection (no ip/UA hashes) | merge `5eb141b` | CI PASS (run 38068478146) |
| PR #21: dashboard v1 (endpoint + UI) | merge `082f199` | CI PASS (run 38068750067) |
| Production deploy 1 | `dpl_3sAwruEpuGCbdhCQiTFQ5FRkCvQ3` @ `082f199` | READY. Visual smoke **found 2 defects** (below) |
| PR #23: never sum overlapping breakdowns | merge `5c71df8` | CI PASS (run 38070777184) |
| **Production deploy 2 (certified)** | **`dpl_48xvYWVVJUiZg1k9A53tyD7yf7tu` @ `5c71df83ac205c774f6ee2965e2ee3a777c7e5ec`** | READY, active Production target |

Each deployment was built by Vercel from GitHub at the exact SHA (API `gitSource`), with no environment change and no migration. Each was approved explicitly by the operator. Rollback targets: `dpl_3sAwruEpuGCbdhCQiTFQ5FRkCvQ3`, then `dpl_J3GnuWwpMFejURjG5ASKWc8nJK5U`.

## Defects found by the Production visual smoke and fixed (PR #23)

| Widget | Displayed | Real | Cause |
|---|---|---|---|
| Preuves de connexion LUXIA_LOCAL (7 j) | 26 | 13 | `VERIFIED_PHISHING_RESISTANT` ⊂ `VERIFIED` was summed |
| Détenteurs de droits d'administration | 12 | 1 holder | one line per key for the same subject was summed |

The API values were correct; only the summed display was wrong. Both widgets are now `breakdown: "overlapping"`: no total is shown, only the per-category values. Re-verified on deploy 2.

## Checks on the certified deployment

| Check | Result |
|---|---|
| Unauthenticated: `/login` 200, `/dashboard` 307 → `/login`, `/api/canonical/posture` 401, `/api/canonical/sessions` 401 | PASS |
| Authenticated API (operator Chrome session, read through Claude in Chrome; no cookie read) | PASS: every widget has a valid state |
| Independent read-only DB cross-check (`app_user`, READ ONLY), 13 values: subjects 1, accounts 2, active sessions 5, sessions started/revoked 7 d 48/40, effective assignments 21, active resources 1, active passkeys 6, local verified sign-ins 7 d 13, denied/failed 24 h/7 d 8/12, SoD policies 0, review campaigns 0 | **13/13 identical** |
| `0` / `unavailable` / `not_implemented` / `restricted` distinct | PASS: Entra evidence `Indisponible`; MFA/CA and existing SoD violations `Non disponible dans cette version`; real zeros shown as 0 |
| Ceremony consistency | 21 effective assignments (the revoked bootstrap grant is excluded); 1 resource with no effective holder; ceremony events visible in Recent Activity |
| No session/authenticator data in payload | PASS: no session id, ip/UA hash, credential id or external object id |
| D1 audit | PASS: one `DASHBOARD.POSTURE.READ` per load (4 loads → 4 events) |
| Overlapping breakdowns | PASS: "Catégories non cumulables", no invented total |
| Hidden governance performs no query | Proven by CI tests (restricted is decided before any query) and by construction. Not observable in Production for this operator, who holds `sod.read` / `access_reviews.read` (governance shows real zeros) |

## CI certification (exact merge SHAs)

`tests/resources/identity-security-posture-postgres.test.ts` (10 tests, app_user PostgreSQL/RLS):
- exact values on a known fixture;
- no-rights and partial viewers;
- tenant isolation and payload privacy;
- D1 audit, with no other mutation;
- per-widget `unavailable` isolation (thrown and SQL errors);
- READ ONLY enforcement;
- non-ACTIVE viewer refused (403, no audit).

Also: `tests/security/identity-security-posture-contract.test.ts` (8 tests), `tests/resources/sessions-projection-postgres.test.ts`, all existing suites, and the build.

## Minor follow-ups (non-blocking, not fixed here)

- The 401 response of `/api/canonical/posture` carries no `Cache-Control: no-store` (it contains no data).
- The privileged-operations list does not include `ROLE_BUNDLE.GRANT` and `RESOURCE.ONBOARDING.CONFIGURE`. Both are older than 7 days in Production, so the current counter is correct.
- The denied/failed counters include denied capability reads (e.g. `RESOURCE.CAPABILITY.READ` DENIED), while the activity feed hides `*.READ`. Both are real data, but the difference should be explained in the UI.

**DASHBOARD V1 — PRODUCTION CERTIFICATION: PASS**
