# ADR: Post-6C Identity Realignment

- Status: Accepted architecture gate; implementation not started
- Date: 2026-09-23
- Baseline: `7eb98f9e974d5ee418177896b730ea1883c341eb`
- Scope: LUXIA product boundaries and roadmap after Phase 6C
- Decision owner: LUXIA Identity
- Supersedes: the ownership and Phase 6D-12 ordering in `ADR-SOVEREIGN-IDENTITY-CONTROL-PLANE.md`; its sovereign-core, adapter, deployment, and offline invariants remain valid

## 1. Context

Phases 6A, 6B, and 6C are evidence-backed foundations:

- 6A established provider-neutral contracts, capabilities, error semantics, secret resolution, registry boundaries, idempotency semantics, and reusable contract tests.
- 6B placed current Microsoft Entra OIDC and Graph behavior behind an adapter without changing its observable behavior.
- 6C added `LUXIA_LOCAL`, tenant-scoped local identity/authenticator records, WebAuthn/passkey verification, TOTP fallback, recovery primitives, local lifecycle operations, RLS, and offline authentication evidence.
- The canonical `Subject`, provider projection through `IdentityAccount`, shared `Session`, and one-codebase Cloud/Hybrid/Sovereign direction remain correct.

The previous roadmap moved next to LDAP/AD/Samba. That ordering would multiply integrations before the identity foundation defines universal subject semantics, assurance evidence, crypto-agility, portability, partition behavior, and sovereign recovery. Phase 6D connectors are therefore postponed. No validated 6A-6C behavior is discarded.

LUXIA is not designed as another directory front end. External identity products establish minimum interoperability expectations; they do not define LUXIA's architecture or roadmap.

## 2. Decision

LUXIA Identity is the canonical identity foundation for any actor that can authenticate, possess credentials, maintain lifecycle state, or be represented in verifiable identity evidence:

- `HUMAN`
- `DEVICE`
- `WORKLOAD`
- `SERVICE`
- `AI_AGENT`
- an external organization or trusted entity when it acts as an identity principal

`Subject` remains the universal canonical abstraction. A provider account, directory object, username, email address, certificate subject, workload service account, device identifier, agent identifier, or organization registration number is never the canonical identity key.

The following invariants apply:

1. A subject exists independently of every provider projection.
2. Credentials authenticate a subject through an identity account or native binding; they do not own the subject.
3. Provider replacement preserves the subject identifier, lifecycle history, assignments, assurance history, and evidence references.
4. Critical local authentication and identity lifecycle remain operable inside a declared offline envelope.
5. Authentication produces typed, attributable evidence. It does not make the authorization decision.
6. Assurance is a versioned confidence statement supported by evidence, not an untyped provider claim or permanent scalar attached to a person.
7. Relationship trust, contextual authorization policy, tamper-evident history, and AI tool governance remain separate LUXIA product responsibilities.
8. Cryptographic algorithms, credential formats, keys, trust anchors, and verification policies are versioned and replaceable.
9. Cloud, Hybrid, and Sovereign deployments use the same identity core and conformance suite.

## 3. Universal identity model

### 3.1 Canonical subject

`Subject.id` is stable, opaque, LUXIA-generated, tenant-scoped, and provider-independent. All subject kinds share these minimum semantics:

- subject kind and schema version;
- lifecycle state and lifecycle version;
- creation, suspension, disablement, recovery, and retirement state transitions;
- canonical aliases and provider projections without treating mutable aliases as identity keys;
- credentials or proof mechanisms appropriate to the subject kind;
- assurance observations and evidence references;
- export/import identity continuity identifiers;
- tenant isolation and provenance.

Kind-specific behavior is expressed through typed profiles and credential policies, not parallel identity systems:

| Subject kind | Typical proof | Identity-specific requirements |
| --- | --- | --- |
| Human | Passkey, security key, smart card, TOTP fallback, approved recovery | User verification, anti-phishing preference, protected enrollment/recovery, privacy controls |
| Device | Hardware-backed device key, certificate, attestation | Ownership/custody lifecycle, key rotation, compromise and decommission state |
| Workload | Short-lived workload identity, key or certificate proof, platform attestation | Non-human ownership, rotation without interactive recovery, environment and deployment provenance |
| Service | Service key/certificate and controlled operator recovery | Explicit accountable owner, purpose, rotation, suspension, and non-interactive authentication |
| AI agent | Agent instance key/workload proof | Identity lifecycle only; tool authority, delegation, behavioral policy, and prompt/tool governance belong to LUXIA AI Security |
| External trusted entity | Organizational or federation key, signed registration evidence | Used only when the entity acts as a principal; relationships and delegation edges belong to Trust Graph |

The existing `Organization` model remains the customer/administrative tenancy boundary. It must not be overloaded as an authenticating subject. If an external legal organization must sign, authenticate, or receive evidence, it is represented by a separate canonical subject kind such as `EXTERNAL_ENTITY` after an additive data-model gate. The relationship between that subject and legal/customer organizations belongs to Trust Graph.

### 3.2 Identity account and provider projection

`IdentityAccount` remains the mapping between a canonical subject and a provider connection. Provider identifiers stay opaque and adapter-owned. Multiple provider accounts may project one subject, but linking requires strong proof or reviewed administration; mutable email matching is never sufficient.

Removing or replacing a provider changes only its projection. It must not delete or re-key the canonical subject, locally committed assignments, assurance evidence, sessions governed by explicit continuity rules, or identity history.

### 3.3 Credentials

A credential is a versioned verifier binding, not a provider metadata blob. Its common security envelope must be able to state:

- credential identifier, type, format version, status, subject/account binding, and tenant scope;
- public verification material or opaque secret reference, never a plaintext secret;
- algorithm suite and parameters selected from an allowlisted registry;
- key identifier/version, trust-anchor version, issuance/enrollment provenance, and verification policy version;
- validity, rotation, revocation, compromise, last-use, counter/replay state, and recovery eligibility;
- authenticator properties where applicable, such as hardware binding, user verification, attestation evidence reference, and transport;
- privacy classification and exportability.

Private passkey keys and biometric templates remain on the authenticator. LUXIA stores public verification material and evidence needed to validate the ceremony; it never stores a biometric template.

## 4. Identity continuity and provider independence

Identity continuity means that provider failure, Internet loss, a network partition, or a planned provider replacement does not erase the canonical identity or prevent all critical local verification.

Provider independence means that all provider-originated identities, claims, groups, and lifecycle observations enter through adapter contracts as attributed evidence or projections. The provider may authenticate or administer its own account, but it never assigns the canonical subject identifier, becomes the only holder of required identity state, or injects provider-specific logic into Identity, Trust Graph, or Policy. Every critical provider integration has an explicit unavailable/stale state and a documented replacement path.

Continuity is defined by an explicit operating envelope:

- locally committed subjects, lifecycle state, credential verifiers, revocations, and trust anchors are available;
- local authentication challenges, signature verification, session issuance/revocation, and identity administration continue according to local policy;
- external projections clearly become stale or pending rather than being reported as current;
- locally recorded disablement and revocation take effect immediately;
- privilege-increasing remote changes are never inferred during a partition;
- stale external assertions have typed freshness and safe-degradation limits;
- restart durability, clock rollback detection, replay state, and monotonic epochs are part of the envelope;
- no license server, LUXIA Cloud endpoint, or external IdP lease can disable critical sovereign identity functions.

Continuity does not mean unlimited trust during a partition. High-risk operations may require a fresh local factor, device-bound proof, dual control, or refusal when required evidence is unavailable.

## 5. Human authentication and offline human proof

### 5.1 Strategic authentication order

Human authentication prioritizes:

1. WebAuthn/passkeys with user verification and hardware protection where available;
2. device-bound cryptographic keys and security keys;
3. local biometric unlock only through platform authenticators, with biometric material retained on-device;
4. smart-card/certificate methods where operationally appropriate;
5. local TOTP as a compatibility/recovery fallback, not the strategic end state.

SMS is not a primary assurance factor. Passwords are not introduced by default; any future password capability requires a separate security decision and evidence gate.

### 5.2 Offline challenge/signature flow

The offline verifier issues a fresh, high-entropy challenge bound to tenant, subject/account, authenticator, relying party, audience, operation purpose, transaction, expiry, and verification-policy version. The authenticator signs the challenge with its device-held private key. The local verifier validates origin/relying-party binding, user-presence/user-verification requirements, signature, credential status, counter/replay state, trust-anchor version, and local revocation state before issuing a session or evidence result.

An offline proof is never a reusable bearer secret. Challenges are short-lived and single-use. Responses are audience- and purpose-bound. A captured assertion cannot be replayed for another tenant, verifier, operation, or later partition.

### 5.3 Signed assurance snapshots

A signed assurance snapshot may carry bounded evidence between authorized LUXIA components during a partition. It is not an access token and never directly grants an entitlement. It contains at minimum:

- issuer/verifier identity and key version;
- tenant, canonical subject, identity account, and credential references;
- authentication method, assurance profile/version, and verified properties;
- evidence digests, issuance time, expiry, audience, purpose, nonce, partition epoch, and sequence;
- revocation/checkpoint age and explicit freshness classification;
- algorithm suite and signature.

Policy consumes the snapshot as one decision input. It may reduce its weight as evidence ages. Privileged operations fail closed when their required freshness, local revocation checkpoint, or assurance profile is unavailable. Long partitions cannot silently extend the snapshot or convert it into a perpetual session.

## 6. Continuous identity assurance

Identity maintains typed assurance observations about authentication and identity proofing. Assurance may increase, decrease, expire, or be revoked as credentials, devices, context, and evidence change.

Identity owns:

- authentication-method and credential properties;
- proofing/enrollment provenance;
- verifier result and reason codes;
- evidence freshness, confidence, validity, and revocation state;
- a versioned assurance profile and bounded subject/authentication assurance snapshot.

Identity does not own the access decision. LUXIA Policy combines current assurance with resource sensitivity, requested action, environmental context, and Trust Graph relationships. Provider-native assurance labels are normalized as evidence; they never become provider-dependent authorization logic.

Assurance changes are monotonic events, not destructive overwrites. A current projection may be materialized for fast use, but its supporting evidence and version remain referenceable.

## 7. Identity portability

Portability must support both planned provider replacement and sovereign exit from LUXIA-operated infrastructure.

A versioned identity portability package contains:

- canonical subjects, kinds, lifecycle states, stable continuity IDs, and schema versions;
- aliases and provider mappings clearly marked as projections;
- credential public material, status, algorithms, trust-anchor references, and exportability metadata;
- assurance observations/snapshots and evidence references;
- session continuity metadata only where safely transferable;
- assignment references without redefining Policy ownership;
- checksums, manifest, ordering, provenance, and compatibility requirements.

Secret or private credential material is excluded by default. Exportable recovery/key material uses a separate encrypted package, explicit ceremony, dual control where appropriate, and customer-held keys. Non-exportable passkeys are re-enrolled after continuity proof; they are never weakened to make migration convenient.

Import is staged, validated, tenant-scoped, idempotent, and produces a reconciliation report. It never silently merges subjects by email or overwrites a higher-confidence identity.

## 8. Sovereign recovery and reconstitution

Sovereign recovery covers loss of a provider, cloud account, control-plane site, database, or local key service. It is distinct from ordinary end-user account recovery.

The recovery design requires:

- encrypted, versioned, integrity-protected backups of canonical identity state, verifier material, mappings, assurance state, evidence references, and configuration;
- customer-controlled recovery authorities and documented key ceremonies;
- split knowledge/dual control for root recovery where risk warrants it;
- offline copies of required schema, verifier, algorithm, trust-anchor, and update manifests;
- restore into an isolated environment before activation;
- verification of tenant boundaries, key/trust-anchor continuity, revocations, counters, evidence chain references, and subject counts;
- explicit reconstitution of non-exportable credentials through verified re-enrollment;
- recovery epoch advancement so pre-recovery challenges, sessions, snapshots, and synchronization messages cannot replay;
- signed recovery evidence emitted for anchoring by Trust Ledger;
- tested recovery time, recovery point, and maximum disconnected-operation objectives.

Recovery material is not a universal bypass credential. It is scoped, threshold-controlled, audited, expiring or rotated where possible, and incapable of silently granting application access.

## 9. Crypto-agility

No long-lived record or protocol assumes one permanent algorithm. Identity uses versioned registries for algorithm suites, credential formats, signature/encryption parameters, key purposes, trust anchors, verifier policy, and deprecation state.

Required properties:

- allowlist by purpose and deployment policy; never trust an algorithm identifier supplied by an untrusted assertion without policy validation;
- algorithm/key version recorded in every credential, signed snapshot, backup, sync envelope, and evidence event;
- overlapping old/new verification during controlled rotation;
- separate key purposes for signing, encryption, recovery, synchronization, and update verification;
- trust-anchor rotation with activation, retirement, compromise, and rollback-protection semantics;
- cryptographic inventory and impact reporting;
- test vectors, negative vectors, migration fixtures, and restore drills for every supported suite;
- room for post-quantum or hybrid suites without changing canonical subject identifiers or product contracts.

Crypto-agility does not mean exposing arbitrary algorithms to adapters. Adapters map provider capabilities into approved LUXIA suites and evidence.

## 10. Evidence by design

Every security-relevant identity operation produces a provider-neutral evidence event for higher LUXIA layers. Identity is responsible for producing and validating the event; Trust Ledger is responsible for tamper-evident retention and anchoring.

The minimum evidence envelope includes:

- event ID, event type, schema version, organization, tenant, and canonical subject;
- optional identity-account, credential, device, workload, agent, authenticator, and provider-connection references;
- actor/verifier/issuer, operation ID, correlation ID, causation ID, and request purpose;
- occurred-at and recorded-at times, sequence/epoch, source class, and offline/partition state;
- outcome and stable reason codes;
- assurance profile/version and before/after assurance references where applicable;
- evidence payload digest and references rather than unrestricted sensitive payloads;
- algorithm, signing key, and trust-anchor versions;
- privacy/retention classification and redaction policy;
- signature or MAC where crossing a trust boundary.

Events include subject lifecycle changes, account linking/unlinking, credential enrollment/use/revocation, authentication success/failure, recovery, key rotation, portability export/import, provider projection/reconciliation, and partition-state transitions.

Logs are not evidence merely because they exist. Completion evidence must be machine-verifiable, scoped, reason-coded, redacted, and reproducible from documented inputs.

## 11. Product capability ownership matrix

| Capability | Identity | Trust Graph | Policy | Trust Ledger | AI Security |
| --- | --- | --- | --- | --- | --- |
| Canonical subject, kind, lifecycle | **Owner** | References subject | Reads state | Records events | Uses agent subject |
| Credentials, authenticators, authentication | **Owner** | No | Reads assurance | Records evidence | May require agent/workload proof |
| Provider accounts and identity projection | **Owner** | May reference external entity | No provider-specific decision logic | Records reconciliation evidence | No |
| Identity continuity and provider replacement | **Owner** | Preserves relationship references | Preserves policy references | Preserves evidence history | Preserves agent identity reference |
| Assurance observations and bounded snapshots | **Owner** | Supplies relationship evidence | **Consumes for decisions** | Anchors/history | Supplies agent/tool evidence |
| Subject-to-subject relationships | References only | **Owner** | Consumes | Records changes | Consumes delegation edges |
| Trust, delegation, federation graph | No | **Owner** | Consumes | Anchors/history | Constrains agent delegation |
| Entitlement/contextual access decision | Supplies identity/assurance | Supplies graph facts | **Owner** | Records decision evidence | Requests/obeys decisions |
| Policy authoring, simulation, rollout | No | No | **Owner** | Records versions | Adds AI-specific policy inputs |
| Tamper-evident event retention/anchoring | Emits identity evidence | Emits graph evidence | Emits decision evidence | **Owner** | Emits agent evidence |
| Synchronization evidence/history | Emits identity/projection events | Emits graph events | Emits policy events | **Owner of ledger integrity** | Emits AI events |
| Agent identity and credentials | **Owner of subject/authentication** | Owns delegation relationships | Owns decisions | Records evidence | **Owner of agent/tool governance** |
| Tool permissions, prompt/tool abuse controls | Identifies actor | Supplies delegation path | Decides policy | Records evidence | **Owner** |
| Customer tenancy boundary | **Uses shared platform boundary** | Uses | Uses | Uses | Uses |

Shared platform infrastructure may host these products in one deployment, but shared deployment does not collapse ownership or dependency direction.

## 12. Revised roadmap and evidence gates

### 6D — Universal Identity Semantics and Evidence Foundation

Outcome: formalize lifecycle, credential, assurance, evidence, crypto-version, and subject-kind contracts across humans and non-humans without changing current authentication behavior.

Exit gate:

- compatibility ADR and additive migration plan approved;
- typed lifecycle/credential/assurance/evidence contracts cover every existing `SubjectType` plus the external-entity decision;
- session and authentication assurance semantics are no longer untyped strings at the architecture boundary;
- architecture tests prove no provider SDK or Policy/Graph/Ledger implementation enters Identity core;
- migration rehearsal preserves every existing subject, account, local credential, session, assignment, and Entra behavior;
- evidence schemas have golden fixtures, redaction tests, version-compatibility tests, and stable reason codes;
- no production behavior change and full 6A-6C suites remain green.

### 6E — Credential Security and Crypto-Agility

Outcome: harden credential ceremony and make algorithms, keys, trust anchors, verifier policies, and rotation explicit and versioned.

Exit gate:

- standards-conformant WebAuthn registration/assertion vectors and negative vectors pass;
- attestation/user-verification policy and biometric non-storage are proven;
- credential/key/trust-anchor rotation and compromise drills pass with old/new overlap and rollback protection;
- local secret resolver has an offline deployment implementation and zero plaintext leakage evidence;
- TOTP is explicitly classified and tested as fallback;
- cryptographic inventory/export and deprecation tests pass.

### 6F — Identity Continuity, Offline Proof, and Partition Safety

Outcome: restart-durable local proof, bounded assurance snapshots, revocation/freshness behavior, and safe partition degradation.

Exit gate:

- Internet/provider/DNS removal tests prove local authentication, lifecycle, revocation, and session operations inside the declared envelope;
- challenge/assertion replay, audience confusion, purpose confusion, clock rollback, stale snapshot, and partition-epoch tests fail closed;
- no reusable offline bearer token exists;
- restart durability, local revocation latency, maximum snapshot age, and high-risk-operation degradation SLOs pass;
- reconnect/reconciliation is deterministic and produces evidence without privilege-increasing auto-merge.

### 6G — Identity Portability and Sovereign Recovery

Outcome: versioned export/import, provider replacement, encrypted backup, isolated restore, recovery ceremony, and site reconstitution.

Exit gate:

- Entra-to-local and local-to-replacement-provider rehearsals preserve canonical IDs, assignments, history references, and assurance state;
- export/import round trips are checksummed, idempotent, tenant-isolated, and schema-version compatible;
- non-exportable credentials follow verified re-enrollment rather than downgrade;
- provider-loss, cloud-loss, database-loss, and key-service-loss drills meet declared RPO/RTO;
- recovery epoch invalidates pre-recovery replay material;
- dual-control/root-recovery, backup tamper, wrong-tenant restore, and compromised-key scenarios pass.

### 6H — Enterprise Directory Adapters

Outcome: LDAP, Active Directory, and Samba AD adapters after the identity invariants are stable. This is the valid content of old 6D, reordered and split into discovery/linking first, lifecycle projection second, and Edge execution only after each boundary passes.

Exit gate:

- dedicated provider types and capability profiles are additive and backward compatible;
- lab matrices cover supported LDAP/AD/Samba versions, paging, rename, disablement, deletion, nested groups, schema variance, throttling, and outages;
- ambiguous linking is quarantined; mutable attributes cannot silently merge subjects;
- least-privilege credentials, secret redaction, idempotency, replay, and reconciliation pass;
- provider replacement preserves canonical identity and evidence;
- no directory is required for local critical authentication.

### 6I — Cloud Provider Expansion

Outcome: Google Workspace, AWS, GitHub, and prioritized custom adapters. This preserves old 6E but moves it behind continuity, portability, and evidence gates.

Exit gate:

- each adapter passes the shared contract, least-privilege, rate-limit, outage, reconciliation, portability, and evidence suites;
- provider-specific attributes remain outside core decision logic;
- disabling/removing any adapter leaves canonical identity usable;
- no new global provider configuration or direct SDK import enters core/application domain.

### 6J — Identity Completion and Operational Certification

Outcome: close legacy identity coupling and certify the Identity product boundary across Cloud, Hybrid, and Sovereign compositions.

Exit gate:

- legacy write/read dependency inventory is zero before separately approved removal;
- Cloud/Hybrid/Sovereign conformance, upgrade, rollback, backup/restore, and observability matrices pass;
- universal subject-kind lifecycle and authentication tests pass at scale;
- data portability, crypto rotation, recovery, and partition drills pass together;
- published support envelope, threat model, evidence catalog, and operational runbooks are complete.

### 7 — LUXIA Trust Graph

Outcome: relationship, federation, ownership, and delegation graph referencing canonical subjects. Old Phase 7 is retained but renamed to remove authorization ownership from Trust Graph.

Exit gate: graph isolation, temporal edges, delegation expiry/revocation, cycle/ambiguity handling, deterministic queries, and evidence emission pass. It must not issue credentials or make the final policy decision.

### 8 — LUXIA Policy

Outcome: contextual, explainable, versioned authorization decisions consuming Identity assurance and Trust Graph facts. Old Phase 8 remains valid with a stricter ownership boundary.

Exit gate: offline determinism, simulation, explanation, safe rollout/rollback, stale-evidence handling, fail-closed privileged decisions, and decision-evidence tests pass.

### 9 — Sovereign Runtime and Edge Operations

Outcome: one-codebase self-hosting, signed updates, local key-service composition, Edge execution, backup/restore, HA, and air-gap operations. Old Phase 9 remains valid, but identity semantics and recovery are no longer deferred to it.

Exit gate: air-gapped install/update/rollback, signed package verification, HA/failure drills, Edge isolation, operational recovery, and cross-product conformance pass.

### 10 — LUXIA Trust Ledger and Deterministic Synchronization

Outcome: tamper-evident anchoring/history for evidence emitted by every product plus safe multi-node synchronization. Old Phase 10 remains valid but does not own identity meaning or policy decisions.

Exit gate: integrity, omission detection, replay, ordering, partition, conflict quarantine, recovery, selective disclosure, retention, export verification, and key-rotation tests pass.

### 11 — LUXIA AI Security

Outcome: agent/tool/delegation governance using `AI_AGENT` identities from Identity, delegation from Trust Graph, decisions from Policy, and evidence in Ledger. Old Phase 11 is split: agent identity remains in Identity; AI governance remains here.

Exit gate: agent/workload binding, tool least privilege, delegation expiry, human accountability, prompt/tool abuse boundaries, kill/revocation propagation, and end-to-end traceability pass.

### 12 — Commercial Editions and Market Readiness

Outcome: Cloud, Hybrid, and Sovereign editions composed from the same products and core contracts. Old Phase 12 remains valid.

Exit gate: cross-edition compatibility, export/exit, licensing-offline safety, upgrade/support matrix, operations, privacy, and recovery commitments pass without changing security semantics by edition.

## 13. Old-roadmap disposition

| Old phase | Disposition |
| --- | --- |
| 6A Provider Adapter Framework | Validated and preserved |
| 6B Microsoft Entra connector | Validated and preserved; compatibility facade remains until later retirement gate |
| 6C LUXIA Local | Validated foundation; requires later ceremony, evidence, crypto, durability, and recovery hardening |
| 6D LDAP/AD/Samba | Valid content, postponed and renamed 6H; split into discovery/linking, lifecycle projection, then Edge execution |
| 6E Google/AWS/GitHub | Valid content, postponed and renamed 6I |
| 7 Authorization + Trust Graph | Split: Trust Graph becomes Phase 7; authorization decision ownership moves solely to Policy |
| 8 Policy Engine | Retained as LUXIA Policy with explicit inputs/outputs |
| 9 Sovereign Edge Runtime | Retained; no longer carries deferred identity semantics or recovery design |
| 10 Trust Ledger + synchronization | Retained with evidence-retention ownership, not identity ownership |
| 11 AI Security + AI-agent identities | Split: agent identity/lifecycle is Identity; agent/tool/delegation governance is AI Security |
| 12 Commercial editions | Retained after cross-product conformance |

## 14. Technical consequences and debt inventory

The realignment accepts more explicit contracts and evidence in exchange for provider independence and long-term continuity. The following debt must be addressed through future approved phases, not in this ADR:

### Universal identity and assurance debt

- `Subject` has a kind and name but lacks explicit lifecycle version/state semantics shared by human and non-human identities.
- `CreateIdentityCommand` assumes `displayName`/`principalName`, which is human/directory-centric for devices, workloads, services, and agents.
- `AuthenticationProvider` returns `assuranceLevel` as a free-form string and generic attributes; assurance profile, method properties, verifier policy, evidence, freshness, and crypto versions are not typed.
- `Session` does not persist a typed authentication/assurance/evidence reference or partition/recovery epoch.
- No external-entity subject kind or explicit decision exists; the customer `Organization` model must not be overloaded.
- No canonical evidence event envelope, stable reason-code catalog, or assurance history/projection exists.

### Credential and recovery debt

- `LocalAuthenticator` lacks explicit credential-format, algorithm-suite, key-version, trust-anchor-version, attestation, user-verification, hardware-binding, compromise, and rotation fields.
- Current local passkey code is a narrow assertion verifier; enrollment accepts public key material after a local challenge but does not yet implement a complete standards-conformant registration/attestation policy.
- `TOTP`, `SECURITY_KEY`, `SMART_CARD`, `MANAGED_DEVICE`, and `CUSTOM` schema values do not all represent completed implementations.
- Offline secret-reference resolution, key custody, rotation, and encrypted recovery packaging are not yet defined end to end.
- Recovery codes are account recovery primitives, not sovereign site/provider reconstitution.
- Current time/replay handling lacks an explicit trusted-clock/clock-rollback and recovery-epoch model.

### Durability and portability debt

- Entra and local adapter idempotency caches are process memory despite the durable operation-journal port; restart-safe provider operation/outbox persistence is absent.
- No versioned identity export/import, provider-replacement workflow, recovery manifest, or deterministic reconstitution report exists.
- No bounded signed assurance snapshot or partition checkpoint format exists.
- Provider synchronization evidence, monotonic object versions, and privileged conflict quarantine are incomplete.

### Data-model and repository debt

- The generated Prisma schema at this baseline contains extra direct single-column `IdentityAccount` relation fields for `LocalAuthenticator`, `LocalAuthChallenge`, and `LocalRecoveryCode`, while the Phase 6C SQL migration enforces their tenant-scoped link through `LocalIdentity`. This schema/migration drift is not exercised by current paths and must be reconciled additively before those relation fields are used.
- `ProviderType` still lacks dedicated LDAP, Active Directory, and Samba AD values; adding them belongs to 6H, not this gate.
- Legacy `User.azureId`, compatibility facades, direct legacy tables, and migration bridges remain intentionally present.
- Architecture tests protect SDK boundaries but do not yet enforce all product ownership boundaries defined here.

## 15. Next implementation phase only

The next implementation phase is **6D — Universal Identity Semantics and Evidence Foundation**.

Its first slice is contract-first and non-cutover:

1. define versioned provider-neutral types for subject lifecycle, credential descriptors, authentication method properties, assurance observations/snapshots, crypto identifiers, and identity evidence envelopes;
2. define the external-entity subject-kind decision and migration compatibility rules;
3. add architecture tests enforcing Identity/Trust Graph/Policy/Ledger/AI Security ownership boundaries;
4. reconcile the Phase 6C Prisma relation drift through an additive, data-preserving migration/schema correction;
5. create golden compatibility fixtures from existing Entra and LUXIA_LOCAL results;
6. prove no production behavior change and keep every 6A-6C, security, build, migration, and cutover-readiness test green.

Phase 6D must not implement LDAP/AD/Samba, Trust Graph, Policy, Ledger, AI governance, production cutover, or destructive cleanup.

## 16. Non-goals

- Implementing any product code in this architecture gate.
- Starting LDAP, Active Directory, Samba AD, Trust Graph, Policy, Trust Ledger, or AI Security.
- Changing Entra or LUXIA_LOCAL observable behavior.
- Deploying or modifying production.
- Replacing validated 6A-6C foundations.
- Treating an assurance snapshot as an authorization decision or bearer token.
- Storing biometric templates or private passkey keys.
- Combining the customer tenancy `Organization` with an authenticating external-entity subject.
- Promising unlimited offline trust, automatic privileged conflict merging, or recovery without evidence.
- Performing destructive schema or legacy cleanup.

## 17. Consequences

Connector expansion moves later, but every later adapter lands on stable universal identity, assurance, evidence, portability, and recovery semantics. This reduces the risk that provider-specific assumptions become permanent core design. It also makes product ownership explicit: Identity proves who or what an actor is and preserves that identity; Trust Graph describes relationships; Policy decides; Trust Ledger proves history; AI Security governs agents and tools.

The cost is additional foundational work, crypto/recovery operational complexity, and migration discipline. That cost is accepted because it is the differentiator required for a sovereign identity platform designed beyond the current directory market.
