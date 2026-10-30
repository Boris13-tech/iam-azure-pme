# Private Beta scope

| Item | State |
|---|---|
| Rule | Standard, section 17b: the Beta scope is written and approved by the operator before the gate. It names the pilots' profile, the capabilities and sign-in flows they use, and the legal, retention and hosting requirements that apply to them |
| Approved | By the operator on 2026-10-18. Amended on 2026-10-23 by a decision the operator delegated: the first pilots use passkeys only; Microsoft Entra for a pilot's tenant moves after the Beta |
| Related | [Gate register](PRIVATE-BETA-GATE-REGISTER.md), [pilot agreement draft](../legal/PILOT-AGREEMENT-DRAFT.md) |

## 1. Pilots' profile

| Item | Scope |
|---|---|
| Organizations | 1 to 3, invited by the operator. No public self-service sign-up, no broad deployment |
| People | At most 50 users in total, across all pilots |
| Sign-in | Passkeys and recovery codes |
| Microsoft Entra for a pilot's own tenant | **After the Beta.** A new Entra connection starts DRAFT and no path activates it on `main` or in F4 (finding, 2026-10-23). It needs an Entra activation path (class A), then one real sign-in verified read-only per pilot tenant, and a refused sign-in from a tenant that is not connected |
| Out of scope | Microsoft Entra for a pilot's tenant (above), generic OpenID Connect providers (F4), Google, SAML, SCIM, e-mail notifications (E6), access requests |

## 2. Beta-critical capabilities

| Capability | State |
|---|---|
| Organization sign-up, with the founder on a passkey | PRODUCTION VERIFIED |
| Tenant isolation (forced row-level security; the runtime role cannot bypass it) | PRODUCTION VERIFIED |
| Passkey sign-in, sessions, sign-out; self-service passkey enrolment with the ceremony verified | PRODUCTION VERIFIED |
| Recovery codes and the recovery-only session | PRODUCTION VERIFIED |
| Invitations (a link handed over by the administrator) | PRODUCTION VERIFIED |
| Last-administrator guard; organization status enforced at sign-in | PRODUCTION VERIFIED |
| Leaver: disabling a person ends their sessions and accesses | Proven on PostgreSQL in CI (`tests/resources/leaver-postgres.test.ts`), on mechanisms already PRODUCTION VERIFIED |
| Resources, entitlements, separation of duties, access reviews | PRODUCTION VERIFIED |
| Security journal (append-only) and dashboard | PRODUCTION VERIFIED |
| Microsoft Entra sign-in | Not in the first pilots' scope. PRODUCTION VERIFIED for the operator's tenant only (section 1) |
| Encrypted independent backups and a verified restore | PRODUCTION VERIFIED on the current platform; rehearsed on the target platform (EU-2, G4) |

## 3. Requirements that apply to the pilots

| Area | Requirement before the first pilot |
|---|---|
| Legal | The pilot agreement, its data processing agreement and the privacy notice, reviewed by counsel. The entity that signs them exists |
| Retention | The periods agreed with counsel are **enforced** for the data the pilot creates: purge, pseudonymization and deletion mechanisms built, reviewed and running (standard, section 17b, G8). Disclosing that they are not enforced does not meet this requirement |
| Hosting | Hosting terms that allow commercial use. Production in the EU |
| Operability | Every promise listed in section 14 of the pilot agreement is operable |
