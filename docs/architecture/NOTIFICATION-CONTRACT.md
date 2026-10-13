# Notification contract: `Notification → Channel Adapter`

Status: **DESIGNED** (2026-10-13), contract only. It is not built until a feature depends on it. The operator decided on 2026-10-13 that LUXIA Identity must never depend on a particular mail provider.

## Who needs it

- invitations (today a link copied by hand);
- recovery: a recovery code used, a new passkey after a recovery;
- security: a new administrator, an account disabled;
- LUXIA operator interventions (transparency, phase T3);
- incidents.

## Contract

A domain module never sends anything itself. It records a **notification intent**: a typed fact, in the same transaction as the change it reports. A dispatcher hands it to a **channel adapter**.

```
NotificationIntent {
  id, organizationId, tenantId
  kind            closed list: INVITATION_ISSUED, RECOVERY_CODE_USED, PASSKEY_REPLACED_AFTER_RECOVERY,
                  ADMINISTRATOR_GRANTED, ACCOUNT_DISABLED, OPERATOR_INTERVENTION, INCIDENT_NOTICE
  audience        a subject, or a role in the organization (for example its administrators); never a free address
  facts           the minimum structured data the message needs; no secret, token or link body
  causeChangeId   the journal event it reports (one fact, one proof)
  createdAt       database time (LUXIA time convention)
  priority        SECURITY or ROUTINE
}

ChannelAdapter {
  channel         EMAIL, SMS, WEBHOOK, IN_APP, ...
  deliver(intent, recipient) → { status: SENT | REJECTED | RETRY, providerRef?, reason? }
}

Delivery {
  intentId, channel, recipient (resolved, stored as needed), status, attempts, lastAttemptAt, providerRef
}
```

## Rules

- **Facts, not prose.** The adapter renders the message from the kind and the facts, in the recipient's language.
- **No secret in a notification**, ever. An invitation token is shown once to the issuer, as it is today, or delivered by a dedicated single-use channel with its own design.
- **Recipients are resolved on the server** from subjects and roles, never from input.
- **At least once, idempotent:** retries never send a second message for the same intent and channel.
- **Audited:** each intent points to its journal event; each delivery attempt is recorded. Delivery is not proof of reading.
- **Provider-neutral:** an e-mail provider is one adapter among others (a European provider first, in line with the residency decision). It can be replaced without touching Identity.
- **Degraded mode:** if a channel is down, the intent stays pending and visible to administrators in the product (IN_APP). Africa-ready: SMS and in-app matter as much as e-mail.

## Place in the LUXIA suite

- Intents belong to the domain that causes them (Identity).
- Dispatch is a platform component.
- Adapters are LUXIA Adapters.
- ALMA may later propose a notification, but sends nothing without a policy.
