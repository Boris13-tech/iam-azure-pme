import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Phase 6E architecture boundaries", () => {
  it("routes local verifier algorithms through the provider-neutral crypto registry", () => {
    for (const path of [
      "lib/provider-adapters/implementations/luxia-local/webauthn.ts",
      "lib/provider-adapters/implementations/luxia-local/totp.ts",
    ]) {
      const source = read(path);
      expect(source).toContain("LUXIA_CRYPTO_ALGORITHMS.resolve");
      expect(source).not.toMatch(/createHash\(["']sha256["']\)|createHmac\(["']sha1["']\)|verify\(["']sha256["']/);
    }
  });

  it("stores version metadata, public material or custody references, never private/biometric material", () => {
    const schema = read("prisma/schema.prisma");
    const models = schema.slice(schema.indexOf("model LocalAuthenticator"), schema.indexOf("model LocalAuthChallenge"));
    expect(models).toContain("algorithmVersion"); expect(models).toContain("custodyRef");
    expect(models).toContain("deviceSubjectId"); expect(models).not.toMatch(/biometricTemplate|privateKey\s+String/i);
  });

  it("enforces tenant RLS for key and trust-anchor versions", () => {
    const migration = read("prisma/migrations/20260923010000_phase6e_credential_crypto_agility/migration.sql");
    for (const table of ["CryptoKeyVersion", "TrustAnchorVersion"]) {
      expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ON "${table}" USING`);
    }
  });
});
