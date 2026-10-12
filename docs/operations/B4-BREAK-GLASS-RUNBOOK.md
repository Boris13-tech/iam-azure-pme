# B4 operator break-glass: runbook

Design: `docs/architecture/FIRST-ADMIN-BREAK-GLASS-V1-B4-OPERATOR-DESIGN.md`. D1 to D7 and Q1 were approved on 2026-10-12.

The procedure is the only supported way for LUXIA to act on a customer organization. It runs a closed list of actions, never SQL. In Production, **every run needs the operator's explicit approval**, and every `CLOSE_ORGANIZATION` or `DISABLE_ACCOUNT` is a human gate.

## 1. Prerequisites

- A checkout of `main` at the released commit. The commit is part of the plan digest, so plan and apply must run from the same code.
- `LUXIA_OWNER_DATABASE_URL`: the owner connection on the **direct** endpoint. The command refuses the pooler, and any role without BYPASSRLS.
- A request file (JSON) with the closed inputs only (section 2).
- For `RELEASE_DOMAIN`: the customer has removed the `_luxia-verification.<domain>` TXT record.

## 2. Request file

```json
{
  "action": "SUSPEND_ORGANIZATION",
  "organization": "acme-corp",
  "reason": "Confinement demandé par le client après compromission",
  "reference": {
    "type": "VERIFIED_CUSTOMER_REQUEST",
    "id": "REQ-2026-001",
    "requester": { "name": "Jeanne Martin", "role": "Directrice générale", "channel": "Courrier signé" },
    "verificationMethods": ["CALLBACK_KNOWN_CONTACT", "SIGNED_LETTER_OR_CONTRACT"],
    "documentSha256": "<SHA-256 of the request document>",
    "requestedActions": ["SUSPEND_ORGANIZATION", "REVOKE_SESSIONS", "DISABLE_ACCOUNT"]
  }
}
```

**Targets:**
- `DISABLE_ACCOUNT` adds `"identityAccountId"`.
- `RELEASE_DOMAIN` adds `"domain"`.
- `RECOVERY_INVITATION` adds `"namedPerson"`, which must equal `reference.namedPerson`.

No other field is accepted.

**Authority matrix (D7 and Q1):**

| Reference type | Allowed actions |
|---|---|
| `LUXIA_INCIDENT` | `SUSPEND_ORGANIZATION`, `REVOKE_SESSIONS` |
| `LUXIA_CERTIFICATION` | any action, only on `luxia-certification-lab` and `luxia-cert-b2-r6` |
| `VERIFIED_CUSTOMER_REQUEST` | only the actions listed in `requestedActions` |

A verified request needs two distinct methods from this list:
- `CALLBACK_KNOWN_CONTACT`;
- `EMAIL_FROM_VERIFIED_DOMAIN`;
- `OTHER_ADMINISTRATOR_CONFIRMATION`;
- `SIGNED_LETTER_OR_CONTRACT`.

It also needs the SHA-256 of the request document; the document itself is never stored. `legrand-tech` accepts only its own verified request.

## 3. Dry run, then apply

```
npx tsx scripts/operators/break-glass.ts plan --request request.json
npx tsx scripts/operators/break-glass.ts apply --plan .break-glass-evidence/<file>.plan.json --confirm <digest> [--irreversible <organization>]
```

**`plan` writes nothing to the database.** It prints:
- the plan: state, counts, target, expected result;
- its digest;
- its expiry, 15 minutes later;
- the exact `apply` command.

**`apply`, in one transaction:**
1. takes the governance locks and the organization row lock;
2. recomputes the plan and requires the same digest;
3. acts;
4. writes the `BREAK_GLASS.*` journal event, authored by « Opérateur LUXIA (break-glass) »;
5. then re-reads the committed state.

`CLOSE_ORGANIZATION` and `DISABLE_ACCOUNT` also need `--irreversible <organization>`, the exact identifier typed.

**Common refusals.** Each one writes nothing:
- `DIGEST_MISMATCH`: the state, an input or the code changed; plan again.
- `PLAN_EXPIRED`: the plan is older than 15 minutes.
- `ALREADY_APPLIED`: this plan was already applied.
- `AUTHORITY_REFUSED` or `ACTION_NOT_REQUESTED`: the reference does not allow this action.
- `LAST_ADMINISTRATOR_PROTECTED`: suspend the organization first (D2).
- `ADMINISTRATOR_CAN_SIGN_IN`: an administrator can still invite; no emergency invitation (D3).
- `DNS_RECORD_PRESENT` or `DNS_CHECK_FAILED`: the TXT record is still there, or DNS did not answer.

## 4. The emergency administrator invitation (D3)

`apply` prints the link **once**: it is valid for 24 hours and single use. It is not written to the evidence file, the journal or any log.

1. Deliver it only to the person named in the request, through the verified channel.
2. Ask the person to confirm receipt.

When the person accepts, the database checks the break-glass event. The person becomes an administrator through that event's authority. The operator never holds a right.

## 5. Evidence

`.break-glass-evidence/` (not committed) keeps every plan and apply file: inputs, plan, digest, result, committed state. Attach them to the certification report or the incident ticket.

## 6. Rollback

- **Code:** stop using the command. If an application rollback is needed, deploy the previous release; it never creates or honours operator invitations.
- **Database:** `docs/operations/B4-BREAK-GLASS-ROLLBACK.sql`, rehearsed on a clone. It revokes open operator invitations first, then restores the previous invitation guard and state CHECK.
- **Actions:**
  - `SUSPEND_ORGANIZATION` and `REACTIVATE_ORGANIZATION` undo each other;
  - `CLOSE_ORGANIZATION` and `DISABLE_ACCOUNT` cannot be undone.
