# Transparency of LUXIA operator interventions: placement and plan

Status: **direction approved by the operator (2026-10-12); this placement is a proposal.** It is separate from B5, which only labels the operator actions in the journal.

## 1. What an administrator must be able to understand

For every LUXIA intervention on the organization:
- what LUXIA did;
- when;
- why;
- on which resource;
- under which authority;
- whether it changed something;
- which audit proof exists.

**Rule: never show what the system cannot prove.** A field that does not exist for an event is shown as not available, never filled in.

## 2. What is provable today

| Question | B4 events (since PR #49) | Provisional events of 2026-10-11 (Lab, before B4) |
|---|---|---|
| What | `operation` and `metadata.action` | `operation` |
| When | `occurredAt`: database time since PR #50. The Lab closure event (19:13:29Z) carries the operator machine's time, about 180 ms early | `occurredAt` as written by the SQL action |
| Why | `metadata.reason` | `metadata.reason` |
| Resource | `metadata.targets` (account, domain or named person) and `targetSubjectId` | Action-specific keys (`identityAccountId`, `domain`) |
| Authority | `metadata.reference`: type (`LUXIA_INCIDENT`, `LUXIA_CERTIFICATION`, `VERIFIED_CUSTOMER_REQUEST`) and id; for a customer request, the verification methods, the document hash and the requested actions | **Not recorded** (no reference) |
| Changed something | `metadata.effects` (from/to, counts), `before` and `expected` | Action-specific counts |
| Proof | `changeId` = `break-glass:<plan digest>`, `planDigest`, `toolVersion`, and the local evidence files of the operator | **No signed plan** |

## 3. The gap that must be closed first: the record can be rewritten by ordinary roles

**VERIFIED in Production, 2026-10-12:**
- `CanonicalAdminAuditEvent` is protected against UPDATE and DELETE only for the `RESOURCE.ONBOARDING.*` and `RESOURCE.CAPABILITY.*` operations;
- `app_user` holds UPDATE and DELETE on it, and on `AuthenticationEvidence`, which has no guard at all;
- the owner role, the one the LUXIA operator uses, can change or delete anything, including its own `BREAK_GLASS.*` events.

**No runtime code updates or deletes these rows today.** But an audit trail that the audited party can rewrite is not proof. Until this is closed, a transparency feature would give a false feeling of transparency.

**Words matter.** The two steps give different guarantees, and the product must name each one exactly:
- **After T0:** the right term is **append-only: modification forbidden to the application and to ordinary operator paths**. A privileged database owner can still rewrite history, for example by disabling the guard in a reviewed migration. T0 must not be called immutable.
- **With Trust Ledger:** verifiable immutability (canonical payload, previous hash, event hash, checkpoint or signature). Until then, no document or sales material may claim that the journal is immutable.

## 4. Placement

**Recommendation:** the source of truth for operator interventions belongs to **LUXIA Trust Ledger**, not to a view of LUXIA Identity.

- **Identity** keeps the operational journal: what happened in the tenant, readable by its administrators.
- **Trust Ledger** keeps the tamper-evident record:
  - an append-only, per-tenant chain of entries (sequence number, hash of the previous entry, hash of the event);
  - written in the same transaction as the operator event;
  - checked by a verification function;
  - exportable as a proof the customer can keep.
- **Why Trust Ledger:**
  - the party being audited (LUXIA, which holds the owner role) must not be able to rewrite the record unnoticed;
  - a hash chain makes any rewrite evident;
  - a checkpoint held by the customer makes it provable outside LUXIA.

  An Identity view alone cannot give this.
- **Boundaries before infrastructure:** a `lib/ledger` module with its own table, guard and grants, inside the same database. No separate service now.
- **Later:**
  - the same ledger takes every privileged action, not only the operator's;
  - Policy decides which actions need a customer pre-approval.

## 5. Phases

| Phase | What | Where | Priority |
|---|---|---|---|
| T0 | **Done, PRODUCTION VERIFIED 2026-10-13** (`docs/certification/T0-AUDIT-APPEND-ONLY-RELEASE-2026-10-13.md`). **Append-only journal and sign-in evidence** (modification forbidden to application and ordinary operator roles): a database guard on UPDATE, DELETE and TRUNCATE for every row, and those grants revoked from `app_user`. No runtime code needs them. Not cryptographic immutability | Identity (migration) | **P1**, prerequisite |
| T1 | « Interventions de LUXIA » for administrators: the `BREAK_GLASS.*` events with the provable fields of section 2 only. Pre-B4 events are marked as such | Identity (view) | P2 |
| T2 | Trust Ledger v0: per-tenant chain over the operator events (canonical payload, previous hash, event hash), verification, proof export. This is the first step that may be described as verifiable | Trust Ledger | P2 |
| T3 | Customer checkpoints (the head hash given to the administrators) and a notice to administrators at each intervention. There is no e-mail or notification channel yet | Trust Ledger + notification | P3 |
| T4 | Customer pre-approval of non-emergency interventions (plan, approval, apply, verify, record) | Policy | P3 |

## 6. Fit with ALMA

The B4 procedure already follows the ALMA loop:
- **observe:** the plan's counts;
- **reason and plan:** the closed action and its digest;
- **approve:** the operator's typed confirmation; T4 would add the customer;
- **act:** apply;
- **verify:** the committed re-read;
- **audit:** the event, and later the ledger entry.

Keeping this contract (plan, digest, explicit approval, verified effect, recorded proof) is what will let ALMA propose interventions without being all-powerful. ALMA would prepare plans. A human or a policy approves them, and the ledger records them.
