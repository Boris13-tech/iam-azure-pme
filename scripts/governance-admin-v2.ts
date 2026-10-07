import { readFile } from "node:fs/promises";
import { withTenantDb } from "../lib/db/scoped-client";
import { rawPrisma } from "../lib/db/raw-prisma";
import { GOVERNANCE_ADMIN_V2, applyGovernanceAdminBundle, rollbackGovernanceAdminBundle } from "../lib/resources/admin-bundle";
const mode = process.argv[2];
async function main() {
  if (!["plan", "apply", "rollback"].includes(mode)) throw new Error("INVALID_MODE");
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (url.username !== "app_user" || url.pathname !== "/neondb" || ![
    "ep-delicate-boat-ahnvfj7w-pooler.c-3.us-east-1.aws.neon.tech",
    "ep-restless-thunder-ah18c37v-pooler.c-3.us-east-1.aws.neon.tech",
  ].includes(url.hostname)) throw new Error("RUNTIME_SCOPE_DENY");
  if (mode !== "plan" && process.env.GOVERNANCE_ADMIN_CONFIRMATION !== (mode === "apply" ? "APPLY_GOVERNANCE_ADMIN_V2" : "ROLLBACK_GOVERNANCE_ADMIN_V2")) throw new Error("CONFIRMATION_REQUIRED");
  const bundle = JSON.parse(await readFile("docs/operations/canonical-administration-v1-bundle.json", "utf8")) as { scope: { organizationId: string; tenantId: string; subjectId: string } };
  const auth = bundle.scope;
  const validation = await withTenantDb(auth, async tx => {
    const subject = await tx.subject.findFirst({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, id: auth.subjectId, type: "HUMAN", lifecycleState: "ACTIVE" } });
    const identity = await tx.identityAccount.findFirst({ where: { organizationId: auth.organizationId, tenantId: auth.tenantId, subjectId: auth.subjectId, status: "ACTIVE", externalObjectId: "e6ac473c-0e9a-4d04-bd02-4954b3caa6d2", providerConnection: { providerType: "MICROSOFT_ENTRA" } } });
    if (!subject || !identity || await tx.legacyUserBridge.count({ where: { organizationId: auth.organizationId, subjectId: auth.subjectId } })) throw new Error("CANONICAL_IDENTITY_VALIDATION_FAILED");
    return { subjectValidated: true, noLegacyBridge: true };
  });
  console.log(JSON.stringify({ mode, ...validation, scope: auth, roleKey: "LUXIA_ORG_ADMIN", roleVersion: 2, keys: GOVERNANCE_ADMIN_V2, existingAssignmentsModified: false }));
  if (mode === "plan") return;
  const result = mode === "apply" ? await applyGovernanceAdminBundle(auth, auth.subjectId, "governance-admin:v2:apply") : await rollbackGovernanceAdminBundle(auth, auth.subjectId, "governance-admin:v2:rollback");
  console.log(JSON.stringify({ ...result, operation: mode === "apply" ? "ROLE.GOVERNANCE.GRANT" : "ROLE.GOVERNANCE.REVOKE", tenantScoped: true, audited: true }));
}
main().catch(() => { console.error("GOVERNANCE_BUNDLE_FAILED — no raw credentials or DB errors emitted"); process.exitCode = 1; }).finally(() => rawPrisma.$disconnect());
