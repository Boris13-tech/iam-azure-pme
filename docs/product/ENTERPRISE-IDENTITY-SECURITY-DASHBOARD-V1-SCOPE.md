# LUXIA Identity — Enterprise Identity Security Dashboard v1: scope proposal

Status: **PROPOSAL, awaiting operator validation.** No code, migration, PR12 change or Production change is part of this document.
Baseline: `main` @ `6d1e2df`. Production `8acea18` (application code identical).

## 0. Principles

- **Real canonical data only.** Every number comes from a named query on the canonical model (`Subject`, `IdentityAccount`, `Session`, `Assignment`, `Entitlement`, `Resource`, `ResourceScope`, `SoD*`, `AccessReview*`, `CanonicalAdminAuditEvent`, `LocalIdentity`, `LocalAuthenticator`, `CredentialReenrollmentRequirement`, `ProviderIdentityCollision`, `AuthenticationEvidence`). Legacy `User`/`Role` tables are never a source.
- **No score, no estimate, no trend extrapolation.** "Needs attention" items are deterministic rules with a documented definition. They are not risk scores.
- **Server-side permission gating per widget**, using the existing `checkPermission` and catalog keys. Queries run under `withTenantDb`, which applies forced RLS (every source table above is `ENABLE` + `FORCE ROW LEVEL SECURITY`).
- **Aggregates by default.** Names appear only in drill-down lists and the activity feed, for holders of the matching `.read` entitlement.
- **No migration.** Everything in "Build now" reads existing tables.

### Value states (mandatory, applied to every widget)

| State | Meaning | UI |
|---|---|---|
| `ok` with value `0` | The query ran and the real count is zero | shows **0** |
| `unavailable` | The source exists but the value could not be produced (query error/timeout), or the data is not recorded for this case (e.g. Entra sign-in evidence) | "Indisponible", plus the reason code; never 0 |
| `not_implemented` | The capability does not exist yet in LUXIA | "Non disponible dans cette version"; never 0 |
| `restricted` *(proposed 4th state)* | The viewer lacks the entitlement | widget **hidden** (not 0, not "unavailable"); the section shows how many widgets were hidden for lack of rights |

The API returns `{ state, value?, reason?, asOf }` per widget. The UI never coerces a missing value to 0.

## 1. Target layout

```
Identity Security Posture   (header: org/tenant, asOf, attention list — no score)
├─ Identity                 Who exists?
├─ Sessions & Authentication Who is authenticated?
├─ Access                   Who has access to what?
├─ Resources                What resources are protected?
├─ Governance               What governance action needs attention?
└─ Recent Security Activity What happened?
```

## 2. Sections and widgets

Notation: **Perm** = required catalog entitlement. **Src** = exact source. **Drill** = destination.

### 2.1 Identity Security Posture (header)

| Widget | Src | Perm | Drill |
|---|---|---|---|
| Organization / tenant, "data as of" timestamp | `loadPlatformContext` + server time | authenticated | — |
| **Attention list**: one line per rule below whose count is > 0, with count and link | union of the "⚠" rules in §2.2–2.6 | per-rule perm (rules the viewer cannot see are omitted) | each rule's drill |
| Empty state | all visible rules = 0 | — | "Aucun point d'attention détecté sur les données visibles." (explicitly scoped to the visible data, not "secure") |

### 2.2 Identity: "Who exists?"

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| Subjects by lifecycle (PROVISIONING, ACTIVE, SUSPENDED, DISABLED, RECOVERY_REQUIRED, RETIRED) | `Subject` groupBy `lifecycleState` | `subjects.read` | 0 per bucket | `/dashboard/users` |
| Subjects by type (HUMAN, WORKLOAD, SERVICE, DEVICE, AI_AGENT) | `Subject` groupBy `type` | `subjects.read` | 0 | `/dashboard/users` |
| Identity accounts by provider type × status | `IdentityAccount` ⨝ `ProviderConnection.providerType`, groupBy `status` | `identity_accounts.read` | 0 | `/dashboard/users` |
| ⚠ Subjects in RECOVERY_REQUIRED | `Subject.lifecycleState = RECOVERY_REQUIRED` | `subjects.read` | 0 | `/dashboard/users` |
| ⚠ ACTIVE subjects with **no** ACTIVE identity account | `Subject` ACTIVE with no `IdentityAccount.status = ACTIVE` | `subjects.read` + `identity_accounts.read` | 0 | `/dashboard/users` |
| ⚠ Unresolved provider identity collisions | `ProviderIdentityCollision.resolvedAt IS NULL` | `providers.read` | 0 | providers page = `not_implemented` on main (PR12) → no link |

### 2.3 Sessions & Authentication: "Who is authenticated?"

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| Active sessions | `Session` `revokedAt IS NULL AND expiresAt > now` | `sessions.read` | 0 | sessions page `not_implemented` → no link (v1) |
| Distinct subjects with an active session | same, `count(DISTINCT subjectId)` | `sessions.read` | 0 | — |
| Active sessions by provider type (MICROSOFT_ENTRA / LUXIA_LOCAL) | `Session` ⨝ `IdentityAccount` ⨝ `ProviderConnection` | `sessions.read` | 0 | — |
| Sessions started 24 h / 7 d; revoked 7 d | `Session.createdAt`, `revokedAt` | `sessions.read` | 0 | `/dashboard/audit?operation=SESSION.REVOKE` |
| Passkeys / security keys by status (ACTIVE, SUSPENDED, REVOKED, COMPROMISED, EXPIRED) | `LocalAuthenticator` groupBy `type, status` | `identity_accounts.read` *(see decision D2)* | 0 | — |
| ⚠ Compromised local authenticators | `LocalAuthenticator.status = COMPROMISED` | idem | 0 | — |
| ⚠ Locked / recovery-required local identities | `LocalIdentity.status IN (LOCKED, RECOVERY_REQUIRED)` or `lockedUntil > now` | idem | 0 | — |
| ⚠ Pending credential re-enrollments | `CredentialReenrollmentRequirement.status = PENDING` | idem | 0 | — |
| LUXIA_LOCAL sign-in evidence, 7 d: VERIFIED vs REJECTED, phishing-resistant share | `AuthenticationEvidence` (`occurredAt`, `outcome`, `phishingResistant`) | `audit.read` | 0 | — |
| Entra sign-in evidence | **not recorded**: `AuthenticationEvidence` is written only by `/api/auth/local/complete` | — | **`unavailable`** (`ENTRA_EVIDENCE_NOT_RECORDED`) | — |
| MFA / Conditional Access status from Entra | needs Microsoft Graph | — | **`not_implemented`** (PR12 / future) | — |

Never displayed: `Session.id`, `ipHash`, `userAgentHash`, credential IDs, public keys, `secretRef`.

### 2.4 Access: "Who has access to what?"

"Effective" uses the existing `isAssignmentEffective` semantics: `status = ACTIVE`, inside the `validFrom`/`validUntil` window, and entitlement `active`.

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| Effective assignments / distinct holders | `Assignment` ⨝ `Entitlement` (effective) | `assignments.read` | 0 | `/dashboard/resources` |
| By source (DIRECT, PROVIDER, POLICY, SYSTEM, LEGACY_ROLE) | groupBy `source` | `assignments.read` | 0 | — |
| Time-bound vs permanent (`validUntil` null) | effective, split on `validUntil` | `assignments.read` | 0 | — |
| Administrative entitlement holders, per catalog key (e.g. `assignments.manage`, `sessions.revoke`, `resources.manage`) | effective `Assignment` on `Entitlement.key ∈ ENTITLEMENT_CATALOG_V1` where action ∈ {manage, revoke, disable, link, create, update, delete, decide} | `assignments.read` | 0 | — |
| ⚠ **Effective access held by non-ACTIVE subjects** (SUSPENDED, DISABLED, RETIRED, RECOVERY_REQUIRED) | effective `Assignment` ⨝ `Subject.lifecycleState ≠ ACTIVE` | `assignments.read` + `subjects.read` | 0 | `/dashboard/users` |
| ⚠ Assignments expiring within 7 days | effective and `validUntil ≤ now + 7 d` | `assignments.read` | 0 | — |
| ⚠ `ACTIVE` rows whose window has already ended (status not reconciled) | `status = ACTIVE AND validUntil ≤ now` | `assignments.read` | 0 | — |
| ⚠ Effective LEGACY_ROLE-sourced assignments | `source = LEGACY_ROLE` | `assignments.read` | 0 | — |

### 2.5 Resources: "What resources are protected?"

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| Active resources by type (APPLICATION, API, … AI_TOOL) | `Resource.active` groupBy `type` | `resources.read` | 0 | `/dashboard/resources` |
| Scopes by kind (RESOURCE, RESOURCE_GROUP, TENANT) | `ResourceScope.active` groupBy `kind` | `resources.read` | 0 | `/dashboard/resources` |
| Active resource-scoped entitlements | `Entitlement.active AND resourceScopeId IS NOT NULL` | `resources.read` | 0 | `/dashboard/resources` |
| Resources with **no effective** assignment (protected, nobody has access) | active `Resource` with no effective `Assignment` through its scopes' entitlements | `resources.read` + `assignments.read` | 0 | `/dashboard/resources/onboarding` |
| Provider-bound vs native resources | `providerConnectionId` null / not null | `resources.read` | 0 | — |

### 2.6 Governance: "What action needs attention?"

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| SoD policies ACTIVE / DISABLED, enabled rules | `SoDPolicy.status`, `SoDRule.enabled` | `sod.read` | 0 | `/dashboard/governance/sod` |
| SoD-denied grant attempts, 30 d | `CanonicalAdminAuditEvent.operation = ASSIGNMENT.DENIED.SOD` | `sod.read` | 0 | `/dashboard/governance/sod` |
| **Existing** SoD violations among current assignments (detective) | not implemented (the SoD engine is preventive only) | — | **`not_implemented`** | — |
| Access review campaigns OPEN / COMPLETED | `AccessReviewCampaign.status` | `access_reviews.read` | 0 | `/dashboard/governance/access-reviews` |
| ⚠ Overdue open campaigns | `status = OPEN AND dueAt < now` | `access_reviews.read` | 0 | idem |
| ⚠ Pending review items / items REQUIRES_REMEDIATION | `AccessReviewItem.reviewState` | `access_reviews.read` | 0 | idem |
| ⚠ **My** pending decisions | `AccessReviewItem.reviewerSubjectId = me AND decision = PENDING` | `access_reviews.decide` | 0 | idem |

### 2.7 Recent Security Activity

| Widget | Src | Perm | Empty / unavailable | Drill |
|---|---|---|---|---|
| Last 20 **changes and denials**, excluding `*.READ` noise: operation, result, actor name, target name, time | `CanonicalAdminAuditEvent` (exclude operations ending `.READ`) ⨝ `Subject.name` | `audit.read` | "Aucun événement" (real 0) | `/dashboard/audit` |
| DENIED / FAILURE events, 24 h and 7 d | groupBy `result` | `audit.read` | 0 | `/dashboard/audit` |
| Privileged changes, 7 d (ASSIGNMENT.GRANT/REVOKE, ROLE.GOVERNANCE.*, SESSION.REVOKE, IDENTITY_ACCOUNT.DISABLE/LINK, RESOURCE.ONBOARDING.BOOTSTRAP*, PROVIDER.*) | operation allow-list | `audit.read` | 0 | `/dashboard/audit` |

## 3. Security and privacy considerations

1. **Gate each widget server-side.** Never send data and hide it client-side. The `entitlements` array returned to the client remains the viewer's own.
2. **One transaction under `withTenantDb`** (RLS context), with a statement timeout. A widget that fails returns `unavailable`; the others still render.
3. **No sensitive identifiers.** No session hashes, IP/UA hashes, credential material or external object IDs in the aggregate payload. Names only where a `.read` permission already exposes them.
4. **Audit of the dashboard read** (decision D1). Today `/api/dashboard` does not audit. The list APIs write one `*.READ` event per call. Proposal: one `DASHBOARD.POSTURE.READ` event per load, so the dashboard does not trigger N list-read events. That event is excluded from the activity feed.
5. **Cross-tenant.** Tests prove that a foreign-tenant viewer sees only its own counts (RLS) and that drill links carry no foreign IDs.
6. **`Cache-Control: no-store, private`**; no client-side persistence.
7. **Pre-existing finding (separate fix, out of scope):** `GET /api/canonical/sessions` returns full `Session` rows, including `id`, `ipHash` and `userAgentHash`, to `sessions.read` holders. Recommend a projection, in its own hardening PR.

## 4. Feasibility classification

| Bucket | Content |
|---|---|
| **Build now: no migration, existing data, one new read endpoint** | §2.1–2.7, except the items listed below. Implemented as `GET /api/canonical/posture` (or an extension of `/api/dashboard`) returning per-widget states, plus the new page layout. |
| **Needs new endpoints/pages, no migration** | Sessions list page (projected, no hashes); provider collisions page; "my pending reviews" shortcut. Optional for v1. |
| **Needs a new feature slice (code, no migration)** | Recording `AuthenticationEvidence` for Entra sign-ins; detective SoD scan over existing assignments. |
| **Waits for PR12 / future** | Provider health / operational status / sync runs (`ProviderOperationalStatus`, `ProviderSyncRun` exist only in PR12); Entra MFA / Conditional Access / last sign-in (Graph); inactive-account detection based on provider sign-in data. |

## 5. Recommended order and complexity

| # | Step | Complexity |
|---|---|---|
| 1 | Endpoint skeleton: per-widget state contract (`ok`/`unavailable`/`not_implemented`/`restricted`), permission gating, RLS transaction, timeout, D1 audit; tests for the state model and permission matrix | **M** |
| 2 | Identity + Access (incl. ⚠ non-ACTIVE subjects holding access, expiring, stale ACTIVE, LEGACY_ROLE) | **M** |
| 3 | Sessions & Authentication (local authenticators, locks, re-enrollment, LUXIA_LOCAL evidence; Entra = `unavailable`) | **M** |
| 4 | Resources (incl. resources with no effective holder) | **S** |
| 5 | Governance (SoD + Access Reviews, incl. "my pending decisions") | **S–M** |
| 6 | Recent Security Activity (noise filter, privileged allow-list, actor/target names) | **S** |
| 7 | Posture header attention list + new page layout (FR), empty/unavailable/not-implemented rendering | **M** |
| 8 | Certification: unit + PostgreSQL/RLS tests on a clone, cross-tenant, payload privacy test, build, CI, non-mutating Production smoke | **M** |

Overall: about 2–3 working sessions of implementation plus certification. No migration, no Production data change.

## 6. Acceptance criteria

1. Every displayed number maps to a documented query (this file), and a test asserts the value against seeded data.
2. `0`, `unavailable`, `not_implemented` and `restricted` are distinct in the API and the UI. A test proves that an `unavailable` source never renders as 0.
3. Permission matrix test: for each widget, the viewer **without** the entitlement receives `restricted` and no data. The viewer with it receives the data.
4. RLS / cross-tenant test on PostgreSQL with `app_user`: no foreign-tenant contribution to any count.
5. Payload privacy test: no `ipHash`, `userAgentHash`, session id, credential material or `secretRef` in the response.
6. One dashboard load writes at most one audit event (per D1) and zero writes elsewhere. A test asserts that no business table changes.
7. Response time ≤ 1.5 s p95 at current scale, with a 5 s statement timeout leading to per-widget `unavailable`.
8. No migration, no PR12 dependency, no change to authorization logic. CI PASS on the exact SHA. A Production smoke after an explicitly approved deploy.

## 7. Decisions requested from the operator

- **D1**: audit each dashboard load as a single `DASHBOARD.POSTURE.READ` event (recommended), or no audit (current behaviour).
- **D2**: there is no `authenticators.read` key in the catalog. Gate local-authenticator widgets with `identity_accounts.read` (recommended, no catalog change), or add a new key (catalog change, later).
- **D3**: accept the 4th state `restricted` (hidden widget) in addition to the three mandated states.
- **D4**: v1 includes only "Build now", with sessions/collision pages deferred (recommended), or also the optional new pages.
- **D5**: note that `LUXIA_ORG_ADMIN` v1 does not include `sod.read` / `access_reviews.read`. Governance widgets are therefore `restricted` for that bundle alone. No bundle change is proposed in this slice.
