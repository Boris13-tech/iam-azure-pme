# First Admin / Break-glass v1, B4: the operator break-glass procedure (design)

Status:
- **Design only.** No code, migration, deployment or Production change is part of this document.
- **Decisions D1 to D7 (section 12) await the operator's approval.** Code starts only after that approval.

Binding inputs:
- `docs/product/FIRST-ADMIN-BREAK-GLASS-V1-SCOPE.md`, decisions K3 and K4, and the binding requirements in section 9:
  - 9.1 statuses;
  - 9.2 closed actions, never generic SQL;
  - 9.3 dry run, plan digest and confirmation;
  - 9.5 replay of the Lab neutralization.
- What is already in Production:
  - B1, the last-administrator guard, under the tenant governance lock;
  - the migration `Organization.status` + `Session.scope`: the database refuses a status change from any role other than the operator role, CLOSED is final, sessions are append-only;
  - B3: `transitionOrganization`, the operator-only primitive, and the lock order governance → organization row → other rows;
  - B2: recovery codes, which can be consumed only in an ACTIVE organization.
- **Finding P1**, binding: Prisma 5.20 does not report a failed COMMIT of an interactive transaction. Every apply ends with `SET CONSTRAINTS ALL IMMEDIATE` and then re-reads the committed state.
- **The Lab precedent (2026-10-11).** A provisional owner SQL transaction did these things:
  - created a `SERVICE` subject « Opérateur LUXIA (break-glass) »;
  - revoked the sessions;
  - disabled the founder and the member (identity account, local identity, passkeys);
  - released the domain `cert.luxia-it.com` after a DNS check;
  - journaled `BREAK_GLASS.SESSION.REVOKE`, `BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE` ×2 and `BREAK_GLASS.DOMAIN.RELEASE`.

  B4 replaces that raw SQL with a supported procedure.
- **The R6 precedent (2026-10-12).** `luxia-cert-b2-r6` was SUSPENDED directly with the B3 primitive, which writes no journal event. Its final closure is part of B4.

## 1. Principles

1. **Closed list.** The procedure runs a fixed set of named actions written in code. It accepts no SQL, query or free expression. Every parameter is validated against the target organization.
2. **LUXIA never gains authority.** The operator gets no grant, no session and no account in any tenant. It reads no business data beyond the counts and identifiers the plan needs.
3. **Plan first, then confirm.**
   - A dry run always comes first. It computes the exact plan and its digest.
   - Applying requires that digest. The plan is computed again inside the transaction; if anything changed, nothing is written.
4. **Everything is audited where the customer can see it.** Each action writes its event in the organization's own journal, in the same transaction as the change.
5. **The lock order of B1 and B3, and the P1 rule.** Governance locks of every tenant first, then the organization row, then the other rows. Every apply ends with `SET CONSTRAINTS ALL IMMEDIATE` and a committed re-read.
6. **Irreversible means a human gate.** CLOSE and DISABLE_ACCOUNT cannot be undone in v1. They need an extra typed confirmation, and in Production the operator's explicit approval for each run.

## 2. The tool

| Topic | Design |
|---|---|
| Form | An operator command: `npx tsx scripts/operators/break-glass.ts <plan\|apply> ...`, the same pattern as `scripts/operators/signup-codes.ts`. The logic sits in `lib/operators/break-glass.ts`, so PostgreSQL and architecture tests can call it. No route, page or API of the application can reach it (architecture test). |
| Connection | The owner connection, given in `LUXIA_OWNER_DATABASE_URL`. The command refuses to run unless the role has BYPASSRLS, which the status guard requires anyway, and the endpoint is direct (no pooler). The connection string is never printed. |
| Who runs it | The LUXIA operator only (K3). Dual operator approval stays out of scope for v1, but the plan format leaves room for a second approver's digest. |
| Operator identity in the tenant | One `SERVICE` subject per organization, « Opérateur LUXIA (break-glass) ». It is created on first use and is always DISABLED, with no identity account, key, assignment or session. If the organization already has exactly one such subject (the Lab does since 2026-10-11), it is reused; if it has several, the run is refused. A database test proves the subject can never resolve a session or hold an assignment. |
| Evidence file | Each plan and each apply writes a local JSON file: plan, digest, result, after state and tool version (git SHA). It holds no secret, no session id and no code. A recovery invitation link is the one exception: it is printed once on screen and is never written to the file. |

## 3. Closed actions

| Action | Preconditions | Effects (one transaction) | Journal event | Reversible |
|---|---|---|---|---|
| `suspend` | ACTIVE | B3 primitive to SUSPENDED: every open session revoked | `BREAK_GLASS.ORGANIZATION.SUSPEND` | Yes, through `reactivate` |
| `reactivate` | SUSPENDED | B3 primitive to ACTIVE. Nothing comes back: revoked sessions stay revoked | `BREAK_GLASS.ORGANIZATION.REACTIVATE` | Yes, through `suspend` |
| `close` | ACTIVE or SUSPENDED; typed slug confirmation (D4) | B3 primitive to CLOSED: sessions and open invitations revoked, domains released (VERIFIED to LOST, PENDING to EXPIRED). Accounts, passkeys and recovery codes are left untouched: sign-in is refused at the organization level, and the B2 guard refuses any code consumption outside ACTIVE (D4) | `BREAK_GLASS.ORGANIZATION.CLOSE` | **No.** The database refuses any change after CLOSED |
| `revoke-sessions` | any status | every open session of the organization, any scope, revoked conditionally | `BREAK_GLASS.SESSION.REVOKE` | No, but people simply sign in again |
| `disable-account <identity account id>` | the account belongs to this organization; last durable administrator rule (D2) | identity account DISABLED (with `disabledAt`), local identity DISABLED, active passkeys REVOKED, sessions of that account revoked | `BREAK_GLASS.IDENTITY_ACCOUNT.DISABLE` | **No** in v1: the product has no "re-enable" |
| `release-domain <domain>` | the domain belongs to this organization and is VERIFIED or PENDING; the TXT record is absent on two public resolvers, both at plan time and again at apply | VERIFIED to LOST, or PENDING to EXPIRED | `BREAK_GLASS.DOMAIN.RELEASE` | No: the customer verifies the domain again |
| `recovery-invitation <named person>` | ACTIVE; a verified customer request that names the person (section 5); the rule of D3 | a PROVISIONING subject, plus a single-use ADMIN invitation with operator authority (section 6). The link is shown once | `BREAK_GLASS.RECOVERY_INVITATION.ISSUE` | Yes: the invitation can be revoked until it is used |

Refused in every case:
- a target of another organization;
- an unknown action;
- a free parameter;
- a CLOSED organization (except a dry run, which reports "nothing possible");
- an action on Legrand Tech without its own approved request.

The operation names keep the `BREAK_GLASS.*` family the Lab journal already uses. B5 adds the French labels (« Action opérateur LUXIA : … »).

## 4. Dry run, plan digest, confirmation (scope 9.3)

**`plan`** reads in a `READ ONLY` transaction and prints the plan.
- **The plan is a canonical JSON:**
  - tool version (git SHA);
  - action;
  - organization: id, slug, status, `statusChangedAt`;
  - targets (identifiers only);
  - before counts and expected after counts;
  - DNS result (for `release-domain`);
  - reference and verification (section 5);
  - reason;
  - `notAfter`, the issue time + 15 minutes (D5).
- **Digest:** `SHA-256` of the canonical JSON.
- Nothing is written to the database.

**`apply --confirm <digest>`** runs one owner transaction:
1. takes the governance lock of every tenant, then the organization row lock;
2. **recomputes the plan inside the transaction**; if the digest differs, or `notAfter` has passed, it is refused and nothing is written;
3. applies the action, the B3 primitive for status changes, and writes the journal event, whose `changeId` is `break-glass:<digest>`;
4. runs `SET CONSTRAINTS ALL IMMEDIATE`;
5. after the commit, **re-reads the committed state** (P1) and compares it with the expected after counts.

The unique `changeId` per organization means one plan applies at most once: a replayed confirmation fails on the unique index, with nothing written.

**`close` and `disable-account`** also require `--irreversible <slug>`, the organization slug typed exactly.

## 5. A verified customer request (new)

Every plan carries a **reference**, and every reference has a type.

| Reference type | Allowed actions | Required verification (recorded in the plan and the event) |
|---|---|---|
| `CUSTOMER_REQUEST` | all | The requester's name and role, the channel, and at least **two independent verification methods** from a fixed list:<br>• a call back to a contact recorded before the request;<br>• an email from a domain this organization has VERIFIED;<br>• confirmation by another administrator who can still sign in;<br>• a signed letter or contract.<br>The plan stores the **SHA-256 of the request document**, never the document itself. |
| `LUXIA_INCIDENT` | `suspend`, `revoke-sessions` only | An incident id and a reason. `close` is not allowed: closing a customer organization needs the customer's request (or a legal basis, which is out of v1). |
| `LUXIA_CERTIFICATION` | all, but **only on LUXIA's own certification organizations** | The organization must be on a fixed list in code: the Lab `luxia-certification-lab` and `luxia-cert-b2-r6`. |

- `recovery-invitation` needs `CUSTOMER_REQUEST`, and the request must name the person who receives the invitation (K4).
- **D1** asks whether v1 relies on this out-of-band evidence only. The recommendation is yes. An in-product « demande à l'opérateur » signed by a durable administrator is stronger, but it is a separate product feature (table, interface, API), and it cannot help the main break-glass case, an organization whose administrators can no longer sign in.

## 6. Recovery invitation with operator authority

Today an ADMIN invitation is accepted only if the **inviter still holds `assignments.manage`** when the link is used. The operator's `SERVICE` identity holds nothing by design, so B4 needs a separate, narrow authority rule.

- **Migration (expand only).** `Invitation.issuedByOperatorChangeId` (TEXT, nullable). It points to the `break-glass:<digest>` journal event that issued the invitation.
- **Acceptance.** An invitation that carries this column grants the administrator bundle because of that event, not because of the inviter's rights.
- **Database checks at acceptance:**
  - the organization is ACTIVE;
  - the event exists in the same organization, with `BREAK_GLASS.RECOVERY_INVITATION.ISSUE` and SUCCESS;
  - the invitation is unused, unrevoked and not expired.
- **Lifetime 24 hours** (D3), instead of the 7 days of ordinary invitations: the window in which a leaked link is dangerous is shorter.
- **When it is allowed** (D3, recommended): only when the organization has **no durable administrator who can still sign in**, which is the real break-glass case. Otherwise the customer's own administrators can invite.
- **Residual risk, stated plainly.** The operator sees the link once and delivers it to the named person through the verified channel. In v1 nothing technical stops a dishonest operator from using it. Mitigations:
  - the 24-hour lifetime;
  - the acceptance is journaled (`INVITATION.ACCEPT` plus the role grants) and visible to the customer's administrators;
  - the named person confirms receipt through the verified channel;
  - dual control is the planned later step.

## 7. The last-administrator rule (B1) for `disable-account`

B1 refuses any change that takes a tenant from at least one durable administrator to none. Recommendation **D2**:
- in an **ACTIVE** organization, `disable-account` keeps that refusal: the right tool is `recovery-invitation` or the customer's own administration;
- in a **SUSPENDED** organization, disabling the last durable administrator is allowed. The organization no longer operates, and this is exactly the Lab case.

The sequence for neutralizing an organization is therefore `suspend` → `revoke-sessions` → `disable-account` … → `release-domain` → `close`.

## 8. Complete audit

Each action writes, in the **same transaction** as the change, one event in the organization's journal.
- **Actor:** « Opérateur LUXIA (break-glass) ».
- **Target:** the affected person, if any.
- **Metadata:**
  - action, `planDigest`, tool version;
  - reference type and id, the verification methods and the document hash;
  - reason;
  - before and after counts;
  - target identifiers.

  It contains no secret, no session id and no link.

The other parts of the audit:
- **No new journal table** (D6). The organization's journal survives CLOSED, because data is kept. A LUXIA-wide view is a read-only query over `BREAK_GLASS.*` events across organizations.
- **Refusals:** a refused apply (digest mismatch, expired plan, rule refusal) writes nothing to the database. It is recorded in the local evidence file.
- **Earlier changes that were not journaled** are referenced in the next event. When `luxia-cert-b2-r6` is closed, its `BREAK_GLASS.ORGANIZATION.CLOSE` event records the earlier SUSPENDED change (2026-10-12 15:18:29Z, B3 primitive, reference `docs/certification/FIRST-ADMIN-BREAK-GLASS-V1-B2-RELEASE-2026-10-12.md`).

## 9. Concurrency

| Race | Expected outcome |
|---|---|
| Two applies of the same plan | One commits. The other is refused (digest recomputed, or unique `changeId`), with nothing written |
| Apply ‖ a sign-in or session creation | B3 lock order: the sign-in waits on the organization row and is then refused, or its session is revoked by the transition |
| Apply ‖ the customer's administration (grants, invitations) | Both take the governance lock: they run one after the other, and the plan is recomputed under the lock |
| `disable-account` ‖ a grant to the same person | Serialized on the governance lock; the B1 counts are evaluated under the lock |
| Plan made, state changed before apply | Refused: the digest differs. The operator plans again |

Each race gets a PostgreSQL test with real lock waits, as in B1, B2 and B3.

## 10. Lab replay (scope 9.5)

1. Clone the archive `br-icy-darkness-aho1v83p`: the Lab before neutralization, 2026-10-11 13:50:30Z, LSN `0/3C43E70`. The clone is temporary and is deleted afterwards.
2. Bring the clone to the current schema with `prisma migrate deploy`: the 23 Production migrations, plus the B4 migration if D3 is approved.
3. Run the procedure only, with `plan` and then `apply`, under reference `LUXIA_CERTIFICATION`:
   - `suspend`;
   - `revoke-sessions`;
   - `disable-account` for the founder, then for the member;
   - `release-domain cert.luxia-it.com`;
   - `close`.
4. **Expected:** the same before and after as the SQL action, with no raw SQL:

   | Item | Before | After |
   |---|---|---|
   | Sessions | 2 | 0 |
   | Active accounts, local identities and passkeys | 2 | 0 |
   | Domain | VERIFIED | LOST |
   | Status | ACTIVE | CLOSED |

   The journal events are authored by « Opérateur LUXIA (break-glass) ». A sign-in then gets the generic refusal.
5. Compare the result with the 2026-10-11 Production outcome (`docs/certification/CUSTOMER-SELF-ONBOARDING-V1-MULTI-ORG-CERTIFICATION-2026-10-11.md`).
6. Delete the clone. **Delete the archive branch only after B4 is certified**, as the operator instructed.

## 11. Production use after release

Each step needs a separate approval, and each CLOSE is a human gate.

| Organization | Today | Plan |
|---|---|---|
| `luxia-certification-lab` | ACTIVE, already neutralized by SQL: no session, accounts disabled, domain LOST | Dry run (expected: only `close` is left), then `close` under `LUXIA_CERTIFICATION` |
| `luxia-cert-b2-r6` | SUSPENDED since 2026-10-12, by the B3 primitive, not journaled | Dry run, then `close` under `LUXIA_CERTIFICATION`. The event records the earlier, unjournaled suspension (section 8) |
| `legrand-tech` | ACTIVE | **No action.** Every run proves Legrand Tech is unchanged (fingerprint), as in B2 |

## 12. Decisions requested

| # | Question | Recommendation |
|---|---|---|
| D1 | How is a customer request verified in v1? | **Out-of-band evidence recorded in the plan**: at least two independent methods and the request document hash (section 5). An in-product request comes later as its own feature. |
| D2 | Can `disable-account` disable the last durable administrator? | **Only in a SUSPENDED organization.** In ACTIVE the B1 refusal stays (section 7). |
| D3 | Recovery invitation: authority, lifetime, when | **Operator authority bound to its journal event** (one expand migration); **24 hours**; **only when no durable administrator can still sign in**. The residual risk is stated (section 6). |
| D4 | What does `close` do beyond the B3 effects? | **Nothing more**: accounts, passkeys and codes stay as they are, because every sign-in and code use is already refused for CLOSED. It requires the typed slug in addition to the digest. |
| D5 | How long is a plan valid? | **15 minutes** (`notAfter` is part of the digest). |
| D6 | Is a separate LUXIA-side table needed for operator actions? | **No.** The organization journal (same transaction), the unique `changeId` and the local evidence files are enough in v1. |
| D7 | Which reference types may trigger which actions? | `CUSTOMER_REQUEST`: all. `LUXIA_INCIDENT`: `suspend` and `revoke-sessions` only. `LUXIA_CERTIFICATION`: all, on the fixed list of LUXIA certification organizations only (section 5). |

## 13. Rollback

- **Code:** the procedure is an operator command. Rolling back means not running it. The application changes only if D3 is approved (invitation acceptance with operator authority), and the B2 deployment `fe34cf7` stays a safe rollback target.
- **Migration** (only with D3): expand only, with a written rollback script. It is rehearsed on a clone, including the case of an operator invitation that has not been used yet.
- **Actions:**
  - `suspend` and `reactivate` undo each other;
  - `recovery-invitation` can be revoked until it is used;
  - `close` and `disable-account` are irreversible by design, which is why each needs the typed confirmation and a human gate in Production.

## 14. Certification plan

- **Unit:**
  - canonical plan and digest stability;
  - every parameter refused outside the target organization;
  - `notAfter`;
  - the reference rules of D7.
- **PostgreSQL** (owner for the command, `app_user` for the product views), for every action:
  - the right effects and one journal event in the same transaction;
  - a digest mismatch and an expired plan write nothing;
  - a replayed confirmation is refused by the unique `changeId`;
  - the B1 rule of D2;
  - the operator `SERVICE` subject never holds an account, assignment or session;
  - the races of section 9;
  - and, if D3 is approved, operator invitations: 24 hours, single use, refused in a non-ACTIVE organization, refused without the event, granted bundle identical to a founder's.
- **Architecture:**
  - the closed list;
  - no free SQL in the operator module;
  - nothing in `app/` or `lib/` reaches it except the command and the tests;
  - the B3 lock-order map extended.
- **Lab replay** on the archive clone (section 10), and **a fingerprint of Legrand Tech** before and after every run.
- **Production** (each step approved separately):
  1. migration (only with D3);
  2. deployment (only with D3);
  3. dry runs on the Lab and on `luxia-cert-b2-r6`;
  4. then each `close` as a human gate.

## 15. Out of scope for v1

- Dual operator approval.
- An in-product request to the operator (D1).
- Reopening a CLOSED organization.
- Deleting data or organizations (retention rules first).
- Re-enabling a disabled account.
- Any action on Legrand Tech without its own request and approval.
