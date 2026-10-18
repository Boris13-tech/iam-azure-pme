# LUXIA Identity: annexes for a data processing agreement (country-independent facts)

**DRAFT — LEGAL REVIEW REQUIRED.** Technical draft, 2026-10-18.

**Purpose.** The facts that any data processing agreement between a customer organization and LUXIA will need, whatever the jurisdiction. The legal frame is chosen by counsel once the operator decides the entity's country: the agreement itself, the clauses, the applicable law and any transfer mechanism.

**Scope of the facts.** They describe the service as it runs and is proven today. Each measure carries a status:
- **IN PLACE** means proven, with the evidence named;
- **IN PROGRESS** means implemented or designed, not yet in Production;
- **NOT YET** means a known gap.

## Annex A: description of the processing

| Item | Description |
|---|---|
| Nature | Identity and access management for the customer organization: sign-in of its people, sessions, administration of people, accounts, entitlements and access reviews, and a security journal |
| Purpose | Authenticate the organization's people; decide and record who may access what; keep the evidence of security-relevant actions |
| Data subjects | People of the customer organization (members and administrators); the person who signs the organization up |
| Categories of personal data | Name. Sign-in name. Identifiers of the person's accounts (for example the Microsoft Entra object and tenant identifiers). Public keys and credential identifiers of passkeys (never private keys). Hashes of session tokens, recovery codes and invitation tokens (never the clear values). Session times and scope. Sign-in evidence (method, outcome, time, reason code). Journal events (actor and target identifiers, operation, time) |
| Special categories | None processed by design |
| E-mail addresses | Not collected for customer organizations. A legacy table from before the canonical model holds e-mail addresses of LUXIA's own early records (ASSUMPTION: confirm by a read-only count before signature) |
| Network identifiers | After mechanism R1 (#107, IN PROGRESS), none is stored with sessions. Abuse-protection counters keep a hash of the network address for 2 days (IN PLACE) |
| Duration | The contract, plus the retention periods agreed with counsel ([retention draft](DATA-RETENTION-AND-DELETION.md)) |
| Location | Today: United States (Neon `aws-us-east-1`, Vercel `iad1`). Target before any commercial pilot: European Union (Neon Frankfurt, Vercel `fra1`), rehearsed on 2026-10-18 ([runbook](../operations/EU-MIGRATION-RUNBOOK.md)). Encrypted backups: European Union (Microsoft Azure, France Central) |

## Annex B: technical and organisational measures

| Area | Measure | Status | Evidence |
|---|---|---|---|
| Isolation between organizations | Row-level security forced on every tenant table; the runtime database role cannot bypass it; every query carries its organization and tenant | IN PLACE | Certifications in `docs/certification/`; PostgreSQL suites in CI; the behaviour checks of the restore drills (each organization sees exactly its own rows) |
| Authentication | Passkeys (WebAuthn, phishing-resistant), with the ceremony verified server-side; single-use recovery codes giving a recovery-only session; Microsoft Entra through OpenID Connect with PKCE, nonce and an issuer pinned per directory | IN PLACE | Releases B2 and F1, #64 |
| Sessions | Random tokens stored only as hashes; HttpOnly, Secure, SameSite=Lax cookies; 24-hour lifetime; every session revoked when a person or an organization is disabled | IN PLACE | Session guard; leaver test on PostgreSQL (#99) |
| Authorization | Explicit entitlements with least privilege; separation of duties; access reviews; an organization can never lose its last administrator | IN PLACE | Resources and governance v1, SoD v1, access reviews v1, B1 |
| Accountability | The security journal and the sign-in evidence are append-only: the application and the database owner are refused any change. LUXIA operator actions go through a planned, digested and journaled procedure, visible to the customer | IN PLACE | T0, B4, B5; restore drills re-check the append-only refusals |
| Encryption in transit | TLS between browser and application, and between application and database (`sslmode=require`) | IN PLACE | Configuration |
| Encryption at rest | Storage encryption of the database provider (ASSUMPTION: per the provider's documentation). Backups are encrypted by LUXIA before they leave the backup job (age, X25519), with a key held only by LUXIA | Backups: IN PLACE. Database: ASSUMPTION | E1 |
| Availability and recovery | Encrypted backups outside the database provider, protected against deletion for 30 days. Full restores rehearsed: Drill B (2026-10-13), EU-2 into Frankfurt (2026-10-18, identical) | IN PLACE | E1, E4, the runbook's section 6b |
| Secrets | Secrets referenced, never written to logs or evidence; secret scanning with push protection; a history scan in CI (#101) | Scanning: IN PLACE. History scan in CI: IN PROGRESS | Repository settings |
| Change management | A written engineering standard; class A changes need an independent human review; CI on every change; pinned CI actions | Standard and CI: IN PLACE. Independent review: **NOT YET** (first reviewer being sought) | Standard v1, gap analysis |
| Monitoring | Backup freshness alerted to a human. Application availability, errors and sign-in success designed at no cost | Backup alert: IN PLACE. Application monitoring: IN PROGRESS | E4; #92, #102, #108 |
| Incident response | Severity levels and runbooks. Response times are **not guaranteed** (one operator, no on-call) | Partly in place | Standard, section 16 |
| Data minimization | No network identifier stored with sessions; retention mechanisms designed | IN PROGRESS | #107, #103 |

## Annex C: subprocessors

See [SUBPROCESSORS.md](SUBPROCESSORS.md). Changes under the zero-cost monitoring design (option Z, #92), **not in use yet**:
- UptimeRobot (availability probes; no personal data: public pages and protected health answers only);
- an error-tracking backend using the Sentry protocol, in its EU region, receiving scrubbed events only (#108).

The other monitoring vendor (Better Stack) is **not** planned while the budget is zero.

## Gaps to close before signature

- The legal frame (counsel, after the operator decides the entity's country).
- The retention periods.
- The independent review.
- The move of Production to the EU.
- Application monitoring.
