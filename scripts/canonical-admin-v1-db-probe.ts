import { PrismaClient } from "@prisma/client";

const ownerUrl = process.env.OWNER_DATABASE_URL;
const runtimeUrl = process.env.DATABASE_URL;

if (!ownerUrl || !runtimeUrl) {
  throw new Error("OWNER_DATABASE_URL and DATABASE_URL are required");
}

const owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
const runtime = new PrismaClient({ datasources: { db: { url: runtimeUrl } } });

async function main() {
  const [role] = await runtime.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT current_user,
           r.rolsuper,
           r.rolbypassrls,
           r.rolcreaterole,
           r.rolcreatedb
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);

  const tables = await owner.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT c.relname AS table_name,
           pg_get_userbyid(c.relowner) AS owner,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('CanonicalAdminAuditEvent', 'ProviderConnectionTenantScope')
    ORDER BY c.relname
  `);

  const privileges = await owner.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT table_name,
           string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
    FROM information_schema.role_table_grants
    WHERE grantee = 'app_user'
      AND table_schema = 'public'
      AND table_name IN (
        'CanonicalAdminAuditEvent', 'ProviderConnectionTenantScope',
        'Subject', 'IdentityAccount', 'Assignment', 'Entitlement',
        'Session', 'ProviderConnection', 'Resource'
      )
    GROUP BY table_name
    ORDER BY table_name
  `);

  const providers = await owner.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT pc."id", pc."organizationId", pc."providerType", pc."externalScopeId",
           count(DISTINCT t."id")::int AS organization_tenant_count,
           count(DISTINCT s."tenantId")::int AS scoped_tenant_count
    FROM "ProviderConnection" pc
    LEFT JOIN "Tenant" t ON t."organizationId" = pc."organizationId"
    LEFT JOIN "ProviderConnectionTenantScope" s
      ON s."organizationId" = pc."organizationId"
     AND s."providerConnectionId" = pc."id"
    GROUP BY pc."id", pc."organizationId", pc."providerType", pc."externalScopeId"
    ORDER BY pc."id"
  `);

  let runtimeAuditRead: string;
  try {
    await runtime.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT set_config('app.organization_id', '4841428a-80b4-4f07-bb3f-c94612dfd4a2', true)`);
      await tx.$queryRawUnsafe(`SELECT set_config('app.tenant_id', 'c68ae9ee-11a8-42f9-bc9c-b19c42ec7914', true)`);
      await tx.$queryRawUnsafe(`SELECT count(*) FROM "CanonicalAdminAuditEvent"`);
    });
    runtimeAuditRead = "PASS";
  } catch (error) {
    runtimeAuditRead = error instanceof Error ? `FAIL:${error.message.split("\n")[0]}` : "FAIL";
  }

  console.log(JSON.stringify({ role, tables, privileges, providers, runtimeAuditRead }, null, 2));
}

main()
  .finally(async () => {
    await Promise.all([owner.$disconnect(), runtime.$disconnect()]);
  });
