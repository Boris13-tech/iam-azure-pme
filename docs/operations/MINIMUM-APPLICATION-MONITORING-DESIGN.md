# Minimum application monitoring: design (Private Beta criteria G6 and G7)

| Item | State |
|---|---|
| Status | **DESIGNED (proposal)**, 2026-10-18. Class C document. Implementation slices are class A (section 6) |
| Requirement | Standard section 17b (proposed in #90): G6 minimum application monitoring active; G7 human alert path tested end to end |
| Related | [Service-level register](../engineering/SERVICE-LEVEL-REGISTER.md) (SLI-01, SLI-05), E4 backup freshness, `docs/product/ENTERPRISE-READINESS.md` E4 |
| Decisions needed | The option and its monthly cost (section 5). No account, monitor or secret is created by this document |

## 1. What G6 asks, and what exists today

| Signal (G6) | Today | Gap |
|---|---|---|
| Availability of the sign-in page and of the API, checked from outside the hosting platform | None | LUXIA would learn of an outage from a customer |
| Server errors (5xx) | None; platform logs only, read by hand | No alert |
| Database availability | None for the application (backups would fail later) | No alert |
| Sign-in success (SLI-01) | Sign-in evidence is recorded, never measured | No measure, no alert |
| Backup freshness (SLI-05) | **Exists** (E4: Azure alert after 3 hours, tested end to end on 2026-10-13) | A second watcher outside Azure |

## 2. Principles

- **Watch from outside.** Probes run outside the hosting platform. Alerts reach the operator through channels outside the monitored platform, and not only through Azure, which already carries the backup trigger and its alert.
- **Replaceable vendors.** Plain HTTP checks, heartbeat URLs, and the Sentry event protocol, which several hosted and self-hosted backends accept. Changing vendor changes a URL or a DSN, not the application.
- **No personal data in telemetry (I5, E15).** No IP address, user agent, e-mail, token, cookie, query string or request body leaves the application. Health answers carry no data.
- **Built for low volume.** With a few sign-ins a day, a success ratio is noise. Alerts fire on system failures; ratios are measured for the SLOs that come after 30 days.
- **Fail visible.** A probe that cannot reach the application alerts. A watcher that stops receiving its heartbeat alerts.

## 3. Design

| # | Signal | Mechanism | Alert | Severity |
|---|---|---|---|---|
| M-A | Availability | External HTTP probe every 3 minutes or less: `GET /login` expects 200; `GET /api/health` expects 200 with `{"status":"ok"}` | 2 consecutive failures | S2 |
| M-B | Database | `/api/health` runs `SELECT 1` as `app_user` with a 2 s timeout. Answer: 200 `{"status":"ok"}` or 503 `{"status":"unavailable"}`. No version, no detail. The result is cached 15 s, so the probe cannot be used to load the database | Same probe | S2 |
| M-C | Server errors | Error-tracking SDK on server code (Sentry protocol, EU data region). `sendDefaultPii` off; a `beforeSend` filter removes headers, cookies, query strings, bodies and user fields; errors only, no tracing at first | A new issue; more than 5 errors in 5 minutes | S3 / S2 |
| M-D | Sign-in success (SLI-01) | A token-protected internal endpoint returns **aggregates only** for the last 15 minutes and 24 hours: attempts, successes, and failures with a **system** reason (database, provider, internal), per method. No identity and no organization is returned. The probe asserts zero system failures over 15 minutes | Any system failure | S2 |
| M-E | Backup freshness, second watcher | Each verified backup run pings a heartbeat URL outside Azure | No ping for 3 hours | S2 |
| M-F | The watchers themselves | A monthly synthetic drill of every alert (section 4), which also keeps the G7 evidence current | Missed drill | S3 |

**Trust boundaries touched (for the threat models of the slices):**
- M-B adds a public, unauthenticated endpoint that reaches the database: rate limiting and the cache answer the load question.
- M-D needs counts across organizations, while sign-in evidence is protected by row-level security per organization. The proposal is a SQL function that returns only aggregates, executable by the runtime role. Its design is reviewed as class A. The endpoint's token is a dedicated secret held by the monitoring vendor, and is rotatable.
- M-C sends data to a third party: the scrub filter is tested to show that the fields above never leave.

## 4. Alert path and its end-to-end test (G7)

- **Channels:** e-mail to both operator addresses, plus a mobile push or SMS for S1 and S2. All of them sit outside the hosting platform, outside Azure and outside GitHub.
- **Severities** follow the standard, section 16. Its response targets are **not guaranteed** while there is one operator and no on-call. The pilot terms must not promise them.
- **End-to-end test, per signal:**
  - M-A and M-B: a drill monitor that expects a string the page never contains;
  - M-C: the vendor's test event;
  - M-D: a drill threshold;
  - M-E: a drill heartbeat with a short period.
  
  For each, the time fired, received and acknowledged is recorded as sealed evidence. The test is repeated monthly and **after any change of platform or region**. The final G7 run therefore happens after the EU move (criterion G4 has the same rule).

## 5. Options (operator decision)

Prices as published on 2026-10-18, to check again at decision time.

| Option | Probes, heartbeats and alerting | Errors | Estimated monthly cost | Assessment |
|---|---|---|---|---|
| **A, managed (recommended)** | Better Stack, one paid seat (about $29 yearly or $34 monthly; adds SMS, phone call and push alerts). Its free plan is described as "for personal projects" | Sentry Developer, free (1 user, 5k errors, e-mail alerts, data residency available); Team at $26–29 if needed | **About $30–35**, plus $26–29 if Sentry Team is needed | One vendor for probes, heartbeats and alerts, outside Vercel, Azure and GitHub. Least to operate for one operator |
| B, self-hosted | Uptime Kuma on a small EU virtual machine, plus a hosted heartbeat check (Healthchecks.io Business at $16–20) | GlitchTip or Bugsink (Sentry protocol) | About €10–30 | Cheaper, more sovereign. But it adds a server to patch and watch, for one operator. Revisit once there is a second operator |
| C, Azure | Application Insights availability tests and the existing action group | Application Insights | Usage-based | Reuses a tested alert path. But it adds common mode with the backup chain, and the operator has paused Azure work |

**Excluded:** UptimeRobot's free plan. Several sources report that since late 2024 its terms forbid commercial use; verify before reconsidering.

## 6. Implementation slices (after the option is chosen)

| Slice | Content | Class | Platform-dependent |
|---|---|---|---|
| 1 | `/api/health` with cache and rate limit, and tests (no data, timeout, 503) | A | No |
| 2 | Error-tracking SDK with the scrub filter, and a test proving no personal field leaves | A | No |
| 3 | SLI-01 aggregate function, internal endpoint, and tests (aggregates only, row-level security unchanged) | A | No |
| 4 | Heartbeat ping from the backup workflow (the heartbeat URL as an environment secret) | A | No |
| 5 | Monitors, alert channels, G7 drill and sealed evidence | Operator gate (spend, secrets) | **Yes**: redo after the EU move |

Slices 1 to 4 can be reviewed and merged before the hosting decision. Slice 5 waits for the final platform.

## 7. Out of scope

Latency (SLI-02), the SLI-03 and SLI-04 ratios (computed later from error and log data), a status page, an on-call rotation, OPERATIONALLY PROVEN.

## Sources (consulted 2026-10-18)

- Better Stack pricing: https://betterstack.com/pricing
- Better Stack check frequency: https://betterstack.com/docs/uptime/check-frequency.md
- Sentry pricing: https://sentry.io/pricing/; Sentry EU data residency FAQ: https://intercom.help/sentryio/en/articles/13964378
- Healthchecks.io pricing: https://healthchecks.io/pricing/
- UptimeRobot free plan terms (secondary): https://dev.to/velprove/uptimerobot-commercial-use-free-alternatives-for-business-sites-in-2026-5d75
