# LUXIA Identity: incident response and breach notification

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). The notification delays must be validated by counsel for each applicable law; the ones below are placeholders based on common practice, not commitments.

## Current capacity, stated honestly

- **One operator.** No on-call rotation. No automated monitoring yet, so an incident may be noticed late.
- **Tools that exist:**
  - the B4 operator procedure, to contain an organization (suspend it, revoke its sessions, disable an account);
  - the append-only journal and sign-in records;
  - read-only Production checks;
  - database rollback points.

## 1. Severity

| Level | Examples |
|---|---|
| **S1, critical** | Data of an organization exposed to another one or to the outside; unauthorized administrator access; loss of the database |
| **S2, major** | Service down; sign-in impossible for an organization; a security control found ineffective |
| **S3, minor** | Degraded service; a vulnerability without evidence of use |

## 2. Steps

1. **Detect and record.** Open an incident record:
   - time (UTC);
   - who noticed it;
   - what is known.

   Keep a timeline from that moment.
2. **Contain.** Use the narrowest tool that stops the harm:
   - revoke sessions;
   - suspend the organization (B4, `LUXIA_INCIDENT` reference: suspension and session revocation only);
   - roll back a deployment;
   - rotate a secret.

   Every operator action is journaled.
3. **Preserve evidence.**
   - Take read-only snapshots.
   - Never alter the journal: it is append-only since T0.
   - Keep the operator's evidence files.
4. **Assess.**
   - Which organizations, which data, which people, which period?
   - Is personal data involved? Is there a risk to people?
5. **Notify** (section 3).
6. **Recover.** Restore the service, from backups if needed (`docs/operations/BACKUP-RESTORE-PLAN.md`).
7. **Learn.**
   - Within **[TO BE DECIDED, for example 10 working days]**, write a post-incident report: cause, impact, timeline, fixes.
   - Track every fix to a release.

## 3. Notification

| Who | When (proposal for counsel) | How |
|---|---|---|
| **Affected customer organizations** (controllers), when LUXIA acts as their processor | **Without undue delay**, with a first notice within **[TO BE DECIDED, for example 24 hours]** of confirming a personal data breach that affects them | Direct contact with their administrators **[TO BE COMPLETED: channel; e-mail is not in place yet]** |
| **Supervisory authority**, when LUXIA is the controller (its own data) | Within the delay of the applicable law. Under the GDPR, 72 hours after becoming aware, unless the breach is unlikely to result in a risk | **[TO BE COMPLETED: competent authority, depending on the LUXIA entity]** |
| **Affected people**, when LUXIA is the controller and the risk is high | Without undue delay | **[TO BE COMPLETED]** |

**Content of a notice:**
- the nature of the breach;
- the categories and approximate number of people and records;
- the likely consequences;
- the measures taken and proposed;
- a contact.

When something is not known yet, the notice says so, and follows up.

## 4. Records

Every incident and every breach, notified or not, is recorded with its facts, effects and remedies **[TO BE COMPLETED: register location]**.

## Gaps to close before the commercial beta

- Monitoring and alerting (readiness E4).
- A notification channel to customer administrators (E6).
- A second person able to act (E7).
- The legal entity and competent authority.
- A practice run of this procedure.
