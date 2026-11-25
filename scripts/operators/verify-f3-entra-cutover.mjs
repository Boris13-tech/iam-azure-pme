#!/usr/bin/env node
// G2-R02 / F3 operator preflight utility (read-only, zero secret output).
// Computes the bijective per-connection variable name and validates Production F3 cutover prerequisites
// without ever printing or logging any secret value.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONNECTION_ID_BYTES = 45;

function parseArgs(argv) {
  const out = { connectionId: "", checkEnv: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--connection-id" && argv[i + 1]) {
      out.connectionId = argv[++i];
    } else if (argv[i] === "--check-env") {
      out.checkEnv = true;
    }
  }
  return out;
}

const { connectionId, checkEnv } = parseArgs(process.argv.slice(2));
if (!connectionId) {
  console.error("Usage: node scripts/operators/verify-f3-entra-cutover.mjs --connection-id <providerConnectionId> [--check-env]");
  process.exit(2);
}

const byteLength = Buffer.byteLength(connectionId, "utf8");
if (byteLength < 1 || byteLength > MAX_CONNECTION_ID_BYTES) {
  console.error(`REFUSED: connectionId UTF-8 byte length (${byteLength}) must be between 1 and ${MAX_CONNECTION_ID_BYTES}`);
  process.exit(1);
}

const prefix = `ENTRA_CONN_HEX_${Buffer.from(connectionId, "utf8").toString("hex").toUpperCase()}`;
const authClientIdVar = `${prefix}_AUTH_CLIENT_ID`;

console.log(JSON.stringify({
  connectionIdLength: connectionId.length,
  scopedEnvPrefix: prefix,
  requiredProductionClientIdVar: authClientIdVar,
  requiredProductionWorkloadVars: ["LUXIA_WORKLOAD_TENANT_ID", "LUXIA_WORKLOAD_CLIENT_ID", "NEXT_PUBLIC_APP_URL"],
  requiredDatabaseRow: {
    table: "ProviderSecretReference",
    providerConnectionId: "<matching connection id>",
    purpose: "OIDC_CLIENT",
    store: "azure-key-vault",
    locatorShape: "akv://<vault-name>/<secret-name>",
    activeVersionShape: "<32-hex-chars>",
  },
  forbiddenLegacyVarsToRetireAfterCutover: [
    "ENTRA_AUTH_CLIENT_ID",
    "ENTRA_AUTH_CLIENT_SECRET",
    "GRAPH_CLIENT_ID",
    "GRAPH_CLIENT_SECRET",
    "NEXT_PUBLIC_GRAPH_CLIENT_ID",
    "NEXT_PUBLIC_GRAPH_TENANT_ID",
  ],
}, null, 2));

if (checkEnv) {
  const failures = [];
  if (!UUID_RE.test(process.env.LUXIA_WORKLOAD_TENANT_ID ?? "")) failures.push("LUXIA_WORKLOAD_TENANT_ID missing or not UUID");
  if (!UUID_RE.test(process.env.LUXIA_WORKLOAD_CLIENT_ID ?? "")) failures.push("LUXIA_WORKLOAD_CLIENT_ID missing or not UUID");
  if (!UUID_RE.test(process.env[authClientIdVar] ?? "")) failures.push(`${authClientIdVar} missing or not UUID`);
  try {
    const u = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
    if (u.protocol !== "https:") failures.push("NEXT_PUBLIC_APP_URL must use https:");
  } catch {
    failures.push("NEXT_PUBLIC_APP_URL missing or invalid URL");
  }
  if (failures.length > 0) {
    console.error("PREFLIGHT_FAILED:", failures.join("; "));
    process.exit(1);
  }
  console.log("PREFLIGHT_ENV_OK");
}
