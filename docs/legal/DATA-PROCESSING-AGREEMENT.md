# LUXIA Identity: data processing agreement (structure and technical annexes)

**DRAFT — LEGAL REVIEW REQUIRED.** This is the **structure** of the agreement and its **technical annexes**, written from the implemented architecture (2026-10-13). The legal clauses must be written or validated by counsel. Nothing here is a binding offer.

## Parties and roles

- **Controller:** the customer organization.
- **Processor:** **[TO BE COMPLETED: LUXIA legal entity]**.

## Clauses to be written by counsel (checklist)

1. Subject, duration, nature and purpose of the processing (Annex 1).
2. Processing only on documented instructions of the controller, including for transfers.
3. Confidentiality of the people authorized to process the data.
4. Security measures (Annex 2).
5. Subprocessors: the current list, the notice before a change, the right to object (`SUBPROCESSORS.md`).
6. Assistance with data subject requests (`DATA-SUBJECT-REQUESTS.md`).
7. Assistance with security, breach notification and impact assessments (`INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md`).
8. Deletion or return of the data at the end of the service (Annex 3).
9. Information and audit rights.
10. International transfers (`DATA-RESIDENCY.md`).
11. Liability, governing law and courts.

## Annex 1: description of the processing

| Item | Content |
|---|---|
| Nature | Hosting and running the customer's identity and access management: sign-in, accesses, administration, audit, recovery |
| People concerned | The organization's members, administrators and invitees; people whose accounts come from the organization's identity provider |
| Data categories | As listed in section 3 of `PRIVACY-POLICY.md`: identities, sign-in identifiers, Microsoft identifiers, passkey public keys, recovery code hashes, sessions with IP and user-agent hashes, sign-in records, journal, rights and resources |
| Special categories | None intended. Passkeys never send biometric data to LUXIA |
| Duration | The contract, then the deletion period of Annex 3 |

## Annex 2: technical and organizational measures

These are taken from `SECURITY-OVERVIEW.md`, and only measures that are in place:
- forced row-level isolation per organization, with no bypass for the application role;
- phishing-resistant passkeys;
- recovery codes and session tokens stored only as hashes;
- no organization can lose its last administrator;
- operator interventions only through a closed, journaled procedure, visible to the customer, with no rights given to LUXIA;
- an append-only journal and sign-in records for the application and ordinary operator roles;
- TLS in transit;
- change management with automated tests and Production verification.

**Planned measures must not appear in this annex until they are in place:** independent encrypted backups, monitoring, EU hosting.

## Annex 3: end of service

- **Return:** an export of the organization's data **[TO BE BUILT: readiness E9]**.
- **Deletion:** after **90 days (PROPOSED)**, as set out in `DATA-RETENTION-AND-DELETION.md` section 2, recorded in the operator journal.
- **Backups:** deleted data expires from locked backups within their retention period.

## Annex 4: subprocessors

See `SUBPROCESSORS.md`, current version.
