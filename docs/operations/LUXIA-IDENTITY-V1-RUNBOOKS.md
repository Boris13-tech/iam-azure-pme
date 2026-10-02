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

## Credential or key incident

1. Identify the exact tenant, credential, key version, evidence usages, and affected sessions without copying secret material.
2. Mark the credential/key `REVOKED` or `COMPROMISED`, revoke affected sessions, and activate a new version under custody.
3. Preserve old public verification material where safe; distrust new evidence from the compromised version and require verified re-enrollment.
4. Reconcile disconnected nodes before clearing the incident and retain signed incident evidence.

## Edge node offline

1. Enter `OFFLINE` or `PARTITIONED` from measured connectivity state.
2. Accept only fresh nonce/signature proofs and unexpired signed assurance snapshots for the same tenant and epoch.
3. Deny privilege increases and reject stale, replayed, cross-tenant, tampered, or unsupported evidence.
4. On reconnect enter `RECOVERING`, reconcile conflicts without silent overwrite, then return to `CONNECTED`.

## Network partition

1. Establish which side retains authoritative write capability and increment the local partition epoch.
2. Allow only bounded existing access backed by fresh local proof; deny privilege increases and cross-tenant snapshots.
3. Queue idempotent evidence, never last-write-wins security state, and surface conflicts as alerts.
4. Reconnect in `RECOVERING`, reject stale epochs, quarantine conflicting revocation/lifecycle state, then explicitly complete reconciliation.

## Restore and sovereign recovery

1. Restore only an encrypted package into an isolated environment; verify signed manifest, tenant, integrity, and recovery epoch.
2. Quarantine duplicates/conflicts and keep revoked credentials revoked.
3. Complete the multi-authority recovery ceremony and mark credentials requiring verified re-enrollment.
4. Activate the new epoch; reject replayed artifacts and invalidate stale pre-recovery state.

## Backup restore

1. Select an encrypted backup and verify its signed manifest, tenant, format/crypto versions, package ID, epoch, and completeness.
2. Decrypt only through scoped custody into an isolated environment; fail closed on any integrity or scope mismatch.
3. Run migrations forward, RLS/isolation, canonical ID, revoked credential, and evidence provenance checks.
4. Promote only through the recovery ceremony; record restore evidence and retain the prior environment until acceptance.

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

## Failed deployment

1. Mark the deployment unavailable, stop promotion, keep the previous READY alias, and capture build/runtime evidence.
2. If already exposed, restore the prior compatible application artifact without reversing additive migrations.
3. Verify health, RLS, authentication fail-closed behavior, provider parity, and cutover readiness.
4. Correct only the demonstrated cause, rerun complete CI, and require a new immutable deployment before promotion.

## Compromised credential

1. Revoke the exact tenant-scoped credential/key version and all affected sessions; record evidence provenance.
2. If a signing key is affected, mark it compromised, rotate the trust anchor, and reject new evidence from it.
3. Reconcile partitions before restoring connected mode; never silently reactivate revoked state.
4. Require phishing-resistant re-enrollment or the controlled recovery ceremony.

## Compromised provider credentials

1. Disable the affected `ProviderConnection` or secret reference and enter `DEGRADED`; canonical subjects remain unchanged.
2. Revoke the provider credential at its source, create a least-privilege replacement, and rotate the connection-scoped reference.
3. Audit provider operations during the exposure window, quarantine suspicious projections, and reconcile idempotently.
4. Restore connector health only after scoped validation; never grant access solely from provider claims observed during the incident.

## Tenant isolation incident

1. Set affected operations to `NOT_READY`, preserve evidence, and revoke sessions that may have crossed scope.
2. Confirm runtime role posture, forced RLS, organization/tenant context, provider-connection scope, and bridge mappings.
3. Quarantine ambiguous records; do not repair by broad administrative queries or by weakening RLS.
4. Restore from verified evidence, run the complete cross-tenant suite, notify affected owners, and record containment and recurrence controls.

## Alerts and evidence retention

Critical: missing database, secret custody, cryptographic trust, local authentication, or audit capability. Warning: provider, network, sync queue, or optional connector degraded. Retain security evidence according to tenant policy while preserving provenance, schema/crypto versions, recovery epoch, integrity metadata, and legal deletion requirements. Export must remain possible without a provider or Luxia Cloud.
