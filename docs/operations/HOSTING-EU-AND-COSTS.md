# EU hosting, commercial tiers and costs

Status: **DESIGNED** (2026-10-13). Operator decisions of 2026-10-13:
- Production moves to the EU, Frankfurt by default, before a commercial beta, as a rehearsed platform operation;
- the smallest serious commercial tier that meets an explicit requirement;
- costs documented.

All figures exclude VAT. Prices come from the providers' pages on 2026-10-13. **Usage estimates are ASSUMPTIONS** to be replaced by measured usage once observability exists.

## 1. Why a change of tier is required, not optional

| Requirement | Today | Evidence |
|---|---|---|
| Commercial use allowed | **No.** Vercel Hobby is « for personal, non-commercial use » | Vercel pricing page (VERIFIED) |
| Point-in-time history of at least 7 days (`BACKUP-RESTORE-PLAN.md`) | 6 hours (Neon Free) | Neon project settings (VERIFIED) |
| Room for rehearsal branches | 10/10 used | Neon (VERIFIED) |
| EU region | US East (Neon `aws-us-east-1`, Vercel `iad1`) | VERIFIED |

## 2. Smallest serious tier per component

| Component | Tier | Price basis (official) | Resolves |
|---|---|---|---|
| Neon (Frankfurt, `aws-eu-central-1`) | **Launch** | No minimum; $0.106 per CU-hour; $0.35 per GB-month; history up to 7 days; 10 branches per project, $1.50 per extra branch-month | 7-day history, extra branches when needed, EU region |
| Vercel (functions in `fra1`) | **Pro**, 1 seat | $20 per month, including a $20 usage credit and 1 TB of transfer | Commercial use allowed, more limits |
| Backups | Scaleway Object Storage, Paris Multi-AZ | €0.01606/GB-month, 75 GB of egress free each month | Independent backups (`INDEPENDENT-BACKUP-ARCHITECTURE.md`) |
| Observability | To be chosen, free tiers first | | E4 |

**Neon Scale** costs $0.222 per CU-hour and adds 30-day history, 25 branches, an uptime SLA and SOC 2. It is **not** needed now. It becomes the requirement when a customer contract asks for an SLA or a SOC 2 report from our database provider, or for more than 7 days of history.

**Operator decision, 2026-10-18:** the Private Beta uses **Neon Scale** in Frankfurt (uptime SLA and security features) with **Vercel Pro**, within a planning envelope of at most €120 per month for infrastructure and monitoring. The move follows [EU-MIGRATION-RUNBOOK.md](EU-MIGRATION-RUNBOOK.md).

A region cannot be changed on an existing Neon project, so the move means a new project and a data migration (Neon documentation).

## 3. Monthly cost estimates (ASSUMPTIONS)

| Size | Neon Launch | Vercel Pro | Backups | Total (about) |
|---|---|---|---|---|
| **Minimum / beta (≤ 10 organizations)**: 0.25 CU about 8 h a day with scale-to-zero (about 60 CU-h), under 1 GB | about $7 | $20 (usage within the credit) | < €1 | **about $30** |
| **100 organizations**: 0.5 CU always on (365 CU-h), about 2 GB | about $40 | $20 to $40 | < €1 | **about $60 to $80** |
| **1,000 organizations**: 1 to 2 CU always on (730 to 1,460 CU-h), about 20 GB | $85 to $165 (Launch), $170 to $330 (Scale) | $50 to $150 | about €1 to €2 | **about $150 to $500** |

**Thresholds to watch:**
- compute is the main cost; always-on starts when cold starts hurt sign-in latency (observability will tell);
- Vercel usage above the $20 credit;
- Neon Scale when a contract requires it;
- extra Neon branches at $1.50 each per month.

## 4. EU migration plan (operator's sequence)

1. **Inventory:** schema, roles and rights, extensions, functions, secrets, Vercel environment variables, DNS, the OAuth redirect URIs of Microsoft Entra, the WebAuthn relying party (the passkey domain must not change).
2. **New EU target:** a Neon project in `aws-eu-central-1` (Launch), Vercel functions in `fra1`, the same domain.
3. **Copy and restore:** from the independent backup, which also proves the backup (Drill B).
4. **Migrations:** `prisma migrate status` on the target is identical to the source (25 migrations), and the roles and rights are rebuilt exactly.
5. **Integrity:** business digest identical; Legrand Tech's rows identical row by row.
6. **Application tests** on the target, outside Production: smoke tests, sign-in with a test identity, IAM, journal.
7. **Downtime measurement:** a rehearsal with a timed write freeze.
8. **Rollback plan:** the US project stays untouched and ready, with the old connection string kept. Switching back is a configuration change.
9. **Switch:** freeze writes, take the final copy, check the digest, change the Vercel variables, deploy, run the checks, lift the freeze.

**Things that must not change:**
- the passkey relying party ID (domain): otherwise every passkey is lost;
- the session cookies' domain;
- the Entra redirect URIs.

**Data residency as a property, later:** every query already carries its organization and tenant. A future per-tenant or per-deployment region is a routing decision on top of that, not a rewrite. No component may assume a single region.

## 5. Spending decision (operator)

| Item | Monthly | Needed for |
|---|---|---|
| Vercel Pro (1 seat) | $20 | Any commercial use, the EU functions region |
| Neon Launch (new EU project; the US project can go back to Free after the move) | about $7 at beta size | EU region, 7-day history, branches |
| Scaleway Object Storage | < €1 | Independent backups |
| **Total at beta size** | **about $30** | |

## Sources

- [Neon pricing](https://neon.com/pricing)
- [Neon regions](https://neon.com/docs/introduction/regions)
- [Vercel pricing](https://vercel.com/pricing)
- [Scaleway Object Storage pricing](https://www.scaleway.com/en/pricing/storage/)
