# LUXIA Identity: data retention and deletion

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). Section 1 states what the code does today (VERIFIED in the repository). Section 2 proposes the policy. The periods in section 2 are proposals for counsel, not commitments.

## 1. Today

| Data | Kept today | Deleted today |
|---|---|---|
| Abuse-protection counters (hash of the IP address) | 2 days | Yes, automatically by the database |
| Sessions (hash of the identifier, of the IP address and of the user agent; times; scope) | Valid 24 hours (15 minutes for a recovery session); **records kept with no limit** | No |
| Sign-in challenges and Microsoft sign-in transactions | Valid minutes; **records kept with no limit** | No |
| Administration journal and sign-in records | **No limit.** Append-only since T0: no ordinary statement can delete them | No |
| Recovery codes (hashes only) | No limit; used and revoked codes stay frozen | No |
| Invitations | Valid 7 days (24 hours for an operator invitation); records kept | No |
| People, accounts, passkeys | Until disabled, retired or revoked by an administrator; records kept | No hard deletion in the product |
| A closed organization (status CLOSED) | Everything is kept; sign-in is impossible | No; customer deletion is out of scope of v1 |
| Database rollback points (Neon branches) | 14 days after a certified release (target policy); 6-hour point-in-time history | Yes, by expiry |
| Independent backups (since 2026-10-13) | Every 2 hours, encrypted; each version protected against deletion for 30 days. Expired versions are not removed automatically yet | Not yet: a lifecycle rule comes with the periods agreed with counsel |

**Conclusion:** today LUXIA keeps nearly everything with no limit. That is not acceptable for a commercial service. It must be fixed before the beta (section 2), and the privacy policy must not promise otherwise in the meantime.

## 2. Proposed policy

| Data | Proposed period | How |
|---|---|---|
| Abuse counters | 2 days | As today |
| Expired sign-in challenges and Microsoft transactions | Deleted 7 days after expiry | Scheduled purge (no audit value) |
| Invitations | **PROPOSED: deleted 30 days after expiry or use.** They hold only token hashes; the journal keeps the event | Scheduled purge (R4) |
| Sessions | **No network identifier stored** (R1, #107); existing hashes removed once (R2). The rest of the session row is kept with the journal period, as evidence of access | Code change (R1); one-way redaction migration (R2) |
| Journal and sign-in records | **PROPOSED: 1 year by default**, in line with the CNIL's recommendation for access logs (6 months to 1 year, deliberation 2021-122). A customer may extend it **up to 3 years** with a documented justification (internal control, legal obligation). LUXIA operator interventions are kept as long as the customer's journal, and at least 1 year | Removal of whole time periods (for example monthly partitions) by a reviewed, journaled procedure, never row by row by the application. This keeps T0's rule: the application can never delete history (R5) |
| Deleted or retired person | **PROPOSED: pseudonymized 30 days after the person is retired** (time to correct a mistaken retirement). A disabled person stays until the customer retires them. A customer's erasure request (the customer is the controller) is executed within 30 days. The journal keeps the pseudonymous identifier | Erasure request procedure (`DATA-SUBJECT-REQUESTS.md`), mechanism R6 |
| Closed organization | **PROPOSED: everything deleted 90 days after closure** (a reversible quarantine for mistakes and disputes), except what the law requires to keep. **The end of a pilot follows the same rule, after the export window.** The deletion is recorded in the operator journal | Operator procedure after the quarantine, mechanism R7 |
| Independent backups | **PROPOSED: 30 days (in place), and no monthly copies** (minimization). Deleted data therefore disappears from the backups within 30 days of its deletion. They are protected against deletion during that time | Immutability and a lifecycle rule (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`), mechanism R8 |

## 3. Tension to resolve with counsel: append-only versus erasure

T0 forbids the application and ordinary operator statements to rewrite the journal and the sign-in records. A right to erasure can conflict with that.

The proposed answer:
1. Security and audit records may have a legal basis to be kept for a limited time.
2. During that time, a person's identity can be **pseudonymized**. The journal refers to people by internal identifiers, and the names live in other tables, so erasing the name does not rewrite the journal.
3. At the end of the period, whole periods are removed by a reviewed procedure.

**Backups:** deleted data stays in the backups until they expire (30 days today; they cannot be deleted earlier, by design). Counsel must confirm that this is acceptable, and how to say it.

## Gaps to close before publication

- Validation of every period marked **PROPOSED** (2026-10-18, prepared by the LUXIA legal workstream from the CNIL recommendation and the minimization principle; not legal advice).
- The purge jobs, pseudonymization and closure deletion: designed here, not built.
