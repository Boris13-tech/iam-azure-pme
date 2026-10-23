# Private Beta scope

| Item | State |
|---|---|
| Rule | Standard, section 17b: the Beta scope is written and approved by the operator before the gate. It names the pilots' profile, the capabilities and sign-in flows they use, and the legal, retention and hosting requirements that apply to them |
| Approved | By the operator on 2026-10-18 |
| Related | [Gate register](PRIVATE-BETA-GATE-REGISTER.md), [pilot agreement draft](../legal/PILOT-AGREEMENT-DRAFT.md) |

## 1. Pilots' profile

| Item | Scope |
|---|---|
| Organizations | 1 to 3, invited by the operator. No public self-service sign-up, no broad deployment |
| People | At most 50 users in total, across all pilots |
| Sign-in | Passkeys, recovery codes, and Microsoft Entra. Each pilot may use passkeys only |
| Microsoft Entra for a pilot's own tenant | Through LUXIA's multi-tenant app registration, with the pilot administrator's consent (no per-pilot secret). Per pilot tenant, **one real sign-in is verified read-only before the pilot uses it**, and a tenant that is not connected is refused |
| Out of scope | Generic OpenID Connect providers (F4), Google, SAML, SCIM, e-mail notifications (E6), access requests |

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
| Microsoft Entra sign-in | PRODUCTION VERIFIED for the operator's tenant; per pilot tenant, see section 1 |
| Encrypted independent backups and a verified restore | PRODUCTION VERIFIED on the current platform; rehearsed on the target platform (EU-2, G4) |

## 3. Requirements that apply to the pilots

| Area | Requirement before the first pilot |
|---|---|
| Legal | The pilot agreement, its data processing agreement and the privacy notice, reviewed by counsel. The entity that signs them exists |
| Retention | The periods agreed with counsel are enforced for the data the pilot creates, or stated as not yet enforced |
| Hosting | Hosting terms that allow commercial use. Production in the EU |
| Operability | Every promise listed in section 14 of the pilot agreement is operable |
