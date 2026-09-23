# LUXIA Identity v1 runbooks

Every action must record tenant scope, deployment profile, operator, timestamps, evidence IDs, and the final disposition. Never paste secrets, raw tokens, connection strings, private keys, recovery codes, or credential material into tickets or logs.

## Provider outage

1. Confirm provider health through the connection-scoped adapter and classify the error as retryable or permanent.
2. Verify canonical `Subject`, local sessions, LUXIA_LOCAL authentication, and audit persistence remain healthy.
3. Enter `DEGRADED`; prohibit new provider-derived privilege and use only bounded, fresh evidence.
4. Apply bounded retry/backoff. After recovery, run idempotent discovery and reconciliation; quarantine ambiguity.

## Database outage

1. Set readiness to `NOT_READY` and stop writes; never fall back to an unscoped or administrative connection.
2. Preserve in-flight operation IDs for safe replay. Validate the runtime role remains non-superuser and non-bypass-RLS.
3. Restore connectivity, verify migrations and `resolve_session` execution, then reconcile before readiness returns.

## Secret-store outage

1. Set readiness to `NOT_READY` for operations requiring unavailable keys or credentials.
2. Do not read secrets from generic provider metadata or substitute environment values from another scope.
3. Restore the scoped custody service, verify key version/state, then retry only idempotent operations.

## Edge node offline

1. Enter `OFFLINE` or `PARTITIONED` from measured connectivity state.
2. Accept only fresh nonce/signature proofs and unexpired signed assurance snapshots for the same tenant and epoch.
3. Deny privilege increases and reject stale, replayed, cross-tenant, tampered, or unsupported evidence.
4. On reconnect enter `RECOVERING`, reconcile conflicts without silent overwrite, then return to `CONNECTED`.

## Restore and sovereign recovery

1. Restore only an encrypted package into an isolated environment; verify signed manifest, tenant, integrity, and recovery epoch.
2. Quarantine duplicates/conflicts and keep revoked credentials revoked.
3. Complete the multi-authority recovery ceremony and mark credentials requiring verified re-enrollment.
4. Activate the new epoch; reject replayed artifacts and invalidate stale pre-recovery state.

## Key rotation

1. Create a new version under secret custody and publish the matching trust anchor before use.
2. Switch signing/encryption to the new active version; retain old public verification material for historical evidence.
3. Revoke or mark compromised versions explicitly. Unknown/unsupported versions fail closed.
4. Verify new evidence, old evidence, replay resistance, and tenant isolation before retiring any key material.

## Provider replacement

1. Export the tenant-scoped, signed sovereign package without plaintext secrets or private keys.
2. Configure the replacement as a new `ProviderConnection`; do not alter canonical Subject IDs.
3. Discover and deterministically link projections; quarantine collisions and ambiguous matches.
4. Verify assignments, lifecycle, assurance references, and history before disabling the old connection.

## Upgrade

1. Take and verify an encrypted backup; record the current build SHA, schema migrations, crypto registry versions, and recovery epoch.
2. Run build, full tests, migration validation, provider parity, operational certification, and cutover readiness.
3. Apply additive migrations with the migration-only credential, then deploy the application and observe readiness/error/latency signals.
4. Keep the prior application artifact available until the observation gate passes.

## Rollback

1. Stop rollout and preserve evidence. Do not roll back a database by dropping columns or tables.
2. Deploy the prior compatible application artifact and disable only the new behavior flag/entry point.
3. Reconcile idempotent operations and verify canonical identity, RLS, sessions, audit, and provider parity.
4. Use sovereign restore only for demonstrated corruption, with the recovery ceremony and a new epoch.

## Compromised credential

1. Revoke the exact tenant-scoped credential/key version and all affected sessions; record evidence provenance.
2. If a signing key is affected, mark it compromised, rotate the trust anchor, and reject new evidence from it.
3. Reconcile partitions before restoring connected mode; never silently reactivate revoked state.
4. Require phishing-resistant re-enrollment or the controlled recovery ceremony.

## Alerts and evidence retention

Critical: missing database, secret custody, cryptographic trust, local authentication, or audit capability. Warning: provider, network, sync queue, or optional connector degraded. Retain security evidence according to tenant policy while preserving provenance, schema/crypto versions, recovery epoch, integrity metadata, and legal deletion requirements. Export must remain possible without a provider or Luxia Cloud.
