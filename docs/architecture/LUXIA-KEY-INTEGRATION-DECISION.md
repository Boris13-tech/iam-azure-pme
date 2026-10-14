# LUXIA Key and LUXIA Identity: integration decision

Status: **PROPOSED, 2026-10-14.** Taken under the sovereign mandate of 2026-10-14 (sections C and D).
- This document is design only. It changes no code in either repository and touches no Production.
- Section 13 lists the points that need the operator.

> **LUXIA Key proves. LUXIA Identity governs. LUXIA Policy decides.**

Evidence labels:
- **VERIFIED:** read in code, a CI log or the Production database (read-only).
- **ASSUMPTION:** to confirm.
- **UNKNOWN:** not established.

Maturity scale (mandate): UNKNOWN → DESIGNED → IMPLEMENTED → VERIFIED → PRODUCTION VERIFIED.
- A merge is not Production.
- CI is not a real scenario.

## 0. Decision in one page

1. **Separate repository.** LUXIA Key stays in `Boris13-tech/Luxia-key`. It is never merged into `iam-azure-pme`.
   - Integration goes through a **versioned protocol and shared test vectors**.
   - No runtime package, database, secret, cookie or session is shared.
2. **A new port, `Authenticator`, distinct from `FederationProvider`.**
   - A federation provider proves an identity that lives in *its* namespace.
   - An authenticator proves possession, presence and intent for an account that *LUXIA already holds*.
   - An authenticator never creates, links or relinks an account.
3. **LUXIA_LOCAL stays the logical connection type** for credentials LUXIA owns.
   - LUXIA Key is **one authenticator** behind it, next to the platform passkey, the security key, TOTP and B2 recovery.
   - Key is never the implementation of LUXIA_LOCAL. LUXIA_LOCAL must keep working when Key is absent or down (rule R3).
4. **End-to-end verification, no Key trust root.**
   - LUXIA Identity verifies every Key proof itself, against a public key it enrolled through a verified ceremony.
   - The proof is signed over a challenge that Identity issued and that is bound to the operation.
   - No key held by the Key server can authenticate a user. A compromised Key server can deny service; it cannot forge a proof.
5. **What Key brings first is a capability of Identity, not Key itself: step-up.**
   - Phase K3 adds a generic step-up to Identity, satisfied first by the passkeys Identity already has.
   - The rule is asymmetric. *Reducing* trust needs no step-up: quarantine and disable must stay fast. *Increasing* trust requires one: release from quarantine, activation, secret promotion, relink.
   - Key later satisfies the same requirement as one more authenticator.
6. **The audit found a real flaw in Identity, already fixed:** [#64](https://github.com/Boris13-tech/iam-azure-pme/pull/64) (section 3).
   - The self-service passkey enrollment stored a public key chosen by the browser, without any WebAuthn ceremony.

## 1. What was audited

All reads were done on a clone, with no write to the Key repository. The old handoff claims were not taken as proof: each one used below was checked again.

| Item | Value | Label |
|---|---|---|
| Repository | `Boris13-tech/Luxia-key`, public, TypeScript | VERIFIED |
| `main` | `4d61d941b94111f0977056a840827e97e092f73c`, 2026-10-08: initial structure and UI prototype | VERIFIED |
| `feat/lk-foundation-001` | `5ffcfbe1dd603748f6736122f6feedd539a0e417`, 2026-10-12: Foundation V1. PR #1 is an OPEN draft, `REVIEW_REQUIRED`; LK-REVIEW-002 not done | VERIFIED |
| CI on `5ffcfbe` | Run 38272439630 "Foundation": typecheck, lint, 30 unit + 34 security + 49 integration tests passed on PostgreSQL 17.6, a persistence probe across a database restart, build, `pnpm audit --audit-level=high`. CodeQL green. 113 tests, as the handoff claimed | VERIFIED (CI log) |
| `feat/security-core-v1` | `65971e7b1af19644e4ebc74bbb95c65ab73b7981`, 2026-10-09: diverges from the others, 2 commits | VERIFIED |
| Relation of `feat/security-core-v1` to Foundation V1 | Probably superseded. Key's own review decides | UNKNOWN |
| Documents read | Product: vision, integration model, identity lock, recovery model. Protocol: WebAuthn, signed actions. Architecture: architecture, data model. Reviews: LK-REVIEW-001, LK-REMEDIATION-001 | VERIFIED |
| Code read | All of `services/api` (414 lines including the SQL migration) and `packages/` | VERIFIED |

## 2. Real state of LUXIA Key

| Component | State | Evidence |
|---|---|---|
| WebAuthn registration and authentication server | **VERIFIED in CI** (not deployed) | See the detail below |
| Challenge store | VERIFIED in CI | Single use, 5 minutes. Burned by one atomic `UPDATE … WHERE used_at IS NULL` *before* the cryptographic checks, so a failed attempt also burns it. Bound to a binding cookie (hash stored), the origin and the rpId |
| Sessions | VERIFIED in CI | Opaque 32-byte token, only its hash stored, 1 hour. Rotated at sign-in. Logout and revoke-all. Re-read under a row lock on the user's security state |
| User security state | VERIFIED in CI | `active` / `locked` / `disabled`, read `FOR UPDATE` before each sign-in |
| Audit | VERIFIED in CI | `audit_events`: allow-listed fields only, append-only by trigger |
| Configuration and runtime | VERIFIED in CI | Origins must be HTTPS and inside the rpId, loopback only in development and test. Same-origin only: exact `Origin` plus a custom header, no CORS. `__Host-` cookies in staging and production. Explicit migrations with a manifest checked at startup |
| Rate limit | IMPLEMENTED, per process | `express-rate-limit`, in memory: not shared between instances |
| Browser SDK (`packages/sdk-js`) | IMPLEMENTED | Same-origin calls only |
| User interface (React) | **PROTOTYPE** | Demo screens. Several flows below are simulated in it |
| Signed actions, QR, pairing, push, recovery, identity lock, TOTP | **DESIGNED or SIMULATED** | Protocol and product documents only. No server code |
| Node SDK, enterprise integrations, LUXIA Identity protocol | DESIGNED: one paragraph in `INTEGRATION-MODEL.md` | "may later consume verified, audience-bound Key assertions through a versioned protocol" |
| Deployment, operations, backups, physical authenticator certification | **UNKNOWN / none** | No environment, no runbook |

Detail of the WebAuthn server:
- `@simplewebauthn/server` 14.0.3, pinned.
- Algorithms ES256 and RS256 only, taken from a server-owned allow-list and never from the library's default.
- User verification required.
- Discoverable credentials.
- Attestation `none`.
- On sign-in, `userHandle` must match the credential's owner.

**Production-grade, after review:**
- the WebAuthn core;
- the challenge store;
- the sessions;
- the append-only audit;
- the configuration validation.

**Not production-grade:**
- **No multi-tenant model.** Users are anonymous UUIDs, with no organization or tenant and no RLS. That is acceptable for an authenticator, but tenant binding must then live in Identity.
- **One credential per user.** "Existing-user credential enrollment requires a later reviewed flow", so a user cannot add a second passkey.
- No recovery.
- Rate limit per process.
- Never deployed.
- No external review completed.
- No device test matrix.

## 3. WebAuthn: LUXIA Identity compared with LUXIA Key

LUXIA Identity verifies its passkeys with its own code, written with `node:crypto`. It has no WebAuthn library (VERIFIED: no `@simplewebauthn` in `package.json` or the lockfile).
- The code is `lib/provider-adapters/implementations/luxia-local/webauthn.ts` (assertion) and `webauthn-registration.ts` (registration, CBOR/COSE reader).
- It is about 160 lines, strict, ES256 only.

| Check | LUXIA Identity (`main` 41d58d2) | LUXIA Key (`5ffcfbe`) |
|---|---|---|
| Registration ceremony verified | Signup, invitation and recovery: yes. **Dashboard self-service enrollment: no** (P1) | Yes, through the library |
| Algorithms | ES256 / P-256 | ES256, RS256 |
| Signature counter | A counter returning to 0 after a positive value was accepted, and reset the stored counter (P2) | Refused by the library (ASSUMPTION: library internals not audited; the P5 oracle will show it) |
| `crossOrigin` on a sign-in | Not checked (P3). Registration already refused it | UNKNOWN (library internals not audited) |
| `userHandle` on a sign-in | Not checked. The binding goes through the credential id and the account (sufficient) | Checked |
| Backup flags (BE/BS) | Ignored | Stored (`device_type`, `backed_up`) |
| "Hardware-bound" | Dashboard enrollment wrote `hardwareBound: true` without proof (P4) | Never claimed |
| Challenge | Hashed, single use, attempt counter, consumed *after* verification | Consumed *before* verification, bound to a cookie |

Findings:
- **P1 (fixed in #64, not deployed yet). VERIFIED:** `POST /api/auth/local/enrollment/complete` received only `credentialId`, `publicKey` and the echoed enrollment challenge, and stored that key as an ACTIVE passkey.
  - **Impact:** a FULL session of an administrator holding `providers.manage` (stolen cookie, XSS, an unattended browser) was enough to add a software key the attacker controls. That passkey outlives every session revocation.
  - Sign-ins with it were recorded as phishing-resistant, hardware-bound and user-verified.
  - **Fix:** the adapter now runs the existing `verifyPasskeyRegistration` (the one signup, invitation and recovery use) and stores only the verified key. A failed ceremony burns the challenge.
  - Tests: 7 refusal cases, plus a mutation check (with the old behavior, the new tests fail).
- **P2 (fixed in #64):** a counter that falls back, to zero included, is now refused.
  - Production read-only check: all `LocalAuthenticator.signCount` values are 0 (VERIFIED), so no existing credential is affected.
- **P3 (fixed in #64):** a sign-in with `crossOrigin: true` is refused, as registration already was.
- **P4 (operator gate G1):** Production has 8 ACTIVE passkeys. 7 carry `hardwareBound = true` (VERIFIED). The dashboard route is the only current code path that writes `true` (VERIFIED by search); that each row came from it is an ASSUMPTION.
  - No policy decision reads this field: it only appears in the evidence and on the "my security" page (VERIFIED by search).
  - #64 stops new false claims. Correcting the 7 rows is a Production write (section 13).
- **P5 (decision, K0b):** Identity keeps its small hand-written verifier, which has no runtime dependency.
  - It gains a **differential test**: the same corpus of valid and forged ceremonies goes through Identity's verifier and through `@simplewebauthn/server`, added as a *dev* dependency only.
  - Any divergence fails CI.
  - Moving the runtime to the library is reconsidered only if a divergence appears or if a new algorithm is needed (RS256, EdDSA).
  - Why: the flaw in P1 was a missing call, not wrong cryptography. A test oracle gives most of the assurance of a library without adding to the runtime supply chain.

## 4. Boundaries

| Concern | LUXIA Key | LUXIA Identity | LUXIA Policy (inside Identity today) | Federation provider (Entra, Google, Keycloak…) |
|---|---|---|---|---|
| Proves | Possession of an enrolled key, user presence and verification, and intent over an action digest | Accepts or refuses a proof | Requires a proof level for an operation | An identity in its own namespace (`iss` + subject) |
| Holds | Device keys and its own anonymous user ids, devices and audit | Organizations, tenants, Subjects, IdentityAccounts, Assignments, Entitlements, sessions, evidence, journal | Rules and their versions | Its directory |
| Never | Decides access, creates or links an account, knows the authority model | Delegates a decision to Key or to a provider | — | Grants an entitlement (R1, R6) |
| Survives the outage of the other | Yes: Key works alone | **Yes: Identity works with no Key at all** | — | Identity works with no provider (R3, R5) |

## 5. Contract: an `Authenticator` port, distinct from `FederationProvider`

DECISION: a new port in Identity, `lib/authenticators/`. It is extracted first from `LuxiaLocalAdapter.verifyCredential`, a refactor with no behavior change; the federation port stays as F1 left it.

```ts
// DESIGNED, not implemented. Names may change; the invariants below may not.
export type ProofPurpose =
  | { kind: "SIGN_IN" }
  | { kind: "STEP_UP"; operation: string; actionDigest: string }; // e.g. "PROVIDER.ACTIVATE", sha256 of the canonical action

export interface Authenticator {
  readonly kind: "WEBAUTHN" | "TOTP" | "RECOVERY_CODE" | "LUXIA_KEY_DEVICE";
  beginEnrollment(ctx: ProviderOperationContext, identityAccountId: string): Promise<EnrollmentChallenge>;
  // Stores only what a verified ceremony proves. Never a key chosen by the caller (lesson of P1).
  completeEnrollment(ctx: ProviderOperationContext, challenge: EnrollmentChallenge, ceremony: unknown): Promise<EnrolledAuthenticator>;
  beginProof(ctx: ProviderOperationContext, identityAccountId: string, purpose: ProofPurpose): Promise<ProofChallenge>;
  // Fails closed. Returns the fields of one AuthenticationEvidence row.
  verifyProof(ctx: ProviderOperationContext, challenge: ProofChallenge, response: unknown): Promise<AuthenticatorProof>;
}
```

| | `FederationProvider` (F1, OIDC core) | `Authenticator` (new) |
|---|---|---|
| Account namespace | The provider's (`iss`, `sub`/`oid`) | LUXIA's: an existing IdentityAccount |
| Result | `VerifiedExternalIdentity`, which Identity *maps* to an IdentityAccount | A proof *for* an IdentityAccount Identity named before the ceremony |
| Can lead to account creation or linking | Only through an explicit, journaled admin step (R10) | **Never** |
| Trust anchor | The issuer's JWKS, fetched through discovery | The public key Identity enrolled, stored in `LocalAuthenticator` |
| Works offline | No | Yes (R3) |
| Binds an operation | No | Yes: `STEP_UP` carries the operation and an action digest |

Invariants, each enforced by a test when implemented:
- **A1.** The challenge of a proof is computed by Identity and stored server-side, and is single use. It is `base64url(sha256(canonical{v:1, audience, organizationId, tenantId, identityAccountId, purpose, operation, actionDigest, nonce, expiresAt}))`.
  - The WebAuthn signature therefore covers the operation itself.
- **A2.** `verifyProof` recomputes the challenge from Identity's stored record, never from the response.
- **A3.** Enrollment stores only the key a verified ceremony proves.
- **A4.** A proof for one organization, tenant, account, operation or action digest never satisfies another (multi-tenant negative tests).
- **A5.** Each proof writes one `AuthenticationEvidence` row with:
  - `source = LOCAL_VERIFIER`, because Identity verified it itself;
  - `sourceRef` naming the authenticator profile and its version;
  - `keyId` = the `LocalAuthenticator` id.
- **A6.** No authenticator method writes `Subject`, `IdentityAccount`, `Assignment` or `ProviderConnection` (architecture test, like R1).
- **A7.** `hardwareBound` is true only with verifiable proof: attestation and an AAGUID policy, which v1 does not have. So it is false everywhere in v1.
- **A8.** The port has no network dependency for local kinds. The `LUXIA_KEY_DEVICE` kind may need Key for its user interface, never for verification.

## 6. Relation to LUXIA_LOCAL

| Option | Verdict | Reason |
|---|---|---|
| (a) Key *is* the implementation behind LUXIA_LOCAL | **Rejected** | Local sign-in, recovery and the last administrator would depend on a separate service. That breaks R3 and R5 and makes Key mandatory |
| (b) LUXIA_LOCAL is the logical type for credentials LUXIA owns; Key is one authenticator under it | **Chosen** | Key stays optional. One place holds LUXIA-owned credentials. Step-up also works for a Subject who signs in through Entra, by using an authenticator of their LUXIA_LOCAL account |
| (c) A separate port, outside LUXIA_LOCAL | Rejected as a *connection*; kept as a *port* | Section 5's port is generic. A third connection type would duplicate accounts, lifecycle and recovery |

A WebAuthn credential created through Key's user interface lives under Key's rpId, for example a hypothetical `key.<domain>` (ASSUMPTION, nothing is deployed). It becomes a `LocalAuthenticator` row with:
- `relyingPartyId` and `allowedOrigin` = Key's values, read from **server configuration** and never from the request;
- the existing assertion verifier, unchanged, which already checks each row's own rpId and origin (VERIFIED: `verifyPasskeyAssertion` uses `authenticator.relyingPartyId` and `allowedOrigin`).

So the first Key integration needs **no new cryptography in Identity**. The open question for K4 is how to label the row: a new `LocalAuthenticatorType` value means an expand-only migration (operator gate); an existing column is the alternative. WebAuthn Related Origin Requests are noted as a later option, not a decision.

## 7. Trust model

- **What Key's server can do:**
  - refuse service;
  - show a wrong action label to the user (mitigated: the action digest is in the signed challenge, and Identity displays the action itself before and after the proof).
- **What it cannot do:**
  - produce a proof without the user's device and user verification;
  - replay a proof (A1, A2);
  - move a proof to another organization, account or operation (A4);
  - change authority (A6).
- **No master key:**
  - no Key signing key is a trust anchor in Identity;
  - no private key of a user is ever exported or escrowed;
  - Identity stores public keys only.
- **Privacy:**
  - Key never receives Identity's Subject ids, organization names or authority data. Identity passes an opaque, per-organization, pseudonymous handle.
  - Key's own users stay anonymous UUIDs.

## 8. Reuse and repository

- **Keep separate.** Key has its own product, governance, review cycle and CI, and can be sold or run alone. Merging it would bring a second user store and a second session system into Identity, which is the "second IAM" the mandate forbids.
- **The protocol, not the code, is shared.**
  - `LUXIA-KEY-IDENTITY-PROTOCOL v1` (to write in K2) defines the enrollment relay, the proof challenge (A1), the response format and the error codes.
  - A **test-vector file** (valid and forged cases) is copied, with a version pin, into both repositories. Each CI runs it.
- **What Identity reuses from Key:**
  - its ideas: atomic burn of a challenge before the cryptographic checks; binding a challenge to the browser that asked for it; storing the backup flags;
  - its library choice, as a test oracle (P5).
- **What Key could reuse from Identity:** the B2 recovery model, the evidence fields and the journal discipline, as documents for Key's own review.
- **No runtime dependency** in either direction:
  - no npm package of Key in Identity's `dependencies`;
  - no shared database, role, secret or cookie.

## 9. What Key brings to F2, F3, F4 and R10

| Operation | Phase | Direction of trust | Step-up (K3) | Note |
|---|---|---|---|---|
| Disable, quarantine a connection | F2 | Reduces | **No** | Containment must be fast. Kept: dry-run count, explicit confirmation, `PROVIDER.*` journal (decision D3) |
| Release from quarantine, activate (TESTING → ACTIVE) | F2, F4 | Increases | **Yes** | Re-enabling a compromised provider is the dangerous direction |
| Promote a candidate secret to active | F3 | Increases | **Yes** | Lockout and takeover risk |
| Create or activate an OIDC_GENERIC connection | F4 | Increases | **Yes** | A new issuer that can sign people in |
| Relink IdentityAccounts to a new connection | R10 | Increases | **Yes**, for the administrator | The Subject's own LUXIA_LOCAL authenticator, if present, also confirms. A malicious IdP must not capture a Subject through a relink |
| Operator break-glass (B4/B5) | — | — | Unchanged | Closed operator procedure. **Never requires Key** |

K3 needs no Key. It ships with the WebAuthn authenticator Identity already has, so F2 to F4 gain step-up without waiting for Key. When Key is integrated (K4), it satisfies the same requirement.

**Order:** K3 lands after F2 and **before F4 and R10 go to Production**.

## 10. What Key must never do

| # | Never | Enforced by |
|---|---|---|
| N1 | Be a second IAM: no organizations, roles, entitlements or access decisions in Key | Key's own architecture review. Identity: A6 |
| N2 | Hold a master key: no server key that authenticates users, no escrow of user private keys | Section 7. No Key trust anchor exists in Identity's code (architecture test in K4) |
| N3 | Be mandatory for Identity | R3 suites run with Key absent. K5 outage drill. The last administrator always has a non-Key authenticator or B2 recovery (B1 guard extended in K4) |
| N4 | Create, link or relink an account | A6, and section 5's table |
| N5 | Store Identity's tenant or authority data | Section 7 privacy. Protocol v1 carries only opaque handles |
| N6 | Share a database, role, secret, cookie or session with Identity | Separate deployments. Architecture test on configuration in K4 |
| N7 | Handle workloads, services or agents in F1 to F6 | Out of scope. `WORKLOAD_KEY`, `SERVICE_KEY` and `AGENT_KEY` stay unused for Key |
| N8 | Claim an assurance it cannot prove | A7 |

## 11. Path to Production

| Phase | Where | Content | Exit state | Gate |
|---|---|---|---|---|
| **K0** | Identity | This audit and decision; fix P1 to P3 (#64) | #64 VERIFIED in CI. PRODUCTION VERIFIED after its deployment, which follows F1 | Low-risk deploy rule |
| K0b | Identity | Differential WebAuthn test against the library (P5), dev dependency only | VERIFIED | none |
| K1 | Key | LK-REVIEW-002 done, PR #1 merged in Key, `feat/security-core-v1` closed or rebased by Key's own review | VERIFIED in Key | Key's own review |
| K2 | Both | `LUXIA-KEY-IDENTITY-PROTOCOL v1` and test vectors | DESIGNED, then VERIFIED in both CIs | none |
| **K3** | Identity | `Authenticator` port (refactor), generic step-up with A1 to A8, applied as in section 9, using existing passkeys | VERIFIED. Production follows the F-phase it ships with | Production migration if a table is added |
| K4 | Identity | `LUXIA_KEY_DEVICE` authenticator, off by default, enabled per organization; architecture tests N2, N3, N6 | VERIFIED | Expand-only migration for the type value, if chosen |
| K5 | Both | Key deployed to an EU staging environment. Device matrix: Windows Hello, macOS/iOS, Android, a FIDO2 security key. Key outage drill: Identity sign-in, recovery and break-glass unaffected | VERIFIED (real devices) | **Spend** (hosting) and data-protection review |
| K6 | Production | One pilot organization opts in | **PRODUCTION VERIFIED**, only after section 12's proof | **Operator.** Legal: subprocessor and privacy pages if Key is hosted elsewhere |

## 12. Certification plan

**PRODUCTION VERIFIED for "LUXIA Key as an authenticator of LUXIA Identity" requires, in Production, on one pilot organization:**
1. A Key enrollment by a real user on a real device. The `LocalAuthenticator` row carries Key's rpId and origin and `hardwareBound = false`, and enrollment evidence is written.
2. A real step-up through Key on a section 9 operation, with an evidence row whose `operation` and action digest match the operation performed.
3. Negative tests run live:
   - proof replayed;
   - proof for another operation;
   - proof for another organization;
   - expired challenge.

   Each is refused with the generic error and leaves a journal entry.
4. **Key outage drill:** Key stopped, then:
   - LUXIA_LOCAL sign-in still works;
   - B2 recovery still works;
   - an Entra sign-in still works;
   - step-up still works with a platform passkey.
5. A read-only before/after digest of the organization's authority (Subjects, Assignments, ProviderConnections) is unchanged.

Before that, in CI: the A1 to A8 and N2/N3/N6 tests, the shared vectors in both repositories, and the differential test (P5).

## 13. Decisions

Taken under the mandate's autonomy (reversible, no Production change):
- sections 0 to 12;
- the fix in #64 (deployment after F1 is PRODUCTION VERIFIED).

**For the operator:**

| # | Decision | Recommendation | Why a gate |
|---|---|---|---|
| G1 | Correct `hardwareBound` on the 7 existing passkeys (`true` → `false`), with a read-only before and after, journaled as an operator correction | **Yes**, after #64 is in Production | Production data write |
| G2 | Hosting for Key staging and later production (EU) | Decide at K5, with a cost estimate | Spend |
| G3 | Data-protection and subprocessor update if Key runs outside the current processors | Decide at K5/K6 | Legal commitment |

## 14. Risks

| Risk | Mitigation |
|---|---|
| Hand-written WebAuthn code hides another missing check | P5 differential test. #64 covers enrollment. Reviewed again in K0b |
| Step-up slows emergency containment | Asymmetric rule: quarantine and disable never need step-up |
| Key's user interface becomes a phishing surface for Identity actions | The action digest is in the signed challenge. Identity shows the action itself and verifies end to end (section 7) |
| Scope creep turns Key into a second IAM | N1 to N8, reviewed at each K gate |
| Key is never deployed and K3 waits for it | K3 does not depend on Key: it uses existing passkeys |
