# EU migration runbook: Production from US East to Frankfurt (repeatable, within a €40 monthly cap)

| Item | State |
|---|---|
| Status | **DESIGNED**, 2026-10-18. Class C document. It extends the nine-step sequence of [HOSTING-EU-AND-COSTS.md](HOSTING-EU-AND-COSTS.md), section 4 |
| Operator decisions (2026-10-18) | **Budget cap: €40 per month for everything, and €0 until the operator gives the signal.** This supersedes the earlier €120 envelope and the Neon Scale target. **Database:** a new **Neon Free** project in AWS Frankfurt (`aws-eu-central-1`): €0, no credit card. **Hosting:** stays on Vercel, so the domain and every passkey stay. **Functions move to `fra1` (Frankfurt) on the Hobby plan, at €0:** Hobby allows one function region of the project's choice (Vercel documentation, VERIFIED 2026-10-18). **Vercel Pro** (about €18.5 per month) is activated at the operator's signal **before the first pilot**, only because Hobby forbids commercial use; it changes neither the region nor the domain |
| Nothing is created by this document | Every resource, secret, payment and Production change below happens only at its own gate (section 3) |
| Private Beta criteria served | G4 (recovery and switch rehearsed on the final platform), G8 (hosting terms that allow the pilots, EU region); G6 and G7 are proven after the move |

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

## 1b. Hosting under the budget cap

| Phase | Hosting | Allowed? | Cost |
|---|---|---|---|
| Now, until the first pilot (development, rehearsals, the operator's own organization) | Vercel Hobby, **functions in `fra1`** after the switch | Yes: no commercial use yet | €0 |
| **From the first pilot** | **Vercel Pro**: same project, same region, same domain | Yes | About €18.5 per month, at the operator's signal |
| Fallback if Pro is refused when the pilots start | Azure Container Apps, consumption plan (monthly free grant; Germany West Central) | Yes | €0 within the grant; no hard cap, so a €1 budget alert and at most 1 replica |

**Consequence: the whole move happens now, at €0, before the pilots.** G4, G6 and G7 are then proven on the final platform. The later switch from Hobby to Pro changes only the plan and its terms, not the platform, the region or the domain. So it does not void those proofs.

**Why Vercel Pro over the free fallback, from the first pilot.** Staying on Vercel keeps `iam-azure-pme.vercel.app`, so every passkey survives (passkeys are bound to the domain). It needs no new deployment pipeline, and no new class A work. The fallback changes the domain: every user would sign in with a recovery code or Microsoft Entra and enrol again. It also needs a container build and a deploy workflow (class A). The fallback is documented here, not built.

**Domain, later.** A domain owned by LUXIA (about €10 a year) would make passkeys independent of any host. It is the first item to buy under the cap, at the operator's signal. It must happen **before** the pilots: changing the domain later forces every pilot user to enrol again.

## 2. Cost (prices of 2026-10-18)

| Item | Now | From the first pilot |
|---|---|---|
| Neon Free, Frankfurt | €0 (limits: 100 compute-hours, 1 GB, 6-hour history; the database suspends until the next month if the compute-hours run out) | €0 |
| Vercel | €0 (Hobby) | About €18.5 (Pro) |
| Monitoring, option Z ([design](MINIMUM-APPLICATION-MONITORING-DESIGN.md)) | €0 | €0 |
| Independent backups and their alerts (Azure, existing) | About €0.17 (measured: €0.10 month to date on 2026-10-18) | About €0.17 |
| Domain (optional, recommended) | — | About €1 per month equivalent |
| **Total** | **About €0.17** | **About €20, under the €40 cap** |

**Compute-hours:** the hourly backup and the hourly database probes share one wake-up (5 minutes idle before suspension), well within 100 hours. Usage is watched read-only, with an alert at 70 %. Scale-to-zero cannot be disabled on Free: the first sign-in after an idle period waits for the database to wake (measured in EU-2).

## 3. Gates

Each gate follows the [Production gate template](../engineering/templates/PRODUCTION-GATE-TEMPLATE.md): a tool tested first, sealed evidence, the operator's explicit GO.

| Gate | What happens | Reversible | Needs |
|---|---|---|---|
| **EU-0** Plan approval | This runbook and its tools reviewed | Yes | Operator; tools reviewed (class A where they touch Production) |
| **EU-1** Target project | A Neon Free project in Frankfurt. No payment | Yes (delete the empty project) | None beyond this runbook |
| **EU-2** Target and rehearsal | A new Neon project in Frankfurt; roles created (`app_user`, `luxia_backup`); the latest independent backup restored into it; checks EU-I2 to EU-I4; the application tested against a **synthetic** restored database (previews are public: no Production data ever reaches one). Timed, to measure the downtime the switch will need | Yes (delete the target) | Operator GO; new role passwords (secrets) |
| **EU-3** Code | `vercel.json` sets the functions region to `fra1` (class A: Production configuration); reviewed and merged, deployed only at the switch (EU-4). Works on Hobby | Yes | Independent review |
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
- **G4:** restore that backup into a fresh, empty Frankfurt branch and prove it with the restore tools (inventory identical, behaviour checks), **never through a preview**. Then repeat the application switch on a **synthetic** restored database, as in G4 run B (section 6b). Together they prove the restore and the application switch on the final platform (standard, section 17b), without any Production data on a public preview.
- **G6 and G7:** the monitoring slice 5 is set up on the final platform, and every alert is tested end to end.
- Update the readiness documents with the new region and plan.

## 6. Rollback

| Moment | Rollback | Data cost |
|---|---|---|
| Before step 4 of the switch | `GRANT CONNECT` on the source; nothing else changed | None |
| After the switch, **before any write on the target** | Restore the recorded Vercel and GitHub configuration, redeploy the previous deployment, `GRANT CONNECT` on the source | None |
| After writes on the target | Freeze the target, copy it back to the source with the same tool, then as above | None if the copy-back is done; it is rehearsed in EU-2 |

The rollback window is **14 days**. The US project is untouched and unwritten during it, and the decommission (EU-6) waits for its end.

## 6b. Rehearsal results

### EU-2, 2026-10-18 15:05Z: PASS

The real backup and restore tools were used. Production was only read.

| Step | Result |
|---|---|
| Target | A Neon Free branch in Frankfurt, created with an expiry of 24 hours, **read back before any copy** |
| Key | An ephemeral age key pair for the run, deleted at the end. The operator's backup key was not used |
| Backup of Production (read-only snapshot, `backup.mjs`) | 48.1 s |
| Restore into Frankfurt (`restore.mjs`; the clear dump exists only in memory) | 39.3 s; **identical to the backup's own inventory: 52 tables, 1,609 rows** |
| Behaviour checks (`verify-restored.mjs`) | **6 of 6 pass**: runtime role without BYPASSRLS; 35 tenant tables, 3 scopes; no scope means no row; each organization sees exactly its own rows (105 table×scope pairs, 1,036 rows); journal and sign-in evidence append-only (owner refused too) |
| Migrations | 28 found, schema up to date |
| One query, workstation to Frankfurt | 35 ms (indicative only) |
| Cleanup | Runtime role back to no login; ephemeral key and encrypted dump deleted; the branch expires by itself |

**What it tells the switch (EU-4):** the final copy (backup, restore, checks) takes about **105 s**. The write freeze therefore lasts a few minutes, plus the smoke tests and sign-ins of section 4, step 5.

### G4 application switch, 2026-10-18: PASS (synthetic data)

**Previews are treated as public and untrusted.** No Production data, secret or copy ever reaches a preview. The switch was therefore rehearsed on **synthetic** databases in Frankfurt, through the preview of EU-3 (#104), redeployed with functions in `fra1` (verified on the deployment).

| Run | Database behind the preview | Result |
|---|---|---|
| A | A blank Frankfurt branch, migrated like CI (28 migrations) with the runtime role and its Production grants | **9 of 9 pass** |
| B | **A restore:** run A's database backed up and restored into a blank Frankfurt branch with the real tools and an ephemeral key (identical to its inventory, 50 s), then the preview switched to it | **9 of 9 pass**; the organization created in run A is present |

The 9 checks:
- the public page answers;
- the protected API refuses without a session;
- sign-up starts: the code is reserved in Frankfurt;
- sign-up completes: organization, founder and passkey in one transaction;
- sign-in starts;
- sign-in completes with the passkey: a session and its sign-in evidence;
- an authenticated read works;
- the session is visible to its owner;
- an unknown organization gets the same generic answer.

Each request took 120 to 670 ms, measured from the operator's workstation.

**Cleanup:** the branch-scoped preview variables were removed (0 left), the runtime role lost its login, and the synthetic branches expire by themselves.

**G4 status:** the restore (EU-2, real data) and the application switch (synthetic, to a restored database) are now rehearsed on the target platform. Both are **repeated after the Production switch (EU-4)**, because a change of region voids them (standard, section 17b).

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

- [Neon pricing](https://neon.com/pricing) (Free plan limits, consulted 2026-10-18)
- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) (monthly free grant, fallback only)
- [Neon regions](https://neon.com/docs/introduction/regions)
- [Vercel pricing](https://vercel.com/pricing)
- [Vercel Functions regions](https://vercel.com/docs/functions/configuring-functions/region) (Hobby: a single region of choice)
