# LUXIA Identity v1 operational certification

Certification target: the provider-independent identity foundation delivered through Phase 6I. This gate certifies operational contracts and evidence; it does not perform a production feature cutover.

## Profiles

### Cloud

Requires the database, secret custody, cryptographic trust, local authentication fallback, and audit sink. Loss of an external provider produces a visible degraded state without deleting canonical identity. Result: **PASS**.

### Hybrid

Requires the Cloud controls plus edge runtime and local policy cache. Synchronization and external-provider loss are bounded, retryable degradations; local identity remains usable. Result: **PASS**.

### Sovereign

Requires no Luxia Cloud or external identity provider for critical authentication, canonical identity, policy cache, audit, backup, or recovery. Network loss is an expected operating mode with bounded evidence and no privilege increase. Result: **PASS**.

## Operational gates

- Readiness is profile-aware and fails closed for missing critical dependencies.
- Health distinguishes `READY`, `DEGRADED`, and `NOT_READY`; alert states are `OK`, `WARNING`, and `CRITICAL`.
- Structured telemetry redacts secret, password, token, key, cookie, authorization, credential, and database URL fields.
- Retry attempts are bounded, exponential, observable, and restricted to retryable failures.
- Startup and shutdown transitions are explicit and idempotent.
- Offline proof, partition reconciliation, provider outage, replay, expiry, tenant isolation, and provider parity remain covered by the existing suites.
- Backup uses authenticated encryption; recovery requires signed manifests, epoch checks, isolated restore, multi-authority ceremony, and explicit activation evidence.
- Migrations remain additive and CI deploys them before tests; rollback is application-first and never silently reverses an applied data migration.
- The deterministic readiness baseline evaluates 10,000 snapshots within 2 seconds on the CI runner; this is a regression sentinel, not a production capacity claim.

The authoritative machine-readable result is `docs/operations/identity-v1-certification.json`. `npm run test:operations` fails whenever a required gate is not `PASS`, lacks evidence, or references a missing file.

## Known limitations

Identity v1 does not certify Trust Graph, Policy, Trust Ledger, AI Security, provider write-back, multi-region active/active, or automatic destructive rollback. Legacy compatibility remains inventoried and intentionally retained.
