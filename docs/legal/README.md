# LUXIA legal and trust documents

**DRAFT — LEGAL REVIEW REQUIRED.** Every document in this folder is a technical first draft, written on 2026-10-13 from the architecture that is actually implemented. None of them is a legal commitment. None may be published or signed before review by qualified counsel.

## Rules for these drafts

- **No compliance claim that has not been demonstrated.** Nowhere does LUXIA say it is « GDPR compliant », certified, or audited. Hosting data in the EU does not make a service compliant.
- **Facts come from the code and from Production.** When a fact is not established, the text says UNKNOWN, and a blank to fill is written `[TO BE COMPLETED]`.
- **Current state and target state are kept apart.** For example, Production is hosted in the US today, and the EU (Frankfurt) is the decided target before a commercial beta.
- **Every promise must be operable.** A document must not promise a delay, a right or a measure that LUXIA cannot deliver today. Gaps are listed in each document under « Gaps to close before publication ».

## Documents

| Document | Purpose | For |
|---|---|---|
| `PRIVACY-POLICY.md` | What LUXIA processes about people, why, and their rights | People whose identities are managed, website visitors |
| `DATA-PROCESSING-AGREEMENT.md` | Processor terms between LUXIA and a customer organization | Customers (controllers) |
| `SUBPROCESSORS.md` | Who processes customer data for LUXIA, where | Customers |
| `DATA-RETENTION-AND-DELETION.md` | How long each kind of data is kept, and how it is deleted | Customers, internal |
| `SECURITY-OVERVIEW.md` | Security measures in place, stated factually | Customers, prospects |
| `INCIDENT-RESPONSE-AND-BREACH-NOTIFICATION.md` | What LUXIA does in an incident, and who is told when | Internal, customers |
| `DATA-RESIDENCY.md` | Where data is stored today, and the target | Customers |
| `DATA-SUBJECT-REQUESTS.md` | How requests from individuals are handled | Internal, customers |

## Open questions for counsel (UNKNOWN today)

1. The legal entity that operates LUXIA: name, registered address, registration number, VAT number.
2. The governing law and courts, and the jurisdictions where customers are expected (EU, Cameroon and other African countries, others). Each brings its own data protection law; Cameroon's personal data framework must be checked.
3. Whether a Data Protection Officer or an EU representative is required.
4. The transfer mechanism while data is in the US (before the move to the EU), and for each US subprocessor.
5. The liability caps, the audit rights and the notification delays LUXIA can commit to.
