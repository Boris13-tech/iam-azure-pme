# Operator-only browser evidence transport

The Production bootstrap runner previously required an established raw session token in an operator environment variable. A normal browser session cannot safely be exported through the available control interface; persisted Session IDs are hashes. No cookie extraction, fabricated session or authorization bypass is permitted.

The optional operator CLI transport `--browser-evidence` uses the already-authenticated browser solely to exercise the existing fixed GET capability. It adds no runtime route, browser administration feature, approval boolean or entitlement-based approval path.

All existing immutable manifest, registered release, detached human attestation, exact Production identity/deployment, expiry, SoD, locking, receipt and replay guards execute unchanged before any grant. Stdin carries only a probe UUID, observed HTTP status and canonical evidence UUID, never approval or credentials. The transport does not itself create or authorize an Assignment.

For every step, the runner emits a fresh bounded probe for the fixed route. An independent operator/browser controller invokes that route without reading its cookie and returns its actual result. The runner reads the persisted event through tenant-scoped app_user and requires:

- fresh event after probe start, within a 90-second operator interaction deadline;
- exact Organization, Tenant, actor Subject, resource and action;
- RESOURCE.CAPABILITY.READ and expected SUCCESS/DENIED result/reason;
- exactly the approved Assignment ID for ALLOW, no Assignment IDs for DENY;
- matching probe/status/evidence IDs and no consumed evidence reuse.

An HTTP status claim alone cannot pass. Absent, stale, cross-tenant, mismatched or synthetic evidence fails closed. The DB lookup is subject to RLS; browser input cannot change the actor, resource, scope, action, manifest or grant validity. The server route itself derives identity and binding, and has no client-selected claims.

EOF, timeout, SIGINT and SIGTERM propagate failure into exact-receipt cleanup. Once grant execution is attempted, the existing finally path revokes only that receipt-bound Assignment, including after manifest expiry. Listener/timer cleanup, readline closure and Prisma disconnect prevent lingering operator processes. Forced OS termination cannot guarantee immediate cleanup; the immutable one-hour maximum expiry remains a last bound, never a substitute for verified revocation.

Certification must precede Production use: negative unit contracts, real PostgreSQL/RLS and HTTP clone DENY/ALLOW/DENY, cross-tenant proof invisibility, replay/no-recreation, security suite, TypeScript, build and CI-equivalent. No PASS is inferred from an unverified browser response. No application or business authorization logic is modified.
