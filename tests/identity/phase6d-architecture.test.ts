import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

describe("Phase 6D architecture boundaries", () => {
  it("requires every successful AuthenticationProvider result to carry typed evidence", () => {
    const contract = read("lib/provider-adapters/authentication-provider.ts");
    expect(contract).toMatch(/VerifiedExternalIdentity[\s\S]*evidence:\s*AuthenticationEvidenceEnvelope/);
    for (const file of [
      "lib/provider-adapters/implementations/microsoft-entra/microsoft-entra-adapter.ts",
      "lib/provider-adapters/implementations/luxia-local/luxia-local-adapter.ts",
    ]) {
      expect(read(file)).toContain("createAuthenticationEvidence(");
    }
  });

  it("keeps provider-specific claims and SDKs outside authorization decisions", () => {
    const authorization = [
      "lib/auth/authorization-engine.ts",
      "lib/auth/authorization-gateway.ts",
      "lib/auth/entitlements-catalog.ts",
    ].map(read).join("\n");
    expect(authorization).not.toMatch(/\b(tid|oid|azureId|preferredUsername|userPrincipalName)\b/);
    expect(authorization).not.toMatch(/@azure|@microsoft|openid-client|microsoft-entra|provider-adapters\/implementations/i);
  });

  it("reconciles Phase 6C schema to the tenant-scoped LocalIdentity relation", () => {
    const schema = read("prisma/schema.prisma");
    for (const model of ["LocalAuthenticator", "LocalAuthChallenge", "LocalRecoveryCode"]) {
      const body = schema.slice(schema.indexOf(`model ${model}`), schema.indexOf("}", schema.indexOf(`model ${model}`)));
      expect(body).toContain("localIdentity");
      expect(body).not.toMatch(/IdentityAccount\s+IdentityAccount/);
    }
  });
});

function read(file: string): string { return readFileSync(join(root, file), "utf8"); }
