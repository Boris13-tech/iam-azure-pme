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
| Independent backups | Not in place | |

**Conclusion:** today LUXIA keeps nearly everything with no limit. That is not acceptable for a commercial service. It must be fixed before the beta (section 2), and the privacy policy must not promise otherwise in the meantime.

## 2. Proposed policy

| Data | Proposed period | How |
|---|---|---|
| Abuse counters | 2 days | As today |
| Expired sign-in challenges and Microsoft transactions | Deleted 7 days after expiry | Scheduled purge (no audit value) |
| Sessions | Hashes of the IP address and user agent removed 30 days after the session ends; the rest kept with the journal | Scheduled job, journaled |
| Journal and sign-in records | **Per customer:** 1 year by default, configurable up to **[TO BE DECIDED]** years; LUXIA operator interventions kept at least as long as the customer contract plus **[TO BE DECIDED]** | Removal of whole time periods (for example monthly partitions) by a reviewed, journaled procedure, never row by row by the application. This keeps T0's rule: the application can never delete history |
| Deleted or retired person | Name and identifiers replaced by a pseudonym after **[TO BE DECIDED]**; the journal keeps the pseudonymous identifier | Erasure request procedure (`DATA-SUBJECT-REQUESTS.md`) |
| Closed organization | Everything deleted **[TO BE DECIDED, for example 90 days]** after closure, except what the law requires to keep; deletion recorded in the operator journal | Operator procedure, after a reversible quarantine period |
| Independent backups | 30 daily and 12 monthly; locked against deletion during that time | Object lock and lifecycle (`docs/operations/INDEPENDENT-BACKUP-ARCHITECTURE.md`) |

## 3. Tension to resolve with counsel: append-only versus erasure

T0 forbids the application and ordinary operator statements to rewrite the journal and the sign-in records. A right to erasure can conflict with that.

The proposed answer:
1. Security and audit records may have a legal basis to be kept for a limited time.
2. During that time, a person's identity can be **pseudonymized**. The journal refers to people by internal identifiers, and the names live in other tables, so erasing the name does not rewrite the journal.
3. At the end of the period, whole periods are removed by a reviewed procedure.

**Backups:** deleted data stays in locked backups until they expire. Counsel must confirm that this is acceptable, and how to say it.

## Gaps to close before publication

- A decision on every **[TO BE DECIDED]**.
- The purge jobs, pseudonymization and closure deletion: designed here, not built.
