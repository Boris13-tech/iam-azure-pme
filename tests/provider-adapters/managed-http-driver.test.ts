import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedHttpDriver } from "../../lib/provider-adapters/implementations/managed-http/driver";
import { connectionSecretReference } from "../../lib/provider-management/contracts";
import { oidcMetadataRequest } from "../../lib/provider-adapters/implementations/managed-http/oidc-http";
vi.mock("../../lib/provider-adapters/implementations/managed-http/oidc-http", () => ({ oidcMetadataRequest: vi.fn() }));
const context = { organizationId: "org", tenantId: "tenant", providerConnectionId: "connection", operationId: "operation" };
const key = connectionSecretReference(context);
const google = () => createManagedHttpDriver({ context, type: "GOOGLE_WORKSPACE", externalScopeId: "C123",
  configuration: { customerId: "C123" }, attributeMapping: { displayName: "name.fullName", principalName: "primaryEmail" }, credentialSecretRef: key });
describe("Managed provider real HTTP boundaries", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it("calls Google Directory with bounded pagination and compatible immutable projections", async () => {
    vi.stubEnv(key, "never-return-this-token");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ users: [{ id: "123", primaryEmail: "alice@example.test", name: { fullName: "Alice" } }], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(Response.json({ users: [{ id: "456", primaryEmail: "bob@example.test" }] }));
    vi.stubGlobal("fetch", fetcher);
    const results = []; for await (const item of google().discover()) results.push(item);
    expect(results.map(item => item.externalObjectId)).toEqual(["google_workspace:identity:123", "google_workspace:identity:456"]);
    expect(JSON.stringify(results)).not.toContain("never-return-this-token");
    expect(fetcher.mock.calls[1][0]).toContain("pageToken=page-2");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });
  it("rejects replayed pagination cursors", async () => {
    vi.stubEnv(key, "private"); vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ users: [], nextPageToken: "same" })));
    await expect((async () => { for await (const item of google().discover()) void item; })()).rejects.toThrow("PROVIDER_CURSOR_REPLAY");
  });
  it("never returns raw provider error bodies or tokens", async () => {
    vi.stubEnv(key, "private"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret provider diagnostic", { status: 403 })));
    await expect(google().testConnection()).rejects.toThrow("PROVIDER_ACCESS_DENIED");
  });
  it("fails before network access on a foreign secret reference or customer scope", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const driver = createManagedHttpDriver({ context, type: "GOOGLE_WORKSPACE", externalScopeId: "C123",
      configuration: { customerId: "C123" }, attributeMapping: {}, credentialSecretRef: connectionSecretReference({ ...context, tenantId: "other" }) });
    await expect(driver.testConnection()).rejects.toThrow("PROVIDER_SECRET_UNAVAILABLE");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("tests approved OIDC discovery with exact issuer comparison", async () => {
    vi.stubEnv("LUXIA_OIDC_ALLOWED_ISSUERS", "https://identity.example.test");
    vi.mocked(oidcMetadataRequest).mockResolvedValue({ issuer: "https://wrong.example.test",
      authorization_endpoint: "https://identity.example.test/auth", token_endpoint: "https://identity.example.test/token", jwks_uri: "https://identity.example.test/keys" });
    const driver = createManagedHttpDriver({ context, type: "OIDC_GENERIC", externalScopeId: "https://identity.example.test",
      configuration: { issuer: "https://identity.example.test" }, attributeMapping: {}, credentialSecretRef: null });
    await expect(driver.testConnection()).rejects.toThrow("OIDC_METADATA_MISMATCH");
    await expect((async () => { for await (const item of driver.discover()) void item; })()).rejects.toThrow("DIRECTORY_DISCOVERY_UNSUPPORTED");
  });
  it("does not access arbitrary OIDC URLs", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); vi.stubEnv("LUXIA_OIDC_ALLOWED_ISSUERS", "");
    await expect(createManagedHttpDriver({ context, type: "OIDC_GENERIC", externalScopeId: "https://127.0.0.1",
      configuration: { issuer: "https://127.0.0.1" }, attributeMapping: {}, credentialSecretRef: null }).testConnection()).rejects.toThrow("OIDC_ISSUER_NOT_APPROVED");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
