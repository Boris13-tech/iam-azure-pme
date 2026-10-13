# LUXIA Identity: data residency

**DRAFT — LEGAL REVIEW REQUIRED.** Technical first draft (2026-10-13). It describes facts, not a compliance status.

## Today (VERIFIED 2026-10-13)

| Data | Where |
|---|---|
| Production database (all customer data) | United States, US East (Neon on AWS `us-east-1`) |
| Database branches used as rollback points | Same project, same region |
| Application and its server functions | United States, US East (Vercel `iad1`) |
| Independent backups (since 2026-10-13) | **European Union, France Central (Paris)**, Microsoft Azure, three zones. Encrypted before they leave the backup job; only LUXIA holds the key |

The current environment serves development and a small number of known organizations. It is not a commercial offer.

## Target before any commercial beta (operator decision, 2026-10-13)

| Data | Where |
|---|---|
| Production database | European Union, **Frankfurt** (Neon `aws-eu-central-1`), unless a technical or commercial reason says otherwise |
| Application functions | European Union, Frankfurt (Vercel `fra1`) |
| Independent encrypted backups | European Union, Paris: in place (Azure, a provider different from the database's). A second copy under EU company law (Scaleway) is recommended |

The move is a rehearsed platform operation (`docs/operations/HOSTING-EU-AND-COSTS.md`, section 4). The US project stays ready for a rollback until the move is proven.

## What residency does and does not mean

- **Storage location is not the only factor.** Some providers are US companies (Neon, Vercel, AWS), whatever the region of the data. Counsel must assess what that means for each customer's jurisdiction.
- **Data in transit:** a person's browser talks to the application over TLS. When an organization uses Microsoft Entra ID, Microsoft sends sign-in claims to LUXIA from its own infrastructure.
- **Operator access:** the LUXIA operator reaches Production from its workstation, read-only except through approved procedures (`SUBPROCESSORS.md`).

## Later: residency as a property

Every query already carries its organization and tenant. A future residency per deployment or per tenant (EU, Africa, other) is a routing decision on top of that, not a rewrite. No component may assume a single region.

## Gaps to close before publication

- The move to the EU.
- The transfer mechanism while data is in the US.
- Confirmation of where Vercel keeps its logs.
