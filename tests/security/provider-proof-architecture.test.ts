import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIVATION_EVIDENCE_MAX_AGE_MS } from "../../lib/admin/provider-connection-lifecycle";
import { operationLabel } from "../../lib/ui/activity-labels";

// F4, slice S5: the invariants of the proof sign-in and of the first activation, held on the source. The behaviour is
// proven by tests/resources/provider-connection-proof-postgres.test.ts.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
const PROOF = "lib/admin/provider-connection-proof.ts";
const CALLBACK = "app/auth/callback/route.ts";

describe("proof sign-in and first activation invariants (F4, S5)", () => {
  it("a proof never opens a session, sets a cookie, creates or links an account, or keeps the provider's subject", () => {
    const proof = code(PROOF);
    expect(proof).not.toMatch(/createSession|SessionStore|cookies\(|\.set\(|identityAccount|subject\.create|externalObjectId/);
    // The verified identity returned by the core is not even read.
    expect(proof).toContain("await dependencies.complete({");
    expect(proof).not.toMatch(/=\s*await dependencies\.complete\(/);
    const callback = code(CALLBACK);
    const start = callback.indexOf(`if (transaction.purpose === "ACTIVATION_PROOF") {`);
    const branch = callback.slice(start, callback.indexOf("\n    }\n", start));
    expect(start).toBeGreaterThan(0);
    expect(branch).not.toMatch(/cookies|createSession|json\(/);
    expect(branch).toContain("return NextResponse.redirect(new URL(`${PROOF_RETURN_PATH}?providerProof=${proof}`, request.url), 303);");
    // The proof branch comes before the ACTIVE check: a proof is only for a TESTING connection, a sign-in only for ACTIVE.
    expect(start).toBeLessThan(callback.indexOf(`if (provider.status !== "ACTIVE")`));
  });

  it("a proof is bound to the administrator who started it, to the connection, its configuration hash and its secret version", () => {
    const proof = code(PROOF);
    expect(proof).toContain(`purpose: "ACTIVATION_PROOF", subjectId: auth.subjectId, expectedConfigurationHash: current.configurationHash,`);
    expect(proof).toContain("auth.subjectId !== transaction.subjectId");
    expect(proof).toContain("auth.organizationId !== transaction.expectedOrganizationId || auth.tenantId !== transaction.expectedTenantId");
    expect(proof).toContain(`if (target.status !== "TESTING") throw new CanonicalAdminError("CONNECTION_PROOF_NOT_ALLOWED", 409);`);
    expect(proof).toContain(`if (current.secretVersion !== before.secretVersion) throw new CanonicalAdminError("CONNECTION_SECRET_CHANGED", 409);`);
    expect(proof).toContain("metadata: { issuerHost: current.issuerHost, secretVersion: current.secretVersion, ...details },");
  });

  it("the permission comes first and the provider is reached outside any transaction, before the journaled operation", () => {
    const proof = code(PROOF);
    for (const [fn, call] of [["export async function startConnectionProof", "await dependencies.begin("], ["async function recordProof", "await dependencies.complete("]]) {
      const body = proof.slice(proof.indexOf(fn));
      const permission = body.indexOf(`await requireNative(tx, auth, "providers.manage");`);
      const network = body.indexOf(call);
      const journaled = body.indexOf("return operation(auth, changeId, NAME, \"providers.manage\", async (tx) => {");
      expect(permission, fn).toBeGreaterThan(0);
      expect(network, fn).toBeGreaterThan(permission);
      expect(journaled, fn).toBeGreaterThan(network);
    }
  });

  it("no code dates a test run itself: the database stamps it, and freshness is measured from that stamp", () => {
    for (const file of [PROOF, "lib/admin/provider-connection-test.ts"]) expect(code(file), file).not.toContain("occurredAt");
    expect(ACTIVATION_EVIDENCE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("every new journaled operation has a French label (B5)", () => {
    for (const name of ["PROVIDER.CONNECTION.PROOF.START", "PROVIDER.CONNECTION.PROOF"]) {
      expect(operationLabel(name), name).toBeTruthy();
      expect(operationLabel(`${name}.DENIED`), name).toMatch(/\(refusé\)$/);
    }
    expect(operationLabel("PROVIDER.CONNECTION.ACTIVATE")).toBe("Fournisseur activé");
  });
});
