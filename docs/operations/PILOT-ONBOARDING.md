# Onboarding a Private Beta pilot

| Item | State |
|---|---|
| Purpose | How a pilot organization is brought onto LUXIA Identity, step by step, and who does what |
| Scope | The [Private Beta scope](../engineering/PRIVATE-BETA-SCOPE.md): the first pilots sign in with **passkeys** and recovery codes. Microsoft Entra for a pilot's own tenant comes after the Beta (decision of 2026-10-23; no activation path exists yet) |
| Preconditions | The Private Beta gate is passed ([PRIVATE_BETA_READINESS.md](../../PRIVATE_BETA_READINESS.md)). The pilot agreement and its data processing agreement are signed |
| Roles | **Operator** (LUXIA), **founder** (the pilot's first administrator), **administrators**, **members** |

## 1. Before the pilot (operator)

1. Agreement and DPA signed; the pilot's **security contacts** recorded (named people, e-mail and phone), for incident notices (pilot agreement, section 8.4).
2. Pilot recorded in the operator's register: organization name, contacts, start and end dates, user limit (the Beta allows at most 50 users across all pilots).
3. **Signup code** issued. This is a Production write (standard, section 10), done in two steps with the operator's tool once #121 is merged:
   - `npx tsx scripts/operators/signup-codes.ts plan --by "<operator>" --days 14 --note "<pilot>"` writes nothing, binds the request to the database and the tool commit, and prints a digest valid 15 minutes;
   - `npx tsx scripts/operators/signup-codes.ts issue --plan <plan.json> --confirm <digest>` issues one code for that plan, and refuses a changed, expired, re-targeted or reused plan.

   **Until #121 is merged, the tool on `main` writes the code at once, with no confirmation: it is not used for a pilot.**
   The code is printed once and only its hash is stored. It reaches the founder through a channel other than the one carrying the sign-up link.

## 2. Sign-up (founder, about 5 minutes)

1. Open `/signup` and enter the code, the organization's name and identifier, the founder's name and sign-in name.
2. Register a **passkey** on the device. The organization, the founder and the passkey are created in one transaction.
3. Sign in with the passkey.

## 3. First steps (founder)

The dashboard's "Mise en route" checklist follows these steps.

| Step | Why | Where |
|---|---|---|
| Create **recovery codes** | A lost device must not lock the founder out | Settings, recovery section |
| Add a **second permanent administrator**, who can sign in | An organization can never lose its last administrator; two remove the single point of failure | Organization |
| Invite the team | Each person gets an invitation link, valid 7 days. The administrator hands it over by a channel of their choice (LUXIA sends no e-mail yet) | Organization |
| Each invited person registers a passkey from the link, then creates their recovery codes | — | Invitation link |
| Verify a domain (optional) | Shows the organization controls its domain | Organization |
| Register a first resource and its entitlements | Accesses are explicit, never implicit | Resources |
| Launch a first access review | Confirms the right people hold the right accesses | Governance, access reviews |

## 4. During the pilot

| Situation | What to do |
|---|---|
| A person leaves | An administrator disables them: their sessions end at once, and their accesses are revoked. Proven by `tests/resources/leaver-postgres.test.ts` |
| A device is lost | The person signs in with a recovery code, gets a recovery-only session, and registers a new passkey |
| Every administrator is locked out | The operator's break-glass procedure: planned, digested and journaled, and visible to the organization ([runbook](B4-BREAK-GLASS-RUNBOOK.md)) |
| Something looks wrong | The security journal shows every administration action and every sign-in. The customer's security contacts can reach the operator directly |
| Service availability | No service-level commitment during the pilot. One operator, no on-call rotation (pilot agreement, section 7) |

## 5. End of the pilot

1. On request, an **export** of the organization's data (pilot agreement, section 9.2). The operator tool exists and is tested; it needs an independent review before it reads Production.
2. **Deletion** of the organization within 90 days, with written confirmation. This requires the R7 mechanism, which is designed and not yet built: a signing condition of the agreement.
3. Backups expire 30 days after the deletion once the lifecycle rule (R8) is in place.

## 6. What the operator checks before saying "ready"

- The founder signed in with a passkey, and the sign-in evidence is in the journal.
- Two administrators can sign in, and both have recovery codes.
- No other organization is visible from the pilot's organization (isolation is enforced by the database; the restore drills re-check it).
- The pilot's security contacts received a test notice and acknowledged it (pilot agreement, section 14).
