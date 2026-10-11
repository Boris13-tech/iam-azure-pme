# CUSTOMER SELF-ONBOARDING V1 — PRODUCTION CERTIFICATION: PASS

Date: 2026-10-11 (UTC). Scope: `docs/product/CUSTOMER-SELF-ONBOARDING-V1-SCOPE.md`. Plan and traceability: `docs/architecture/CUSTOMER-SELF-ONBOARDING-V1.md`. Release evidence for Legrand Tech: `CUSTOMER-SELF-ONBOARDING-V1-RELEASE-2026-10-11.md`.

The operator approved each gate explicitly in chat. Database reads were read-only (owner or app_user). Browser evidence came from Claude in Chrome, with no cookie read. Human ceremonies were done by the operator: beta-code signup, Windows Hello passkeys and the Cloudflare DNS record.

PASS was pronounced only after all ten proofs were verified, finding F1 was fixed and deployed, and proof 3 was replayed at organization **and** person level.

## Releases

| Step | Reference | Result |
|---|---|---|
| Self-onboarding v1 | PR #32 → `6f9de76`, deployment `dpl_7ZzzEA3DbQdAACKZP4f9V947gkad` | CI PASS; migration digest identical (release evidence) |
| Test race fix | PR #34 → `327abc9` | CI PASS (tests only) |
| Release evidence | PR #33 → `4745af2` | CI PASS on `cb1b5c3` (docs only) |
| **F1 fix** | PR #35, head `6a72942`, merge **`5e8c887`** | CI PASS on the head and on the merge (run 38145968797), no unhandled error |
| **Production deployment** | **`dpl_Ao1hwzYREFMHVMqZotEHkQ67QAyJ` @ `5e8c887`** | READY, production target. Built by Vercel from GitHub at the exact SHA; no migration, no env change. |
| Rollback deployment | `dpl_7ZzzEA3DbQdAACKZP4f9V947gkad` @ `6f9de76` | READY |

## Test organization

| Item | Value |
|---|---|
| Beta code | Issued 10:45:40Z, 24 h, single use, consumed at 10:56:26Z |
| Organization | "LUXIA Certification Lab", slug **`luxia-certification-lab`** (deviation D1), 1 tenant |
| Founder | "Fondateur Certification Lab", `fondateur@luxia-cert-lab.test`, passkey |
| Member | "Membre Certification Lab", `membre@luxia-cert-lab.test`, MEMBER invitation accepted at 13:36:21Z, passkey |
| Domain | `cert.luxia-it.com`. Real TXT `_luxia-verification.cert.luxia-it.com` published by the operator in Cloudflare, then removed. |

## The ten proofs

| # | Proof | Evidence | Result |
|---|---|---|---|
| 1 | Org A cannot see Org B | From the Legrand session: identities, accounts, 99 sessions and journal show no Lab data. A write on the Lab founder gets 404 `SUBJECT_NOT_FOUND`. | **PASS** |
| 2 | Org B cannot see Org A | From the founder session: identities, accounts, sessions, journal, domains and invitations are Lab-only. A write on Legrand's identity gets 404 `SUBJECT_NOT_FOUND`. | **PASS** |
| 3 | Unknown slug and person reveal nothing | After the F1 fix: known person, unknown person, unknown organization, wrong organization and disabled person get the same answer in 25 of 25 requests (200, same fields, `allowCredentials: []`). No real credential ID appears in any answer. Medians are 565–582 ms; one cold-start outlier at 7.8 s was on the first request after deployment. A wrong key on a real transaction gets the same generic 401 as an unknown transaction. Microsoft with an unknown organization and with an organization without Microsoft both return `/login?error=signin`. | **PASS** (organization and person) |
| 4 | Beta code cannot be replayed | A second signup with the same code gets 403 `SIGNUP_CODE_INVALID`. The code stays CONSUMED and there are still 2 organizations. | **PASS** |
| 5 | Invitation cannot be replayed | Replay of begin and complete gets 403 `INVITATION_INVALID`, including with an injected ADMIN role and the Legrand tenant. The invitation was accepted once. | **PASS** |
| 6 | Invitation cannot escalate privileges | The member has 0 assignments. Inviting (admin or member), adding a domain, and reading invitations, domains, journal or assignments all get 403. All 48 dashboard indicators are restricted. Only self-service answers. | **PASS** |
| 7 | A verified domain cannot be claimed twice | The Lab verified `cert.luxia-it.com` through real DNS at 13:17:36Z. Legrand's claim was tested in Production as `app_user` under RLS, in one transaction rolled back by design (method approved to avoid an undeletable pending row in Legrand): **refused, 23505**. Legrand still has 0 domains. | **PASS** |
| 8 | Founder creation cannot leave partial authority | One founder with exactly the 21 catalog assignments (v1 and v2) and 4 creation events. The code is CONSUMED and the request data is erased. | **PASS** |
| 9 | The second organization signs in independently | Founder and member passkey sign-ins are VERIFIED in the Lab. The same identifiers under `legrand-tech` get the anonymous answer. | **PASS** |
| 10 | Legrand Tech works unchanged | The business digest of 14 tables equals the start, except `Subject.updatedAt` (incident I1). Microsoft and passkey sign-ins after the Lab was created are VERIFIED. After the F1 fix, an **existing Legrand passkey** (enrolled 2026-10-03, 16-byte ID) signs in through Windows Hello's discoverable list (14:15:46Z). Dashboard: 46 ok, 2 not implemented. No Lab trace anywhere in Legrand. | **PASS** (with I1) |

## Finding F1 (fixed)

**Observed:** real credential IDs were 22 characters at Legrand and 27 at the Lab, while decoys were 43. Someone who knew an organization's identifier could tell whether a person identifier existed from the length of `allowCredentials`.

**Fix (PR #35, mechanism approved before implementation):**
- `begin` always returns the same fields with an empty `allowCredentials`, and no credential ID leaves the server before verification;
- discoverable passkeys are used, and every registration now requires one;
- completion still checks that the key belongs to the identity of the challenge.

**Tests:**
- credential IDs of 16, 20, 32 and 64 bytes all sign in and never appear in the answer;
- another person's key is refused.

**Live checks after deployment:** no regression on an existing key, and proof 3 replayed and passed.

**Follow-up:** the unused `luxia_login_decoy` function needs a later, approved migration to drop it.

## Deviations and incidents

- **D1, procedural deviation with no security impact.** The organization was created with the suggested slug `luxia-certification-lab` instead of the planned `luxia-cert-lab`, because the form's suggestion was not corrected. The slug is immutable by design. The name, founder and rights matched the plan. The operator chose to continue on this organization, and no extra organization was created.
- **I1, verification error by Claude Code.** At 11:10:14Z, a "cross-organization" write test was sent from a Chrome session that was in fact Legrand's. It rewrote Legrand's identity name with **the same value**. Impact:
  - only `Subject.updatedAt` changed;
  - one `SUBJECT.UPDATE` event was added to Legrand's append-only journal;
  - no change of name, lifecycle, sessions or assignments.

  This is proven against the pre-migration backup branch: the row is identical except `updatedAt`. Corrective practice applied for the rest of the certification: check the session's organization before any write.
- **Side effect of an approved check.** The single wrong-key attempt in the proof 3 replay left `failedAttempts = 1` on Legrand's local identity. Lockout only happens at 5, and the counter resets at the next successful sign-in.

## Neutralization of the Lab (provisional break-glass operator action, outside the product)

Option (a) was approved by the operator. The product forbids self-disabling, so the last account of an organization cannot be disabled through the product. A dry run was done first, then one transaction with the owner role, after the TXT record was confirmed absent on 1.1.1.1 and 8.8.8.8.

| | Before | After |
|---|---|---|
| Active sessions | 2 | 0 |
| Active identity accounts | 2 | 0 |
| Active local identities | 2 | 0 |
| Active passkeys | 2 | 0 (REVOKED) |
| `cert.luxia-it.com` | VERIFIED | LOST (released) |
| Journal events | 47 | 51 |

**Journal attribution.** The four events are authored by a non-human `SERVICE` identity, "Opérateur LUXIA (break-glass)". It is disabled and has no account, key or right. The events are `BREAK_GLASS.SESSION.REVOKE`, `BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE` ×2 and `BREAK_GLASS.DOMAIN.RELEASE`, each with the reason and the approval in its metadata.

**No new sign-in is possible:**
- begin for the founder and the member gives the anonymous answer and creates no challenge (11 before, 11 after);
- completion gets the generic 401.

**The domain is released:** the same rolled-back claim from Legrand now passes verification, and Legrand still has 0 domains.

Historical evidence is kept. A product break-glass procedure belongs to the next roadmap slice, "First Admin / Break-glass".

## Remaining items (not blocking)

- **Unused function:** dropping `luxia_login_decoy` needs an approved migration.
- **Unlabelled journal operations:** `BREAK_GLASS.*` has no French label yet, so the journal shows "Autre action".
- **Denial noise:** for members, `ONBOARDING.CHECKLIST.READ.DENIED` is written on each overview load. Showing the checklist only to administrators would avoid it.
- **Backup branch:** `br-plain-union-ah2o23ll` expires on 2026-10-25. Its temporary read-only compute `ep-empty-paper-ahj1xmcy` can be removed.

**CUSTOMER SELF-ONBOARDING V1 — PRODUCTION CERTIFICATION: PASS**
