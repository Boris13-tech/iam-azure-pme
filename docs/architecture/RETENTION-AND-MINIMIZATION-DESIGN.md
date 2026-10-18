# Retention and data minimization: mechanism design (E15, E16)

| Item | State |
|---|---|
| Status | **DESIGNED (proposal)**, 2026-10-18. Class C document; every mechanism below is a class A change with its own threat model and review |
| Why now | Private Beta criterion G8 (standard, section 17b): retention and deletion enforced for the data the pilot creates. The periods come from counsel ([policy draft](../legal/DATA-RETENTION-AND-DELETION.md)). The mechanisms do not depend on the exact periods, so they can be ready when the periods arrive |
| Principle | **Periods are configuration, mechanisms are code.** Every purge is bounded, idempotent, journaled with its counts, and runs through a fixed SQL function, never an ad-hoc `DELETE` |

## 1. Facts that shape the design (VERIFIED on `main`, 2026-10-18)

| # | Fact | Where | Consequence |
|---|---|---|---|
| F-1 | `Session.ipHash` and `Session.userAgentHash` are unsalted SHA-256 values (an IPv4 address can be recovered by trial). They are **written at sign-in and read by no application path**. The session list already excludes them (#22) | `lib/auth/session-store.ts` (write only); `lib/admin/canonical-administration.ts` (projection) | They can stop being written with **no functional loss** (E15) |
| F-2 | **Session rows are immutable** after creation, apart from `lastSeenAt` and one revocation. A revoked session is entirely frozen. The guard compares every column, including the two hashes | Trigger `luxia_session_guard`, migration `20261011180000` | The proposed "remove the hashes after 30 days" is **impossible without a migration**. The guard must gain a one-way redaction: hash to `NULL`, nothing else |
| F-3 | The journal and the sign-in evidence are append-only for the runtime role **and the owner** (T0) | Migration `20261013090000_audit_append_only` | Removing a period of journal needs a dedicated, gated path in the trigger itself, never disabling it |
| F-4 | Journal metadata names people by internal identifiers and types, not by names | `writeAudit` call sites | Pseudonymizing a person changes the `Subject` and account rows only; the journal is never rewritten |
| F-5 | Abuse counters are already purged after 2 days | `lib/security/rate-limit.ts` | No change |
| F-6 | Expired sign-in challenges and Microsoft sign-in transactions are kept with no limit | `LocalAuthChallenge`, `AuthTransaction` | First purge target (no audit value) |
| F-7 | The GitHub scheduler is unreliable for this repository (E4 diagnosis) | E4 certification | Scheduling uses the hosting platform's cron, which costs nothing: Vercel Cron (daily jobs are included in every plan) |

## 2. Mechanisms

| # | Data | Mechanism | Needs counsel? | Class |
|---|---|---|---|---|
| **R1** | Session network hashes, **new** sessions (E15) | **Stop writing them** (store `NULL`). Recommended over a keyed hash (HMAC): nothing reads them, and a keyed hash would add a secret to protect. If an investigation need appears later, a keyed hash with a 30-day life is designed then | No: less data is never against the policy | A (small code change) |
| **R2** | Session network hashes, **existing** rows | Migration: `luxia_session_guard` allows exactly one more transition, `ipHash` / `userAgentHash` to `NULL`, on any session, revoked or not; every other column stays frozen. Then a redaction function clears them all once (R1 makes the set final) | No | A (migration, Production gate) |
| **R3** | Expired challenges and Microsoft transactions | Function `luxia_retention_purge_transactions(batch)`: deletes rows expired for more than the configured period (proposal: 7 days), in bounded batches. Fixed predicate, `SECURITY DEFINER`, fixed `search_path`, executable by the runtime role. It journals one event with the counts | Period only (proposal: 7 days) | A |
| **R4** | Expired or consumed invitations | Same pattern, period from counsel | Period | A |
| **R5** | Journal, sign-in evidence and ended sessions, by period | **Operator procedure**, like break-glass (B4): plan per organization and period (counts), digest, typed confirmation, then a function that the T0 trigger lets through **only** inside that function. The function checks: a transaction-local marker set by it, the row older than the cutoff, and the cutoff not more recent than the policy minimum. Journaled in the operator journal | Periods (default proposal: 1 year) | A (migration, Production gate) |
| **R6** | A person who left (retired) | Pseudonymization after the period: the name becomes "Former member" plus a short identifier, and the local sign-in name is replaced. The journal is unchanged (F-4). Journaled | Period, and the erasure procedure | A |
| **R7** | A closed organization, or **the end of a pilot** | Operator procedure after a reversible quarantine: delete every row of the organization except what the law requires to keep, then verify (zero rows per table) and record it in the operator journal. Backups expire within 30 days | Period (proposal: 90 days), and what the law requires to keep | A (Production gate) |
| **R8** | Independent backups | A lifecycle rule removes versions older than 30 days, plus monthly copies if counsel keeps them | Monthly copies | Operator gate (storage) |

## 3. Running the purges

- **Schedule:** daily, from the hosting platform's cron (Vercel Cron, at no cost, budget cap of €40 per month and €0 until the operator's signal) to an internal endpoint. It runs in the same minutes as the hourly backup, so Neon Free's compute is woken once (100 compute-hours a month). The endpoint is protected by its own secret, like the monitoring readiness check (#102): without the secret, it answers like any unauthenticated path.
- **Dry run first:** for 7 days, the job records only the counts it would purge. Then it enforces.
- **Bounded:** each call handles a fixed batch and stops. A backlog drains over several days rather than locking tables.
- **Alerting:** a failed run raises an error event (monitoring M-C). A purge that has not run for 3 days raises a heartbeat alert (M-E pattern).
- **Evidence:** each run writes one journal event with the counts per data class; never row contents.

## 4. Order, mapped to the pilot (G8)

1. **R1** (no counsel needed; stops the privacy debt from growing).
2. **R2** and **R3**, then **R7** for the end of a pilot: these cover "the data the pilot creates".
3. **R5**, **R6** and **R4**, once counsel sets the periods.
4. **R8** with the backup storage gate.

R1 to R3 are designed so that the review of one does not wait for counsel.

## 5. Tests (per mechanism, when implemented)

| Mechanism | Tests |
|---|---|
| R1 | No hash is stored at sign-in (passkey and Microsoft); session behaviour is unchanged |
| R2 | The redaction to `NULL` is accepted on active and revoked sessions. Any other change is still refused, including setting a hash back, and changing a hash to another value |
| R3, R4 | Only rows older than the cutoff go. A row of another organization is untouched by an organization-scoped call. The batch bound holds. A second run is a no-op. The journal event carries the counts |
| R5 | The trigger refuses a `DELETE` outside the function, by the runtime role and by the owner. Inside the function, rows newer than the cutoff are refused, and so is a cutoff more recent than the policy minimum. Plan digest mismatch refuses |
| R6 | The name and the sign-in name are replaced; journal rows are byte-identical before and after |
| R7 | Zero rows remain per table for the organization; other organizations are byte-identical; the operator journal records it |

## 6. Open points

- Whether the runtime role keeps any direct `DELETE` privilege on the tables purged by R3 and R4: inventory at implementation, and removed if possible (only the functions delete).
- The legal basis and period for any network data kept for security investigations: none is kept after R1. If counsel wants some, a keyed hash with a short life is designed then.
