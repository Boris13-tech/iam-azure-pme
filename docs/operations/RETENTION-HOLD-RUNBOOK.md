# Hold register: operator procedure

Scope: [Private Beta scope, section 4.3](../engineering/PRIVATE-BETA-SCOPE.md). Migration: `20261112130000_retention_hold_register`. Rollback: [RETENTION-HOLD-REGISTER-ROLLBACK.sql](RETENTION-HOLD-REGISTER-ROLLBACK.sql), only while the register has never been used.

A hold keeps an organization's data when a legal obligation or claim requires it, or on the customer's documented instruction. LUXIA is the processor: counsel confirms each case before a hold is placed. A hold takes precedence over every deletion path.

## What the database does

| Path | With an active hold |
|---|---|
| R4, scheduled (finished invitations) | Skipped; the run record counts the skipped rows (`held`) |
| R6, scheduled (retired people) | Skipped; the run record counts the skipped people (`held`) |
| Invitation guard, R4 exception | A DELETE of a held organization's invitation is refused |
| R7, organization erasure | Fails, and the whole transaction rolls back: the register row has a RESTRICT foreign key to the organization and is found by the completeness check |
| R6 on request, end of pilot | Not run on held data. Before each run, check the register and record the check in the run's plan (procedural until these commands read it themselves) |
| Daily status | R4 and R6 count only what they may act on; `held` per mechanism; `holds.active` and `holds.overdueReview` |

A review date that passes never releases a hold. The hold stays in effect, and the daily job logs `retention: holds past their review date` until the hold is renewed or released.

## Steps (owner session, Production change with the operator's GO)

The basis document stays in the private record. The database holds only its reference: 3 to 40 characters, uppercase letters, digits and hyphens, e.g. `HOLD-2026-001`.

1. Check the register and the history:
   `SELECT * FROM "RetentionHold";` and `SELECT * FROM "RetentionHoldEvent" ORDER BY "id";`
2. Place a hold (review date: today or later, UTC):
   `SELECT luxia_retention_hold_place('<organizationId>', 'HOLD-2026-001', DATE '2027-05-12');`
   It waits for a running R4 or R6 call to finish. Once it commits, every later run skips the organization: R4, R6 and the hold check refuse any transaction isolation other than READ COMMITTED (`RETENTION_REQUIRES_READ_COMMITTED`), so a run cannot read the register as it was before the hold.
3. Renew it at or before the review date, with the reference of the renewal record:
   `SELECT luxia_retention_hold_renew('<organizationId>', 'HOLD-2026-001-R1', DATE '2027-11-12');`
4. Release it only when the basis has ended, with the reference of the release record:
   `SELECT luxia_retention_hold_release('<organizationId>', 'RELEASE-2026-001');`
   Deletions resume on the next scheduled run, and R7 becomes possible again.

Each function writes one row in `RetentionHoldEvent`: the operator journal of holds. It is append-only, for the owner too, and it outlives the organization's erasure (column `heldOrganizationId`).

The write guard on `RetentionHold` refuses a direct INSERT, UPDATE or DELETE that does not come from these functions. It protects against mistakes. It does not constrain the owner, who could set the functions' marker or disable a trigger: the owner session is trusted, as for R7. Always use the three functions.

The runtime role (`app_user`) can read and write neither table, and can execute none of these functions.
