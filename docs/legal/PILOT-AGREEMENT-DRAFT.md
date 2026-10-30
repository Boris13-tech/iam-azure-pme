# LUXIA Identity: private pilot agreement (template)

**DRAFT — LEGAL REVIEW REQUIRED.** Template prepared on 2026-10-18 by the LUXIA legal workstream. It is a drafting aid, not legal advice. It is country-independent on purpose: the governing law, the courts and the entity are chosen once the operator decides the entity's country. Every promise below must be operable on the day of signature (section 14).

---

**Between:**
- **[TO BE COMPLETED: LUXIA legal entity, registration, address]** ("LUXIA"),
- **[Customer organization, registration, address]** (the "Customer").

## 1. Purpose

The Customer evaluates LUXIA Identity, an identity and access management service, during a limited private pilot (the "Pilot"). The Pilot is a pre-release service, offered to a small number of organizations, before general availability.

## 2. Scope of the Pilot

1. **Users:** at most **[number, within the Beta limit of 50 users across all pilots]** people of the Customer.
2. **Capabilities:**
   - sign-in with passkeys;
   - recovery codes;
   - administration of people, accounts, entitlements and access reviews;
   - the security journal.
   Sign-in through the Customer's own Microsoft Entra tenant, generic OpenID Connect providers and other capabilities are outside the Pilot.
3. **No critical dependency.** The Customer keeps an independent way to reach its critical systems during the Pilot. LUXIA Identity must not be the only path to them.

## 3. Duration

From **[start date]** for **[3] months**, renewable by written agreement. Either party may end the Pilot at any time with **[15] days'** written notice. Either party may end it at once for a material breach or a security reason.

## 4. Fees

The Pilot is **free of charge**. No fee is due, and none becomes due without a new written agreement.

## 5. The Customer's role and obligations

1. The Customer is the **controller** of the personal data of its people processed in the Pilot. It decides why and how they are processed, and informs its people.
2. The Customer:
   - keeps its administrator accounts and recovery codes safe;
   - names at least two administrators;
   - promptly removes access of people who leave;
   - uses the Pilot only for its internal identity management, within the law.

## 6. LUXIA's obligations

1. LUXIA operates the Pilot with reasonable care and skill. It applies the technical and organisational measures described in [the DPA annexes](DPA-ANNEXES-DRAFT.md), annex B.
2. LUXIA processes the Customer's personal data only as a **processor**, on the Customer's documented instructions, under the data processing agreement in section 8.
3. LUXIA journals its own operator interventions on the Customer's organization, and the Customer can see them.

## 7. No service levels during the Pilot

The Pilot is provided **without any availability, performance or support-time commitment**. LUXIA aims to restore service as fast as it can. It states openly that it has **one operator and no on-call rotation**, so it guarantees no response or recovery time.

## 8. Data protection

1. A data processing agreement is part of this agreement: **[TO BE DECIDED with counsel: the clauses, for example the European Commission's standard contractual clauses between controllers and processors (Implementing Decision (EU) 2021/915) where the GDPR applies]**. Its annexes are [DPA-ANNEXES-DRAFT.md](DPA-ANNEXES-DRAFT.md).
2. **Subprocessors:** those listed in [SUBPROCESSORS.md](SUBPROCESSORS.md). LUXIA informs the Customer **[30] days** before adding or replacing one, and the Customer may object by ending the Pilot.
3. **Location:**
   - Production runs in the United States today, and moves to the European Union before the Pilot starts (rehearsed on 2026-10-18).
   - Some subprocessors are US companies. Any transfer relies on the mechanism counsel confirms (for EU data, for example the EU–US Data Privacy Framework for certified recipients, or standard contractual clauses).
4. **Personal data breach:** LUXIA notifies the Customer **without undue delay**, with a first notice within **[48] hours** of becoming aware of it (so that the Customer, as controller, can meet its own legal deadline), and follow-ups as facts are established.

## 9. Retention, return and deletion

1. **During the Pilot:** the periods of [DATA-RETENTION-AND-DELETION.md](DATA-RETENTION-AND-DELETION.md) apply. Default proposal: the journal and sign-in records are kept 1 year.
2. **At the end of the Pilot:**
   - on request made within **[15] days**, LUXIA provides an export of the Customer's data in a machine-readable format within **[15] days**;
   - LUXIA then deletes the Customer's organization and its data within **[90] days**, and confirms it in writing;
   - encrypted backups that still contain the data are deleted about **[46]** days after that deletion, an estimate that depends on the storage platform's processing (they cannot be deleted during their first 30 days, by design).
3. Data that a law requires LUXIA to keep is kept only for that purpose and that time.

## 10. Confidentiality

Each party keeps the other's non-public information confidential, uses it only for the Pilot, and protects it with at least reasonable care. This lasts **[3] years** after the Pilot ends.

## 11. Intellectual property and feedback

LUXIA keeps all rights in LUXIA Identity. The Customer keeps all rights in its data. LUXIA may use the Customer's feedback to improve the service, without naming the Customer unless the Customer agrees in writing.

## 12. Liability

1. To the extent the applicable law allows:
   - each party's total liability is limited to **[TO BE DECIDED: an amount]**;
   - neither party is liable for indirect or consequential loss.
2. These limits do not apply to:
   - gross negligence or wilful misconduct;
   - breach of confidentiality;
   - liability that the law does not allow to be limited.

## 13. Governing law and disputes

**[TO BE DECIDED once the entity's country is decided.]** The parties first try to settle any dispute amicably within **[30] days**.

## 14. Conditions LUXIA must meet before signing (internal, not part of the agreement)

| Promise | Operable today? | Needed |
|---|---|---|
| Production in the EU before the Pilot (8.3) | Rehearsed, not done | Gate EU-4 |
| Export on request (9.2) | **Operator tool drafted and tested on synthetic data** (2026-10-22; evidence held privately, not yet verifiable from this repository): one organization, read-only consistent snapshot, one JSON file per table, security material removed (hashes, passkey keys, tokens, session identifiers), manifest with SHA-256; 17 of 17 checks. No product feature yet (E9) | Independent review of the tool before any use on Production (it reads Production) |
| Deletion within 90 days and written confirmation (9.2) | **Designed** (R7) | Implemented and tested, or a tested manual operator procedure |
| Breach notification within 48 hours (8.4) | Partly: backup alerting exists; application monitoring is in review | Monitoring active (G6), alert path tested (G7), runbook exercised |
| Removal of network identifiers (DPA annex A) | In review (R1) | R1 merged and deployed |
| Retention periods enforced (9.1) | **No**: purge and pseudonymization are designed (R3 to R6), not built | R3 to R6 built, reviewed and running (G8 requires enforcement; a disclosure does not replace it) |
| Backups deleted within the agreed period (9.2) | **No**: immutability stops early deletion, but no lifecycle rule deletes expired versions. The rule is prepared (R8, runbook section 8) | R8 applied and verified (operator gate); the period in 9.2 set to the real worst case (46 days, or 33 with a 1-day recycle bin) |
| A tested channel to the Customer's security contacts (8.4) | **No** product channel (E6) | The named contacts recorded, and a test notice sent and acknowledged |
| Hosting terms that allow the Pilot | **No** (Vercel Hobby is non-commercial) | Vercel Pro: `BLOCKED_BY_BUDGET` |
| Counsel review of this agreement | No | Free consultation, or a budget |
