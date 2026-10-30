# LUXIA Identity: data subject requests

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). Delays and identity checks must be validated by counsel.

## 1. Who answers

- **People whose identity an organization manages in LUXIA:** the organization is the controller. The request goes to it. If LUXIA receives the request, it forwards it to the organization **within 5 working days (PROPOSED)** without answering on the substance, and helps the organization answer.
- **People for whom LUXIA is the controller** (for example the person who signed an organization up, for LUXIA's own account data): LUXIA answers directly.

## 2. Verifying the requester

Identity is checked through a channel already linked to the person or organization, never only by the e-mail that sent the request. For an organization, this follows the rules of a verified customer request in the B4 procedure: two distinct methods, such as a call-back to a known contact and a signed letter.

## 3. What LUXIA can do today

| Right | How today | Gap |
|---|---|---|
| Access | The operator extracts the person's data with a read-only query, reviewed before it is sent | No self-service export (readiness E9) |
| Rectification | The organization's administrators edit names and identifiers in the product | |
| Erasure | Disabling and retirement exist; **no hard deletion or pseudonymization yet** | Planned (`DATA-RETENTION-AND-DELETION.md`, section 3) |
| Restriction | Suspending a person's identity or account stops sign-in and use | |
| Portability | Same as access; no standard export format yet | Readiness E9 |
| Objection | Assessed case by case with the organization | |

The journal and the sign-in records are append-only. An erasure therefore pseudonymizes the person in the tables that hold names. It never rewrites the journal (`DATA-RETENTION-AND-DELETION.md`, section 3).

## 4. Delays

- Under the GDPR: one month, extendable in limited cases.
- Other laws: **[TO BE COMPLETED by counsel]**.
- LUXIA's commitment to its customers for help: **PROPOSED: LUXIA gives the customer the information or action it needs within 10 working days of its request**, so that the customer can answer the person within its own legal deadline (one month under the GDPR, article 12(3)).

## 5. Records

Each request is recorded:
- date;
- requester (verified how);
- organization;
- right;
- answer;
- date closed.

The register is kept in LUXIA's private evidence store, sealed with SHA-256 manifests (PROPOSED).

## Gaps to close before publication

- The export (E9).
- Pseudonymization.
- The forwarding channel to organizations (E6).
- The register.
