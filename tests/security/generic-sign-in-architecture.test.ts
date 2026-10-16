import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F4, slice S4: the invariants of generic OIDC sign-in, held on the source so that a later change cannot drop one
// silently. The behaviour behind each is proven by tests/provider-adapters/oidc-generic-sign-in.test.ts (no database)
// and tests/resources/federated-sign-in-postgres.test.ts (real routes, PostgreSQL).
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Source without comments, so that a rule about code is not satisfied or broken by prose. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
const CALLBACK = "app/auth/callback/route.ts";
const LOGIN = "app/auth/login/route.ts";
const SIGN_IN = "lib/auth/generic-oidc-sign-in.ts";
const PROVIDER = "lib/provider-adapters/implementations/oidc-generic/generic-oidc-provider.ts";
const CONFIG = "lib/provider-adapters/implementations/oidc-generic/connection-config.ts";
const FACADE = "lib/auth/providers/oidc-generic.ts";
const RUNTIME = "lib/provider-adapters/implementations/oidc-generic/runtime.ts";
const STORE = "lib/auth/auth-transaction-store.ts";
const GATEWAY = "lib/provider-adapters/implementations/oidc/gateway.ts";

describe("generic OIDC sign-in invariants (F4, S4)", () => {
  it("the callback trusts only `state` from the browser: connection, scope, purpose and configuration come from the transaction", () => {
    const callback = code(CALLBACK);
    expect([...callback.matchAll(/searchParams\.get\(([^)]*)\)/g)].map((m) => m[1])).toEqual([`"state"`]);
    expect(callback).toContain("AuthTransactionStore.consumeTransaction(state)");
    expect(callback).toContain("where: { id: transaction.expectedProviderConnectionId, organizationId: transaction.expectedOrganizationId }");
    expect(callback).toContain("transaction, provider, state, currentUrl: url.href,");
    // The purpose is checked right after the consumption, before the connection is read and before any provider call.
    const purpose = callback.indexOf(`if (transaction.purpose !== "SIGN_IN")`);
    expect(purpose).toBeGreaterThan(callback.indexOf("consumeTransaction(state)"));
    expect(purpose).toBeLessThan(callback.indexOf("providerConnection.findFirst"));
    expect(purpose).toBeLessThan(callback.indexOf("completeGenericOidcSignIn("));
    expect(purpose).toBeLessThan(callback.indexOf("completeEntraAuthentication("));
    // The generic sign-in reads its scope and configuration binding from the transaction, nothing else.
    const signIn = code(SIGN_IN);
    expect(signIn).toContain("const scope = { organizationId: transaction.expectedOrganizationId, tenantId: transaction.expectedTenantId };");
    expect(signIn).toContain("expectedConfigurationHash: transaction.expectedConfigurationHash, currentUrl: input.currentUrl,");
    expect(signIn).toContain(`if (!transaction.expectedConfigurationHash) return refuse("signin"`);
  });

  it("the transaction binds connection + purpose SIGN_IN + the configuration hash, checked before any request to the provider", () => {
    expect(code(LOGIN)).toContain(`...(generic ? { purpose: "SIGN_IN" as const, expectedConfigurationHash: configurationHash } : {}),`);
    const provider = code(PROVIDER);
    const check = provider.indexOf("if (config.configurationHash !== request.response.expectedConfigurationHash)");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(provider.indexOf("await this.oidc.complete("));
    expect(provider).toContain("continuation: { nonce: result.nonce, codeVerifier: result.codeVerifier, configurationHash: config.configurationHash },");
    const migration = read("prisma/migrations/20261016100000_auth_transaction_configuration_binding/migration.sql");
    expect(migration).toContain(`"expectedConfigurationHash" IS NULL OR "expectedConfigurationHash" ~ '^[0-9a-f]{64}$'`);
    expect(migration).not.toMatch(/DROP|BETWEEN/i);
  });

  it("consumption is atomic and single use (one winner even when callbacks race)", () => {
    const store = code(STORE);
    expect(store).toContain("where: { id: transaction.id, consumedAt: null },");
    expect(store).toContain("return claimed.count === 1 ? transaction : null;");
    expect(store).toContain("if (transaction.consumedAt || transaction.expiresAt < new Date())");
  });

  it("identity by (connection, sub) only: no e-mail, UPN or username fallback, no just-in-time account", () => {
    const signIn = code(SIGN_IN);
    expect(signIn).toContain("organizationId_providerConnectionId_externalObjectId: {");
    expect(signIn).toContain("organizationId: transaction.expectedOrganizationId, providerConnectionId: provider.id, externalObjectId: subject } },");
    expect(signIn.match(/identityAccount\.\w+/g)).toEqual(["identityAccount.findUnique"]);
    for (const file of [SIGN_IN, PROVIDER, CONFIG, FACADE]) {
      expect(code(file), file).not.toMatch(/email|e-mail|upn|preferred_username|username|principalName|\.name\b/i);
      expect(code(file), file).not.toMatch(/\.(create|upsert|createMany)\(/);
    }
    expect(read(PROVIDER)).toContain(`subjectClaim: "sub"`);
  });

  it("no claim becomes LUXIA authority: the provider passes on the issuer only, and nothing writes authority", () => {
    expect(code(PROVIDER)).toContain("attributes: { iss: verified.issuer },");
    for (const file of [SIGN_IN, PROVIDER, CONFIG, FACADE]) {
      expect(code(file), file).not.toMatch(/assignment|entitlement|role|group/i);
      expect(code(file), file).not.toMatch(/verified\.claims|\.claims\b/);
    }
  });

  it("generic browser answers only; technical details go to the safe evidence or a log line of constants", () => {
    const callback = code(CALLBACK);
    const start = callback.indexOf(`if (provider.providerType === "OIDC_GENERIC") {`);
    const branch = callback.slice(start, callback.indexOf("return NextResponse.redirect(new URL(transaction.returnTo", start));
    expect(start).toBeGreaterThan(0);
    expect(branch).not.toContain(".json(");
    expect(branch).toContain("return NextResponse.redirect(new URL(`/login?error=${outcome.answer}`, request.url), 303);");
    const signIn = code(SIGN_IN);
    expect(signIn).toContain(`answer: "signin" | "unavailable"`);
    expect(signIn).toContain("console.warn(`OIDC_SIGN_IN_REJECTED ${JSON.stringify({ providerConnectionId: provider.id, ...details })}`);");
    // Never the subject, a token or a network detail in a log line or a refusal.
    expect([...signIn.matchAll(/refuse\("(?:signin|unavailable)", (\{[^}]*\})/g)].map((m) => m[1]).join(" ")).not.toMatch(/subject|token|ip|userAgent/i);
    expect(signIn).toContain(`genericOidcSignInEvidence(identity, "VERIFIED", "OIDC_GENERIC_VERIFIED")`);
    expect(signIn).toContain("recordRejectedSignIn(genericOidcSignInEvidence(identity, \"REJECTED\", error.reason))");
  });

  it("the iat tolerance is the documented 30 s, and is applied to every profile of the core", () => {
    const gateway = code(GATEWAY);
    expect(gateway).toContain("const CLOCK_TOLERANCE_SECONDS = 30;");
    expect(gateway).toContain("&& claims.iat <= now + CLOCK_TOLERANCE_SECONDS && claims.iat < claims.exp;");
    expect(gateway).toContain(`if (!issuedCoherently(claims)) throw failed(`);
  });

  it("the composition root reads generic secrets by reference only, and refuses them until the vault is wired", () => {
    const runtime = code(RUNTIME);
    expect(runtime).toContain("const secrets = new UnconfiguredSecretStore();");
    expect(runtime).toContain("new OpenIdClientOidcGateway(secrets)");
    expect(runtime).not.toMatch(/EnvironmentSecretResolver|process\.env/);
    expect(code(CONFIG)).toContain(`connectionSecretReference(context, "OIDC_CLIENT", "active")`);
  });

  it("Microsoft keeps its own path: its facade, its evidence, its answers, and openid-client's default client authentication", () => {
    const callback = code(CALLBACK);
    expect(callback).toContain("verifiedIdentity = await completeEntraAuthentication({");
    expect(callback).toMatch(/createSession\([\s\S]*\{ evidence: entraSignInEvidence\(signInIdentity, "VERIFIED"/);
    expect(callback).toContain(`return NextResponse.json({ error: "IDENTITY_NOT_ONBOARDED" }, { status: 403 });`);
    const microsoft = read("lib/provider-adapters/implementations/microsoft-entra/oidc-client.ts");
    expect(microsoft).not.toContain("clientAuthMethod");
    expect(code(GATEWAY)).toContain("return undefined;");
  });
});
