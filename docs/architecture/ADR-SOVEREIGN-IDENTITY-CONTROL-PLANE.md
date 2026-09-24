# ADR: Sovereign Identity Control Plane

- Status: Accepted foundation; roadmap and product-boundary sections partially superseded after Phase 6C
- Date: 2026-09-20
- Baseline: `0dd1d65b94124de69c9ef94d535027a6631c2e68`
- Scope: Architecture after Phase 5F
- Decision owner: LUXIA Identity

> Post-6C note (2026-09-23): the sovereign core, canonical `Subject`, provider-adapter direction, deployment model, and offline invariants remain accepted. Sections that place authorization policy, relationship trust, or tamper-evident history inside LUXIA Identity, and the Phase 6D-12 ordering, are superseded by `ADR-POST-6C-IDENTITY-REALIGNMENT.md`. That ADR preserves the validated 6A-6C implementation while assigning Trust Graph, Policy, Trust Ledger, and AI governance to explicit product boundaries.

## Context and decision

Phase 5F is validated on staging in native authorization mode. Gate0 and the extended soak passed, including 1,015 of 1,015 scenarios, with no authorization divergence, provider-path error, ghost grant, or reconciliation drift. Production was not modified.

LUXIA Identity will evolve into a **Sovereign Identity Control Plane**. The LUXIA core, rather than any external identity provider, owns the canonical identity, authorization state, policy state, and audit history. Microsoft Entra, Google Workspace, AWS, GitHub, LDAP, Active Directory, Samba AD, custom APIs, and the native local provider are integrations around that core.

The following constraints are architectural invariants:

1. `Subject` remains the canonical identity abstraction.
2. Provider-specific identifiers remain on provider-facing records and never become core subject identifiers.
3. `Organization`, `Tenant`, `Subject`, `IdentityAccount`, `ProviderConnection`, `Resource`, `Entitlement`, `Assignment`, and `Session` remain the core vocabulary.
4. Cloud, Hybrid, and Sovereign deployments share one codebase and one domain model.
5. Authentication, authorization, lifecycle administration, policy evaluation, and audit must be able to operate without Microsoft, another cloud provider, LUXIA Cloud, or continuous Internet access.
6. Providers are replaceable adapters. Provider availability may enhance LUXIA, but it must not determine whether the core can identify a subject or evaluate access.
7. Phase 6A does not start in this ADR. This document records boundaries, migration order, and evidence requirements only.

## 1. Current architecture

The current repository contains two overlapping generations of identity data:

- The legacy layer uses `User`, `Role`, `Permission`, `UserRole`, `RolePermission`, `AuditLog`, and `AccessPolicy`. `User.azureId` embeds an Entra-specific external identifier.
- The native identity foundation uses `Organization`, `Tenant`, `Subject`, `IdentityAccount`, `ProviderConnection`, `Resource`, `Entitlement`, `Assignment`, and `Session`.
- `LegacyUserBridge` and the dual-write/backfill services preserve continuity while legacy records are being retired.
- Native authorization evaluates canonical entitlement keys against active, tenant-scoped assignments. It is deterministic, fail-closed, and does not call Microsoft Graph or inspect provider type.
- Tenant isolation is enforced through scoped database access and PostgreSQL row-level security. Session lookup uses the constrained `resolve_session(text)` database function.
- `AUTHZ_MODE` retains legacy, shadow, native-shadow-legacy, and native modes for controlled migration. Staging is validated in `native` mode.
- Authentication currently uses an Entra-specific OIDC path. A session is nevertheless bound to the provider-neutral tuple `organizationId`, `tenantId`, `subjectId`, and `identityAccountId`.

The native schema is therefore a suitable sovereign core, but the authentication and user-lifecycle edges still assume Entra in several places.

## 2. Existing Microsoft/Entra coupling inventory

### Domain and persistence

| Hotspot | Coupling | Required direction |
| --- | --- | --- |
| `prisma/schema.prisma` — `User.azureId` | Provider-specific identifier on the legacy user | Keep during compatibility window; stop writing it after native lifecycle cutover, then retire through a separate migration |
| `ProviderType` | Supports several providers but lacks `LUXIA_LOCAL`, `LDAP`, `ACTIVE_DIRECTORY`, and `SAMBA_AD` | Add explicit types in a backward-compatible migration after the adapter boundary exists |
| `ProviderConnection.externalScopeId` and `IdentityAccount.externalObjectId` comments | Examples are Entra-centric, though the fields are structurally generic | Define them as opaque adapter-owned identifiers and document normalization rules |
| `LegacyUserBridge` and `lib/db/legacy-user-mapper.ts` | Migration creates an identity account only when `azureId` exists and requires a provider connection in its context | Generalize migration inputs after a local identity path exists; preserve bridge IDs and idempotency |

### Authentication and session edges

| Hotspot | Coupling | Required direction |
| --- | --- | --- |
| `lib/auth/providers/entra.ts` | Entra discovery, client credentials, issuer, and redirect URI are concrete functions | Move behind the adapter/authenticator boundary |
| `app/auth/login/route.ts` | Rejects every provider except `MICROSOFT_ENTRA` and directly builds an Entra authorization request | Resolve a provider by connection and dispatch through its authentication capability |
| `app/auth/callback/route.ts` | Imports Entra configuration, assumes `tid` and `oid`, and constructs a Microsoft issuer | Delegate claim validation and external identity extraction to the selected adapter |
| `app/auth/logout/route.ts` | Contains an Entra-only federated logout branch | Delegate optional upstream logout to the adapter; local session revocation always remains authoritative |
| `app/login/page.tsx` | Selects the first Entra connection and presents Microsoft-specific copy | Present configured sign-in methods, including local authentication, without selecting an identity owner for the customer |
| `lib/jwt.ts` | Uses Microsoft common JWKS and Microsoft issuer rules | Retain only inside the Entra adapter or replace with provider-specific verifier implementations |
| `lib/auth.ts` | Instantiates MSAL from global Graph/tenant environment variables | Move into Entra adapter composition and connection-scoped secret resolution |

### Provisioning and lifecycle

| Hotspot | Coupling | Required direction |
| --- | --- | --- |
| `lib/graph.ts` | Microsoft Graph client, synchronization, creation, status update, and profile update are a single global service | Recast as the first production `ProviderAdapter`; remove global-provider assumptions |
| `app/api/users/route.ts` | Creates an Azure user directly when Graph credentials exist and stores `azureId` on `User` | Make the core subject transaction authoritative; invoke provisioning through an outbox-backed adapter command |
| `app/api/users/[id]/route.ts` | Updates or disables Entra directly based on `User.azureId` and global environment variables | Apply the canonical lifecycle change first and propagate through adapter commands with explicit status and retry semantics |
| `app/api/graph/route.ts` | Exposes a Microsoft-specific synchronization endpoint | Replace eventually with provider-connection operations, authorization, and auditable job status |

### Product surface, configuration, and verification

| Hotspot | Coupling | Required direction |
| --- | --- | --- |
| `app/dashboard/layout.tsx`, `app/dashboard/settings/page.tsx` | Entra/Azure terminology appears in primary UX | Use provider-neutral language in People, Access, and Protect; expose provider detail under Advanced |
| `package.json` | Microsoft Graph and MSAL packages are application-level dependencies | They may remain initially, but their imports must be confined to the Entra adapter package/boundary |
| `scripts/e2e-http.ts`, `scripts/soak/run-soak.ts`, `.github/workflows/staging-soak.yml` | Fixtures require `MICROSOFT_ENTRA`; login assertions expect Microsoft URLs | Retain as Entra regression coverage and add provider-neutral contract plus `LUXIA_LOCAL` matrices; do not simply replace the Entra tests |

The authorization engine (`lib/auth/authorization-engine.ts`) is not coupled to Entra. Its inputs are organization, tenant, subject, action, and resource. This is the boundary to preserve.

## 3. Target Sovereign architecture

The target has a provider-independent domain core surrounded by ports and adapters:

```text
Admin UI / API / local CLI
          |
Identity application services
  - subject lifecycle
  - authentication orchestration
  - authorization and policy
  - audit and export
          |
Sovereign domain core
  Organization / Tenant / Subject / IdentityAccount
  Resource / Entitlement / Assignment / Session / Policy / Trust
          |
Provider ports + durable operation outbox
          |
  +-------+---------+----------+---------+
  |                 |          |         |
LUXIA_LOCAL       Entra      LDAP/AD   Other adapters
  |                 |          |         |
Local credentials  Cloud      LAN       Cloud or local
```

Core application services may reference provider ports and capability types, but never Microsoft SDKs, Microsoft claim names, Graph resources, or provider-specific IDs. An adapter converts between canonical LUXIA commands/results and its external system. The database remains the source of truth for `Subject`, policy, assignment, and audit state; adapters report projection and synchronization state rather than redefining that truth.

Provider operations that can cross a process or network boundary use a durable operation record/outbox. Canonical state changes and operation creation occur atomically. Adapter execution is idempotent, observable, retryable, and reconciled. A provider failure cannot silently roll back or overwrite the canonical LUXIA identity.

## 4. ProviderAdapter contract

The Phase 6A design should define a versioned contract before moving Entra code. The following TypeScript is illustrative, not an implementation commitment:

```ts
type ProviderCapability =
  | "AUTHENTICATION"
  | "IDENTITY_LIFECYCLE"
  | "GROUP_DISCOVERY"
  | "RESOURCE_DISCOVERY"
  | "ACCESS_PROVISIONING"
  | "INCREMENTAL_SYNC"
  | "OFFLINE_OPERATION";

type ProviderContext = {
  organizationId: string;
  tenantId: string;
  providerConnectionId: string;
  operationId: string;
};

type ExternalIdentityRef = { externalObjectId: string };
type SyncCursor = { value: string; version: number };

interface ProviderAdapter {
  readonly type: ProviderType;
  readonly contractVersion: 1;

  capabilities(): ReadonlySet<ProviderCapability>;
  discoverUsers(ctx: ProviderContext, cursor?: SyncCursor): AsyncIterable<DiscoveredIdentity>;
  getUser(ctx: ProviderContext, ref: ExternalIdentityRef): Promise<ProviderIdentity | null>;
  createIdentity(ctx: ProviderContext, command: CreateIdentityCommand): Promise<ProvisionResult>;
  disableIdentity(ctx: ProviderContext, ref: ExternalIdentityRef): Promise<ProvisionResult>;
  listGroups(ctx: ProviderContext, cursor?: SyncCursor): AsyncIterable<ProviderGroup>;
  listResources(ctx: ProviderContext, cursor?: SyncCursor): AsyncIterable<ProviderResource>;
  grantAccess(ctx: ProviderContext, command: GrantAccessCommand): Promise<ProvisionResult>;
  revokeAccess(ctx: ProviderContext, command: RevokeAccessCommand): Promise<ProvisionResult>;
  sync(ctx: ProviderContext, request: SyncRequest): Promise<SyncResult>;
  healthCheck(ctx: ProviderContext): Promise<ProviderHealth>;
}
```

Authentication is a capability with a narrower optional port rather than a requirement imposed on every adapter:

```ts
interface AuthenticationProvider {
  beginAuthentication(request: BeginAuthentication): Promise<AuthChallenge>;
  completeAuthentication(request: CompleteAuthentication): Promise<VerifiedExternalIdentity>;
  beginLogout?(request: BeginLogout): Promise<UpstreamLogout | null>;
}
```

Contract rules:

- All calls are scoped by organization, tenant, and provider connection.
- `operationId` is the idempotency key for mutations.
- External identifiers are opaque. Only the adapter interprets their syntax or claim mapping.
- Secrets are provided through a secret-resolution port and never returned in adapter results, logs, audit payloads, or core tables as plaintext.
- Adapters declare capabilities; unsupported operations fail explicitly and do not degrade silently.
- Discovery data is untrusted input. It is validated, normalized, bounded, and mapped before it can affect canonical state.
- Sync results carry cursors, observed versions, provenance, and conflict information. A sync does not directly bypass core lifecycle or authorization rules.
- Health distinguishes configuration, credentials, reachability, throttling, and provider degradation without leaking secrets.
- Mutating results distinguish accepted, applied, retryable failure, permanent failure, and conflict.

## 5. `LUXIA_LOCAL` design

`LUXIA_LOCAL` is a native provider adapter implemented against local LUXIA services and storage. It is not a special case that bypasses `IdentityAccount` or tenant isolation.

Each locally authenticatable subject has:

- one canonical `Subject`;
- one `IdentityAccount` attached to a `ProviderConnection` whose type is `LUXIA_LOCAL`;
- zero or more local authenticators attached to that identity account;
- sessions issued by the same session service used for federated identities.

A subject may simultaneously have local and external accounts:

```text
Subject: Alice
  IdentityAccount -> LUXIA_LOCAL
  IdentityAccount -> MICROSOFT_ENTRA
  IdentityAccount -> GOOGLE_WORKSPACE
```

The local provider owns authentication material, not the identity itself. It supports passkeys/WebAuthn and hardware security keys first, local TOTP, smart-card or certificate credentials, and managed-device credentials. Password support, if commercially required, must use memory-hard hashing, breached-password controls, rate limits, secure recovery, and explicit policy; SMS is not a primary MFA factor.

Recovery and privileged enrollment require auditable multi-step controls. Authentication secrets and private keys are encrypted with deployment-local keys, support rotation, and remain exportable only in a deliberately defined secure backup format. Biometric templates are never stored by LUXIA; platform authenticators retain biometric material on the device.

`LUXIA_LOCAL` must function with no Internet or LUXIA Cloud connection. Its health state describes local database, key service, clock, and credential-verification readiness.

## 6. Cloud, Hybrid, and Sovereign deployment models

All editions use the same core modules, schema lineage, authorization semantics, adapter contract, and test suites. Packaging and placement differ.

### LUXIA Cloud

- LUXIA operates the application and PostgreSQL service.
- Cloud adapters connect from the hosted control plane.
- Customer data residency, export, encryption, and deletion controls remain explicit.
- `LUXIA_LOCAL` may still be enabled as a hosted local-identity provider, but this does not make LUXIA Cloud mandatory for other deployment modes.

### LUXIA Hybrid

- The LUXIA control plane coordinates with a customer Edge Node.
- The Edge Node hosts LAN-bound adapters such as LDAP, AD, Samba AD, ERP, or NAS integrations.
- Local authentication and authorization continue within the declared offline envelope.
- Synchronization is signed, replay-resistant, store-and-forward, resumable, and scoped to explicitly shared data.

### LUXIA Sovereign

- The complete control plane, PostgreSQL, local identity provider, policy engine, audit store, secrets/key service, admin UI, and required adapters run under customer control.
- Core IAM operation requires neither Internet access nor a LUXIA Cloud account.
- Updates use signed, verifiable offline packages with rollback protection and an operator-visible compatibility manifest.
- Backup, restore, disaster recovery, high availability, observability, and export are local operational capabilities.

No deployment mode forks domain behavior. Environment-specific composition selects infrastructure implementations and enabled adapters.

## 7. Offline-first behavior

“Connectivity enhances LUXIA. Connectivity must not be a prerequisite for identity.”

When disconnected, the supported local envelope includes:

- local authentication using enrolled local authenticators;
- session issuance, validation, and revocation;
- authorization and policy evaluation against locally committed state;
- subject and local-account lifecycle operations;
- local administration under local privileged controls;
- append-only local audit capture;
- local backup and restore operations.

External-provider operations become explicit pending operations. They are stored durably, shown to administrators, retried with idempotency keys, and reconciled when connectivity returns. LUXIA never reports external access as applied before provider confirmation.

Conflict handling is deterministic:

1. Canonical LUXIA identity, policy, and assignment state wins within the core.
2. Provider projections use monotonic versions/cursors and retain the observed provider version.
3. Destructive or privilege-increasing conflicts do not auto-merge.
4. Privilege grants that cannot be verified fail closed or remain pending.
5. Locally requested revocation takes immediate effect in LUXIA, even if remote revocation is pending.
6. Replayed, duplicate, stale, or out-of-order operations are rejected or made idempotent.

Offline duration limits may be policy-controlled for high-risk sessions or stale external attestations, but local identities and locally evaluable policy must not have an artificial cloud lease.

## 8. Identity and data sovereignty model

- `Subject.id` is the stable canonical identity key. It is generated by LUXIA and is never derived from an email address, Entra object ID, LDAP DN, or other provider key.
- `IdentityAccount` maps one subject to one account at one provider connection. Its `externalObjectId` is an opaque provider projection key.
- Provider removal does not delete the subject, its local assignments, or its audit history. It disables or detaches only the affected projection under retention policy.
- Policy, entitlement, assignment, session, trust, and audit records use LUXIA identifiers and remain usable without a provider.
- Customers can export canonical identity data, mappings, policies, assignments, audit evidence, and documented schema/version metadata. Secret/authenticator export is separately protected and format-controlled.
- Data residency and encryption keys are deployment choices. Sovereign mode supports customer-controlled keys and local-only storage.
- LUXIA Cloud has no mandatory runtime authority over a Sovereign deployment. Licensing or update checks must not disable critical IAM functions when disconnected.
- Cross-boundary synchronization is minimized, purpose-limited, tenant-scoped, encrypted, signed, and auditable.

## 9. Security and threat-model implications

The sovereign direction adds or changes the following threats and controls:

| Threat | Required controls |
| --- | --- |
| Malicious or compromised adapter | Least-privilege adapter credentials, capability allowlists, process/module boundary, validated inputs, tenant scoping, egress controls, signed adapter packages, complete audit trail |
| Provider impersonation or account mis-linking | Issuer/connection binding, exact external-ID matching, proof-of-control, no automatic linking by mutable email alone, administrative approval for ambiguous links |
| Offline replay and message reordering | Signed envelopes, nonce/idempotency key, monotonic sequence/version, bounded clock use, replay ledger, deterministic conflict rules |
| Local credential theft | Hardware-backed passkeys where possible, encrypted credential store, memory-hard password hashing if enabled, rate limiting, lockout protections, secure recovery, key rotation |
| Compromised sovereign host or administrator | Separation of duties, least privilege, tamper-evident audit, optional dual control for sensitive operations, hardened backups, secure boot/HSM integration where available |
| Stale authorization while disconnected | Policy-defined freshness for external assertions, immediate local revocation, fail-closed privileged changes, visible pending/reconciliation state |
| Rollback to vulnerable software or policy | Signed update bundles, version and schema compatibility checks, rollback protection, signed policy history, backup verification |
| Data exfiltration through sync or support | Explicit data-sharing scopes, encryption in transit and at rest, customer-controlled diagnostics, redaction, no secret material in telemetry |
| Split-brain Edge/Cloud administration | Single-writer or version-authority rules per object class, conflict quarantine, no last-write-wins for privileged changes |
| Loss of local keys or database | Tested encrypted backups, offline recovery material, documented key ceremony, restore drills, optional HA |

Existing RLS, tenant-scoped access, fail-closed authorization, session revocation, immutable evidence gates, and migration parity tests remain mandatory. A provider adapter must never receive direct unrestricted database access.

## 10. Required data-model changes

Changes are additive and staged; none are implemented by this ADR.

### Phase 6A minimum

- Extend `ProviderType` with `LUXIA_LOCAL`, `LDAP`, `ACTIVE_DIRECTORY`, and `SAMBA_AD` only after compatibility tests confirm existing enum values and serialized data remain stable.
- Define provider capability and connection-state metadata. Prefer typed columns for security- or query-critical state and versioned JSON only for adapter-owned non-secret configuration.
- Add a secret reference, never plaintext secrets, for provider connection credentials.
- Add durable provider operation/outbox and synchronization checkpoint records with tenant scope, idempotency key, status, attempt count, timestamps, observed version, and sanitized error data.
- Add provider projection/reconciliation status without changing `Subject` ownership.

### `LUXIA_LOCAL` enablement

- Add an `Authenticator`-style model linked to `IdentityAccount`, with credential type, public credential material, encrypted secret reference where applicable, sign counter, status, enrollment and last-used timestamps. Credential-type-specific secrets must not be stored in generic provider metadata.
- Add recovery and credential-enrollment challenge records with short lifetimes and single-use semantics.
- Add identity/account lifecycle status fields if the existing models cannot distinguish active, suspended, disabled, and pending states without consulting a provider.

### Later policy, trust, and ledger phases

- Introduce versioned `Policy` and evaluation artifacts without replacing `Entitlement` or `Assignment`.
- Introduce explicit trust relationships/attestations with issuer, subject, scope, validity, provenance, and revocation state.
- Introduce append-only, hash-linked or equivalently tamper-evident audit/ledger records and synchronization envelopes.

Existing primary keys and foreign keys are preserved. `providerConnectionId` remains optional for provider-independent `Resource`; provider-specific resource IDs remain on the provider-facing portion of the model.

## 11. Backward compatibility

- Do not rewrite or reinterpret existing `Subject.id`, `IdentityAccount.externalObjectId`, provider connections, assignments, sessions, or migration bridges.
- Existing `MICROSOFT_ENTRA`, AWS, Google Workspace, GitHub, and `CUSTOM` enum values retain their meaning.
- The current Entra login, callback, logout, Graph provisioning, and synchronization behavior remains covered while it is moved behind an adapter.
- Introduce adapter routing behind compatibility facades first; route callers to the facade before relocating concrete Entra logic.
- Keep legacy `User`, `azureId`, RBAC tables, bridge, and dual-write paths until a separately approved retirement gate proves no production dependency remains.
- Database migrations must be forward-compatible and additive before any destructive cleanup. Every migration has backup, restore, and rollback evidence.
- Existing sessions continue to resolve by `identityAccountId`; adapter extraction must not invalidate them.
- API behavior changes require versioning or compatibility translation. Provider operation status may be added without falsely converting asynchronous provider completion into synchronous success.
- `CUSTOM` remains supported. Dedicated LDAP/AD/Samba types are added for clear capabilities and security policy, not by reclassifying existing records automatically.

## 12. Incremental migration strategy

1. **Freeze the boundary and evidence baseline.** Preserve the validated Phase 5F SHA, tests, staging provenance, and native authorization behavior.
2. **Specify Phase 6A contracts.** Define provider-neutral domain DTOs, capabilities, error taxonomy, idempotency, secret access, registry/composition, and contract tests. No provider behavior changes in this step.
3. **Wrap Entra without changing behavior.** Place current OIDC and Graph operations behind an `MicrosoftEntraAdapter`; keep compatibility facades and run old/new paths in parity where feasible.
4. **Remove provider selection from core flows.** Authentication orchestration and lifecycle services resolve adapters by `ProviderConnection`; routes and UI stop importing Microsoft modules.
5. **Make lifecycle canonical-first.** Create/update the `Subject` and account state transactionally, enqueue projection commands, expose pending/failed state, and reconcile provider results.
6. **Introduce `LUXIA_LOCAL`.** Add local account and authenticator schema, local authentication, recovery, and lifecycle under the same ports and session model.
7. **Add LDAP/AD/Samba adapters and Edge execution.** Validate disconnected operation, credential isolation, and store-and-forward behavior.
8. **Add remaining cloud adapters.** Google, AWS, GitHub, and custom API adapters conform to the same contract and evidence suite.
9. **Retire legacy coupling.** Stop dual writes only after production evidence proves native data completeness, then remove direct Graph route usage and eventually legacy `azureId`/RBAC structures through separately gated migrations.

Each step has a rollback boundary. No step combines schema destruction, behavior cutover, and provider rollout in one release.

## 13. Test strategy

Evidence remains stronger than opinion. A phase is not complete because an interface exists; it is complete only when its required evidence passes.

- **Contract tests:** one reusable suite for every adapter covering capabilities, scope isolation, pagination/cursors, normalization, idempotency, retry classification, conflicts, disablement, grants/revocations, health, and redaction.
- **Core isolation tests:** prove authorization, policy evaluation, subject lifecycle, local audit, and exports do not import provider SDKs or require provider credentials/network access.
- **Architecture tests:** enforce dependency direction and fail CI if core/application modules import Entra, Graph, Google, AWS, LDAP, or adapter implementation packages.
- **`LUXIA_LOCAL` security tests:** WebAuthn challenge binding, origin/RP validation, counters, TOTP replay windows, rate limits, recovery, credential revocation, key rotation, and session invalidation.
- **Offline tests:** remove Internet/DNS/provider reachability and prove critical local functions continue; verify queued operations, restart durability, resumption, duplicate delivery, stale messages, and deterministic conflicts.
- **Parity tests:** preserve current Entra behavior while wrapping it; compare identity mapping, login, logout, lifecycle, synchronization, and error results before cutover.
- **Tenant-boundary tests:** extend RLS and cross-tenant tests to every new table, adapter command, export, and sync envelope.
- **Threat-driven tests:** malicious adapter payloads, issuer confusion, account-linking attacks, replay, privilege escalation, split brain, tampered update packages, compromised backups, and secret leakage.
- **Migration tests:** production-shaped fixtures, enum/schema upgrades, idempotent backfill, existing session continuity, rollback/restore, and data checksum reconciliation.
- **Deployment matrix:** run the same core conformance suite in Cloud, Hybrid, and fully disconnected Sovereign compositions.
- **Soak and gates:** retain Gate0, extended soak, reconciliation, ghost-grant detection, immutable provenance, and rollback drills. Add provider-operation and offline recovery SLOs before each relevant cutover.

## 14. Phase 6A–12 roadmap

| Phase | Outcome | Exit evidence |
| --- | --- | --- |
| 6A — Provider Adapter Framework | Versioned ports, capabilities, registry, operation/error semantics, secret boundary, and contract-test kit | Architecture dependency checks and fake-adapter contract suite pass; no production behavior change |
| 6B — Microsoft Entra production connector | Existing OIDC and Graph behavior behind `MicrosoftEntraAdapter` | Entra parity, security, migration, Gate0, soak, and rollback evidence pass |
| 6C — LUXIA Local Identity Provider | Local identities and strong local authenticators using canonical subjects and sessions | Disconnected authentication/lifecycle, recovery, credential, and tenant-isolation suites pass |
| 6D — LDAP / AD / Samba connectors | LAN directory discovery, mapping, lifecycle, and reconciliation through Edge | Directory contract suites, lab interoperability, outage/replay, and conflict tests pass |
| 6E — Google / AWS / GitHub connectors | Remaining priority cloud projections | Per-adapter contract, least-privilege, parity, throttling, and reconciliation tests pass |
| 7 — Authorization + Trust Graph | Provider-independent relationship and trust evaluation | Deterministic graph decisions, isolation, scale, and revocation evidence pass |
| 8 — Policy Engine | Versioned local policy evaluation and explanation | Offline determinism, policy simulation, safe rollout, rollback, and decision-trace tests pass |
| 9 — Sovereign Edge Runtime | Self-hosting, offline runtime, local secrets, signed updates, audit, backup/restore, and HA options | Air-gapped installation, upgrade/rollback, restore, failure, and HA drills pass |
| 10 — Trust Ledger + synchronization | Tamper-evident evidence and deterministic multi-node synchronization | Integrity, replay, partition, merge/conflict, recovery, and export verification pass |
| 11 — AI Security + AI-agent identities | Governed `AI_AGENT` lifecycle, tools, delegation, and audit | Agent-boundary, least-privilege, prompt/tool abuse, delegation expiry, and traceability tests pass |
| 12 — Commercial editions | Cloud, Hybrid, and Sovereign packaging from one core | Cross-edition compatibility, portability/export, licensing-offline safety, operations, and upgrade matrix pass |

## 15. Non-goals

- Implementing Phase 6A or any adapter in this ADR.
- Modifying the validated Phase 5F deployment, production, authorization semantics, or database.
- Creating a second Sovereign or Edge codebase.
- Replacing `Subject` with a Microsoft, LDAP, email, username, device, or provider identifier.
- Making LUXIA Cloud, Internet access, telemetry, licensing checks, or a third-party identity provider mandatory for critical IAM operation.
- Removing Entra support; Entra remains a first-class adapter, not the core identity owner.
- Reusing `CUSTOM` to avoid explicit security and capability semantics for `LUXIA_LOCAL`, LDAP, AD, or Samba AD.
- Implementing all adapters simultaneously or performing a big-bang migration.
- Deleting legacy tables, bridges, modes, or compatibility paths before evidence-backed retirement gates.
- Treating SMS as the primary MFA mechanism.
- Claiming full air-gap, high-availability, tamper-evident ledger, or compliance certification before those capabilities and their operational evidence exist.

## Consequences

This decision preserves the strongest part of the current design—the canonical subject, tenant-scoped native authorization, provider-account mapping, and controlled migration bridge—while forcing provider logic to the edge. It adds adapter lifecycle, offline synchronization, local credential, key-management, operational, and conflict-resolution complexity. That complexity is accepted because it is necessary for genuine identity sovereignty and will be introduced incrementally behind evidence gates.
