# Minimum application monitoring: design (Private Beta criteria G6 and G7)

| Item | State |
|---|---|
| Status | **DESIGNED**, 2026-10-18. Class C document. Implementation slices are class A (section 6) |
| Operator decision | **Option A (managed)** chosen on 2026-10-18 (section 5). Planning envelope for Beta infrastructure and monitoring together: **at most €120 per month**; a higher amount needs a new GO. No account, monitor, secret or payment until the execution gate |
| Requirement | Standard section 17b (proposed in #90): G6 minimum application monitoring active; G7 human alert path tested end to end |
| Related | [Service-level register](../engineering/SERVICE-LEVEL-REGISTER.md) (SLI-01, SLI-03, SLI-05), E4 backup freshness, `docs/product/ENTERPRISE-READINESS.md` E4 |

## 1. What G6 asks, and what exists today

| Signal | Today | Gap |
|---|---|---|
| Availability of the sign-in page and of the API, checked from outside the hosting platform | None | LUXIA would learn of an outage from a customer |
| Database readiness | None for the application (backups would fail later) | No alert |
| Server errors (5xx) and **session resolution availability (SLI-03)** | None; platform logs only, read by hand | No measure, no alert |
| Sign-in success (SLI-01) | Sign-in evidence is recorded, never measured | No measure, no alert |
| Backup freshness (SLI-05) | **Exists** (E4: Azure alert after 3 hours, tested end to end on 2026-10-13) | A second watcher outside Azure |

SLI-01, SLI-03 and SLI-05 are **measured from the start**. Their SLOs stay PROPOSED and become binding only after 30 days of measurement (standard, section 15).

## 2. Principles

- **Watch from outside.** Probes run outside the hosting platform. Alerts reach the operator through channels outside the monitored platform, and not only through Azure, which already carries the backup trigger and its alert.
- **Replaceable vendors.** Plain HTTP checks, heartbeat URLs, and the Sentry event protocol, which several hosted and self-hosted backends accept. Changing vendor changes a URL or a DSN, not the application.
- **No personal data in telemetry (I5, E15).** No IP address, user agent, e-mail, token, cookie, query string or request body leaves the application. Public answers carry no data.
- **No public path to the database.** Public liveness never touches PostgreSQL. Database readiness is protected, cached and generic, so it cannot become an oracle or a way to load the database.
- **Built for low volume.** With a few sign-ins a day, a ratio is noise. Alerts fire on system failures; ratios are measured for the SLOs that come after 30 days.
- **Fail visible.** A probe that cannot reach the application alerts. A watcher that stops receiving its heartbeat alerts.

## 3. Design

| # | Signal | Mechanism | Alert | Severity |
|---|---|---|---|---|
| M-A | **Liveness** (public) | `GET /api/health`: constant answer 200 `{"status":"ok"}` from the application runtime. **No database access, no version, no detail.** An external probe calls it, and `GET /login` (expects 200), every 3 minutes or less | 2 consecutive failures | S2 |
| M-B | **Database readiness** (protected) | `GET /api/internal/readiness` with a dedicated monitoring token in a header; any other caller gets the same 404 as an unknown path. It runs `SELECT 1` as `app_user` with a 2 s timeout. The result is cached 15 s and computed once at a time (concurrent calls share it), so the database sees at most one check per 15 s whatever the call rate. Answer: 200 `{"ready":true}` or 503 `{"ready":false}`, nothing else | 2 consecutive failures | S2 |
| M-C | Server errors and **SLI-03** | Error-tracking SDK on server code (Sentry protocol, EU data region). `sendDefaultPii` off; a `beforeSend` filter removes headers, cookies, query strings, bodies and user fields. Errors raised in **session resolution** carry the tag `component=session`. **SLI-03** = 1 − (session-resolution 5xx ÷ authenticated requests). The numerator comes from the tagged errors; the denominator from the hosting platform's request logs, or from sampled transactions of the error tracker | A new issue; more than 5 errors in 5 minutes; **any burst of `component=session` errors** (3 in 5 minutes) | S3 / S2 |
| M-D | Sign-in success (SLI-01) | A token-protected internal endpoint returns **aggregates only** for the last 15 minutes and 24 hours: attempts, successes, and failures with a **system** reason (database, provider, internal), per method. No identity and no organization is returned. The probe asserts zero system failures over 15 minutes | Any system failure | S2 |
| M-E | Backup freshness (SLI-05), second watcher | Each verified backup run pings a heartbeat URL outside Azure | No ping for 3 hours | S2 |
| M-F | The watchers themselves | A monthly synthetic drill of every alert (section 4), which also keeps the G7 evidence current | Missed drill | S3 |

**Trust boundaries touched (for the threat models of the slices):**
- M-A adds a public endpoint that does no I/O.
- M-B and M-D add token-protected endpoints. The token is dedicated to monitoring, held by the monitoring vendor, accepted only by these two endpoints, and rotatable. A wrong token is indistinguishable from an unknown path.
- M-D needs counts across organizations, while sign-in evidence is protected by row-level security per organization. The proposal is a SQL function that returns only aggregates, executable by the runtime role. Its design is reviewed as class A.
- M-C sends data to a third party. The scrub filter is tested to show that the fields above never leave.

## 4. Alert path and its end-to-end test (G7)

- **Channels:** e-mail to both operator addresses, plus a mobile push or SMS for S1 and S2. All of them sit outside the hosting platform, outside Azure and outside GitHub.
- **Severities** follow the standard, section 16. Its response targets are **not guaranteed** while there is one operator and no on-call. The pilot terms must not promise them.
- **End-to-end test, per signal:**
  - M-A and M-B: a drill monitor that expects a string the answer never contains;
  - M-C: the vendor's test event, and a test error tagged `component=session` raised outside Production;
  - M-D: a drill threshold;
  - M-E: a drill heartbeat with a short period.

  For each, the time fired, received and acknowledged is recorded as sealed evidence. The test is repeated monthly and **after any change of platform or region**. The final G7 run therefore happens after the EU move (criterion G4 has the same rule).

## 5. Options

Prices as published on 2026-10-18, to check again at the execution gate.

| Option | Probes, heartbeats and alerting | Errors | Estimated monthly cost | Assessment |
|---|---|---|---|---|
| **A, managed (chosen)** | Better Stack, one paid seat ($29 billed yearly or $34 monthly; adds SMS, phone call and push alerts). Its free plan is described as "for personal projects" | Sentry Developer, free (1 user, 5k errors, e-mail alerts, data residency available); Team at $26–29 if needed | **About $30–35**, plus $26–29 if Sentry Team is needed | One vendor for probes, heartbeats and alerts, outside Vercel, Azure and GitHub. Least to operate for one operator |
| B, self-hosted | Uptime Kuma on a small EU virtual machine, plus a hosted heartbeat check (Healthchecks.io Business at $16–20) | GlitchTip or Bugsink (Sentry protocol) | About €10–30 | Cheaper, more sovereign. But it adds a server to patch and watch, for one operator. Revisit once there is a second operator |
| C, Azure | Application Insights availability tests and the existing action group | Application Insights | Usage-based | Reuses a tested alert path. But it adds common mode with the backup chain, and Azure work is paused |

**Secondary probe (recommended addition, no cost):** UptimeRobot's terms allow any use, including commercial and business use, on every plan (terms section 3; Fair Use Policy added on 2026-05-26). A free UptimeRobot check of M-A, run by a second vendor, gives **independent equivalent telemetry** for availability. That is what the standard, section 17 point 6, accepts to cover an interval when the primary probe is down. An earlier draft of this document excluded UptimeRobot on the basis of secondary sources; that was wrong.

## 6. Implementation slices (option A)

| Slice | Content | Class | Platform-dependent |
|---|---|---|---|
| 1 | Public liveness `/api/health` (no I/O) and protected readiness `/api/internal/readiness` (token, cache, single flight, generic answers), with tests: no data; no database call from liveness; one database check per 15 s under concurrent calls; wrong token answered like an unknown path | A | No |
| 2 | Error-tracking SDK with the scrub filter and the `component=session` tag, with a test proving no personal field leaves, and the SLI-03 computation | A | No |
| 3 | SLI-01 aggregate function, internal endpoint, and tests (aggregates only, row-level security unchanged) | A | No |
| 4 | Heartbeat ping from the backup workflow (the heartbeat URL as an environment secret) | A | No |
| 5 | Monitors, alert channels, the secondary probe, the G7 drill and sealed evidence | Operator execution gate (spend, secrets) | **Yes**: redo after the EU move |

Slices 1 to 4 can be reviewed and merged before the hosting move. Slice 5 waits for the final platform.

## 7. Out of scope

Latency (SLI-02), the SLI-04 ratio (computed later from error and log data), a status page, an on-call rotation, OPERATIONALLY PROVEN.

## Sources (consulted 2026-10-18)

- Better Stack pricing: https://betterstack.com/pricing
- Better Stack check frequency: https://betterstack.com/docs/uptime/check-frequency.md
- Sentry pricing: https://sentry.io/pricing/; Sentry EU data residency FAQ: https://intercom.help/sentryio/en/articles/13964378
- Healthchecks.io pricing: https://healthchecks.io/pricing/
- UptimeRobot terms of service: https://uptimerobot.com/terms/
