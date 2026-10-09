# PR14 read-only Session delta attribution

Production deployment: dpl_6dxDToNgg8V3ZZMQX9RerfuZZEZM.
Deployed SHA: 5704558f5c343ae653c8984917b90a760caeabf1.
No Production write, login, revocation, rollback or bootstrap was performed during this investigation.

## Session #59

Non-usable fingerprint (MD5 of the already-hashed database identifier): 5dbf39fc11cb51412584655581cc7437.
The database session identifier, cookie and token were never selected for output.

- createdAt: 2026-10-08T14:13:00.792Z
- expiresAt: 2026-10-09T14:13:00.791Z
- revokedAt: null
- lastSeenAt: 2026-10-08T14:13:00.810Z
- organizationId: 4841428a-80b4-4f07-bb3f-c94612dfd4a2
- tenantId: c68ae9ee-11a8-42f9-bc9c-b19c42ec7914
- subjectId: 30a15eda-24d3-40ef-8705-11c2e6e1b929
- identityAccountId: 211fd18b-62cd-4fdf-85b1-731ae3c1cf24
- providerConnectionId: fde0704e-0d1c-4c47-b53e-f19a60f1748d
- providerType: MICROSOFT_ENTRA
- providerName: Microsoft Entra — Legrand Tech
- ipHash: d6e290273be31c560cd95b2b6ab7eee431c0719e7c58bf3d812d57be96666680
- userAgentHash: c4ea766a755ddee08f488270809d57453d14de55e76ff46b7a9b02b099f0d440

## Correlation

Vercel request paths were sanitized by removing query strings; raw provider/error responses were not printed.

- 14:12:51.495Z: /auth/logout, HTTP 303.
- 14:12:51.698Z: prior operator session revoked (fingerprint 26846f4d62b26e53698bc00e2f9aa834; same Subject/Organization/Tenant).
- 14:12:59.766Z: /auth/callback, HTTP 307.
- 14:13:00.792Z: new operator Entra Session created.
- 14:13:00.909Z: /dashboard, HTTP 200; subsequent authenticated dashboard requests HTTP 200.
- 14:15:34.569Z: RESOURCE.ONBOARDING.PLAN SUCCESS.
- 14:15:40.078Z: RESOURCE.ONBOARDING.CONFIGURE SUCCESS.
- 14:15:46.912Z: RESOURCE.CAPABILITY.READ DENIED, actual HTTP 403.

No LUXIA_LOCAL completion or AuthenticationEvidence row was found in this window. This Entra callback path creates the Session directly; absence of a local authentication evidence row is not synthesized into evidence.

The initial snapshot's 14:13:06.503Z timestamp was emitted AFTER its read transaction, not a PostgreSQL snapshot-start timestamp. Consequently it is invalid as a lower bound for Session creation. The new row predates that completion timestamp yet was absent from the transaction snapshot. The simple 58 -> 59 count gate conflated concurrent operator authentication with onboarding.

Session delta attribution: PASS — normal operator logout/Entra login before configuration.
Onboarding-induced Session creation/revocation/reassignment: NONE.
Other-Subject/cross-tenant Sessions created in the authentication/configuration window: 0.
Unexpected Session mutation attributable to onboarding: NONE.

Historical caveat: the original report retained only a whole-table digest, not per-row old values. A byte-for-byte reconstruction of every prior lastSeenAt value is therefore unavailable. We do not label that unavailable historical comparison PASS. The old revoked session is positively attributable to logout, not onboarding.

## Static path review / corrected invariant

Both onboarding and protected-resource routes call requireAuth -> getAuthContext -> SessionStore.getSession -> resolve_session. getSession may update lastSeenAt after five minutes; it cannot issue a Session. Configuration writes Resource, ResourceScope, Entitlement and canonical audit only, atomically. Capability evaluation writes canonical audit only. requireNative/evaluateResourceAccess/evaluateSoD do not issue or reassign Sessions. The CanonicalAdminError import does not invoke separate session administration functions.

The only production SessionStore.createSession callers in the reviewed tree are app/auth/callback/route.ts and app/api/auth/local/complete/route.ts. Neither is reachable from onboarding services.

Preservation means no onboarding-induced creation, unexpected revocation/reassignment, other-Subject or cross-tenant effect. Authentication changes must be separately attributable. Legitimate lastSeenAt refresh is permitted. No product code was changed.

## Read-only binding revalidation at 14:26:46–14:26:54 UTC

Exact active API Resource, RESOURCE scope and resource.read Entitlement: PASS.
Bootstrap Assignment count: 0. Existing Assignment count: 21, original digest unchanged.
Subject/IdentityAccount/Organization/Tenant/ProviderConnection/legacy digests: unchanged.
Existing 21 Entitlements excluding the new binding: unchanged.
ResourceScopeMember count: 0; no SoD policy or review campaign introduced.
app_user NOSUPERUSER/NOBYPASSRLS: PASS.
Cross-tenant Resource/Scope/Entitlement/audit visibility: NONE under app_user RLS.
Persisted DENIED evidence: e97e9a5d-c103-4efb-b835-e5d11e77e9c7.
Protected route: last actual authenticated test HTTP 403; binding remains active with zero effective grant. No fresh authenticated request/login was manufactured during read-only forensics.
Session whole-table digest remains unchanged from the post-configuration snapshot.

## Immutable manifest

Original JSON bytes remain untouched. Recomputed SHA-256:
95e9b80de3e28890faf01eb41fb70002d6ef1efb6986815da8b8868799376232.

Window: 2026-10-08T14:00:00Z through 2026-10-08T15:00:00Z (exclusive upper bound), valid at revalidation.
Assignment ID: d19ec5fa-dc0a-4edc-b186-0735d1533c64.
Operation ID: 6bb7d556-4920-428b-9ec6-e219c6ff69e0.
Approval: NOT APPROVED. Execution: NOT EXECUTED.
Detached explicit human approval is still required. At expiry permanently abandon this artifact for execution and issue new IDs/times/digest; never edit or extend its bytes.

STOP before any grant.
