# Live Provider Certification — Providers Management v1

Date: 2026-10-03. Status: NOT CERTIFIED. PR #12 remains draft; no Production mutation or merge.

## Observed prerequisites

- No local `DATABASE_URL`, certification credentials, `LUXIA_PROVIDER_*`, or `LUXIA_OIDC_ALLOWED_ISSUERS` were present. Only `.env.example` exists.
- GitHub environments returned `Preview`, `Production`, `staging`; no dedicated provider certification environment was present.
- Existing Production Entra App Registration identifiers are not evidence of dedicated certification credentials or Graph consent and were not reused.
- No dedicated Google Workspace customer, credential or consent evidence was available.
- No issuer was explicitly approved for a real OIDC metadata call. No issuer was selected by assumption.

These prerequisites prevent live Graph/Directory calls and approval of the live gate. Automated fixtures are not live evidence. No credentials were extracted from Production.

## Corrective implementation

- UI describes enablement as management operations enabled/disabled and states that existing authentication is unaffected.
- OIDC transport rejects private/local IP literals even if allowlisted, checks public IPv4 DNS answers, pins the resolved address, verifies TLS against the original host, rejects redirects, bounds response size and duration.
- Configured issuer must equal the provider connection external scope; returned metadata issuer must match exactly.
- Generic OIDC still refuses directory enumeration.
- IPv6-only OIDC issuers fail closed pending a reviewed IPv6 policy.

## Evidence classification

Automated HTTP and SSRF tests verify safe errors, mapping and URL boundaries. CI's isolated PostgreSQL tests certify runtime `app_user`, RLS, tenant denials before external operations, replay semantics, collision quarantine/rejection, canonical audit and zero canonical identity writes. These results do not prove real customer connectivity or consent.

Pending live cases: valid/invalid Entra secret; Graph consent present/insufficient; valid/revoked Google credential; real pagination and bounded discovery; customer Directory access; explicit approved public OIDC metadata retrieval; logs and audit of those actual calls. Deterministic collisions remain a controlled fixture case unless the certification provider can supply a repeated external identifier; ordinary live directories cannot be assumed to emit duplicate immutable IDs.

## Required dedicated inputs

Provide through a dedicated certification runtime/secret store, never in chat or Git:

1. Isolated certification database runtime URL (`app_user`, NOBYPASSRLS) and migration URL for that database, with explicit project/branch identity.
2. Entra certification Directory ID, App Registration Client ID, its secret, and Graph read-consent evidence. Separate insufficient-consent app for the negative case; never revoke Production consent.
3. Google certification customer ID, Directory API read credential, and consent. Separate revocable certification credential for the negative case.
4. Exact approved public HTTPS OIDC issuer in `LUXIA_OIDC_ALLOWED_ISSUERS`.

Create Organization/Tenant/ProviderConnection only in the dedicated database; use the connection-derived `LUXIA_PROVIDER_<scope hash>` reference for each provider. Record before/after Subject, IdentityAccount and legacy table inventories around every dry-run. Exercise wrong-tenant requests and replay IDs against those scopes. Preserve canonical audit and safe error evidence; scan captured HTTP/log/audit output in memory against the secret values without printing them.

PR may become Ready for Review only after both automated CI and all applicable live gates have explicit evidence. Final Production merge remains subject to the user's final review.
