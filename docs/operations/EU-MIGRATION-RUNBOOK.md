# EU migration runbook: Production from US East to Frankfurt (repeatable)

| Item | State |
|---|---|
| Status | **DESIGNED**, 2026-10-18. Class C document. It extends the nine-step sequence of [HOSTING-EU-AND-COSTS.md](HOSTING-EU-AND-COSTS.md), section 4 |
| Operator decisions (2026-10-18) | Target **Vercel Pro** (functions in `fra1`) and **Neon Scale** in AWS Frankfurt (`aws-eu-central-1`): same cloud provider as today, so fewer variables change at once. Planning envelope for Beta infrastructure and monitoring: **at most €120 per month**; more needs a new GO |
| Nothing is created by this document | Every resource, secret, payment and Production change below happens only at its own gate (section 3) |
| Private Beta criteria served | G4 (recovery and switch rehearsed on the final platform), G8 (commercial tier, EU region); G6 and G7 are proven after the move |

## 1. Invariants of the move

The move changes where LUXIA runs, never what it decides.

| # | Invariant | Check |
|---|---|---|
| EU-I1 | **Same domain.** The passkey relying party ID, the origins stored with each passkey, the session cookie domain and the Microsoft Entra redirect URIs do not change. Otherwise every passkey is lost | The distinct `relyingPartyId` and `allowedOrigin` values of the passkeys equal the host served after the switch; the Entra redirect URI is unchanged |
| EU-I2 | **Identical data.** Business digest and per-organization row digests identical between source and target, table by table | Digest tool of Drill B, before and after |
| EU-I3 | **Identical security posture.** Roles and rights rebuilt exactly: `app_user` NOSUPERUSER and NOBYPASSRLS, forced RLS on every controlled table, function privileges, append-only triggers (T0), activation guards | Read-only inventory diff, source vs target, empty except platform entries |
| EU-I4 | **Same migrations.** The migration history on the target equals the source's | `prisma migrate status` on both |
| EU-I5 | **No lost write.** Writes are frozen from the final copy to the switch | Source digest at freeze = target digest after restore |
| EU-I6 | **Backups never stop.** The backup chain points to the target before the freeze is lifted, and a verified backup of the target exists within 2 hours | Backup inventory; freshness alert stays green |
| EU-I7 | **A way back.** Until the decommission gate, the US project stays intact and the previous Vercel configuration is recorded | Section 6 |

## 2. Cost at Beta size (ASSUMPTIONS, prices of 2026-10-18)

| Item | Basis | Monthly |
|---|---|---|
| Vercel Pro, 1 seat | $20, with a $20 usage credit | $20 |
| Neon Scale, Frankfurt | $0.222 per CU-hour, $0.35 per GB-month, no minimum. 0.25 CU with scale-to-zero (about 60 CU-hours) up to always-on (about 182 CU-hours), under 1 GB | **$14 to $41** |
| Neon US project during the rollback window | Usage only while kept; returned to Free or deleted at decommission (gate) | $0 to a few $ |
| Monitoring, option A ([design](MINIMUM-APPLICATION-MONITORING-DESIGN.md)) | Better Stack seat, Sentry Developer | $29 to $34 |
| Independent backups | Existing | < €1 |
| **Total** | | **about $65 to $95, within €120** |

Scale-to-zero adds a cold start to the first sign-in after an idle period. Always-on removes it for about $27 more per month; decide from the measured sign-in latency (SLI-02) once monitoring exists.

## 3. Gates

Each gate follows the [Production gate template](../engineering/templates/PRODUCTION-GATE-TEMPLATE.md): a tool tested first, sealed evidence, the operator's explicit GO.

| Gate | What happens | Reversible | Needs |
|---|---|---|---|
| **EU-0** Plan approval | This runbook and its tools reviewed | Yes | Operator; tools reviewed (class A where they touch Production) |
| **EU-1** Spend | Vercel Pro and the Neon Scale plan activated | Yes (downgrade) | Operator GO and payment, within the envelope |
| **EU-2** Target and rehearsal | A new Neon project in Frankfurt; roles created (`app_user`, `luxia_backup`); the latest independent backup restored into it; checks EU-I2 to EU-I4; the application tested against it **outside Production** (a preview deployment pointed at the target). Timed, to measure the downtime the switch will need | Yes (delete the target) | Operator GO; new role passwords (secrets) |
| **EU-3** Code | `vercel.json` sets the functions region to `fra1` (class A: Production configuration); reviewed and merged, not yet deployed | Yes | Independent review |
| **EU-4** Switch | Section 4 | Yes, within the window of section 6 | Operator GO; maintenance window announced |
| **EU-5** After-checks and G4 | Section 5 | — | — |
| **EU-6** Decommission US | The US project returned to Free or deleted, after the rollback window | **No** (deletion) | Separate operator GO, never before EU-5 is closed |

## 4. The switch (EU-4)

Measured in the EU-2 rehearsal first. While no pilot is live, the expected impact is the operator's own organization only.

1. **Preflight (read only).** Source and target inventories; migration status equal; the target restored from the latest backup passes EU-I2 to EU-I4; the rollback configuration recorded (section 6).
2. **Freeze writes on the source.** Remove the runtime role's right to connect to the source database (`REVOKE CONNECT`), so that nothing can write; the application answers with an error during the window. Record the time. Rollback of this step: `GRANT CONNECT`.
3. **Final copy.** An independent backup of the frozen source (the same tool as E1), then restored into the target. Source digest at freeze = target digest (EU-I5).
4. **Point the platform at the target.** Vercel and the GitHub `Production` environment get the target's connection strings (runtime pooled as `app_user`, migration direct as owner); the backup environment gets the target's `luxia_backup` URL. Deploy the exact commit already in Production, with the `fra1` region (EU-3).
5. **Checks before reopening.** Smoke tests; a real passkey sign-in and a real Microsoft sign-in by the operator (EU-I1); read-only invariants (forced RLS, `app_user` posture, T0 refusals); a backup run against the target, verified (EU-I6).
6. **Reopen.** The target is now Production. Record the end of the window; the measured downtime goes into the gate record.

## 5. After-checks and the G4 proof (EU-5)

- Within 2 hours: a scheduled backup of the target exists and is verified; freshness alert green.
- **G4:** restore that backup into a fresh, empty Frankfurt branch, and **switch a preview deployment of the application to it**, then run the smoke tests and a sign-in. This proves the database restore and the application switch on the final platform (standard, section 17b).
- **G6 and G7:** the monitoring slice 5 is set up on the final platform, and every alert is tested end to end.
- Update the readiness documents with the new region and plan.

## 6. Rollback

| Moment | Rollback | Data cost |
|---|---|---|
| Before step 4 of the switch | `GRANT CONNECT` on the source; nothing else changed | None |
| After the switch, **before any write on the target** | Restore the recorded Vercel and GitHub configuration, redeploy the previous deployment, `GRANT CONNECT` on the source | None |
| After writes on the target | Freeze the target, copy it back to the source with the same tool, then as above | None if the copy-back is done; it is rehearsed in EU-2 |

The rollback window is **14 days**. The US project is untouched and unwritten during it, and the decommission (EU-6) waits for its end.

## 7. Evidence per gate

Sealed like the earlier Production gates (manifest with SHA-256, read-only copy in the evidence store):
- inventories;
- digests;
- migration status;
- timings, with the measured downtime;
- smoke and sign-in results;
- backup verification;
- the operator's GO for each gate.

No secret, connection string, IP address or user agent appears in the evidence or in public logs.

## Sources

- [Neon pricing](https://neon.com/pricing) (Scale $0.222 per CU-hour, no minimum, consulted 2026-10-18)
- [Neon regions](https://neon.com/docs/introduction/regions)
- [Vercel pricing](https://vercel.com/pricing)
