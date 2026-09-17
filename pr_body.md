Introduces the canonical LUXIA identity domain without removing the legacy User model.

Adds:
- Organization
- Tenant
- ProviderConnection
- Subject
- IdentityAccount
- Resource
- LegacyUserBridge

Adds database-enforced cross-organization isolation through composite foreign keys and prepares production-safe legacy migration.

### Security Points
- Cross-tenant relationships rejected at PostgreSQL level
- Provider-independent identity model
- Explicit Restrict delete behavior
- Tenant-aware Prisma access layer
- Raw Prisma import restrictions
- Idempotent migration bridge
- No destructive migration of legacy User data

### Non-goals
- No production backfill yet
- No User removal
- No dashboard cutover
- No BFF authentication
- No RLS enforcement yet
- No Entitlement/Assignment model yet
- No Policy Engine
- No AI Agent runtime behavior
