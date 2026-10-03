import { EventEmitter } from "node:events";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oidcMetadataRequest, publicIpv4 } from "../../lib/provider-adapters/implementations/managed-http/oidc-http";
vi.mock("node:dns/promises", () => ({ resolve4: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
describe("OIDC SSRF protection", () => {
  afterEach(() => vi.resetAllMocks());
  it.each(["https://localhost", "https://127.0.0.1", "https://10.0.0.1", "https://[::1]", "https://internal.local", "https://example.test:8443", "http://example.test"])("rejects unsafe literal endpoint %s", async value => {
    await expect(oidcMetadataRequest(value)).rejects.toThrow("OIDC_UNSAFE_ENDPOINT");
    expect(resolve4).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it.each(["127.0.0.1", "10.10.0.1", "192.168.0.1", "172.31.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1"])("rejects non-public DNS answer %s", async address => {
    expect(publicIpv4(address)).toBe(false);
    vi.mocked(resolve4).mockResolvedValue([address] as never);
    await expect(oidcMetadataRequest("https://issuer.example.test/.well-known/openid-configuration")).rejects.toThrow("OIDC_UNSAFE_ENDPOINT");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects mixed public and private DNS answers", async () => {
    vi.mocked(resolve4).mockResolvedValue(["8.8.8.8", "10.0.0.1"] as never);
    await expect(oidcMetadataRequest("https://issuer.example.test")).rejects.toThrow("OIDC_UNSAFE_ENDPOINT");
  });
  it("pins approved public DNS and rejects redirects without a second request", async () => {
    vi.mocked(resolve4).mockResolvedValue(["8.8.8.8"] as never);
    let options: Record<string, unknown> = {};
    vi.mocked(request).mockImplementation(((url: URL, opts: Record<string, unknown>, callback: (response: unknown) => void) => {
      options = opts; expect(url.hostname).toBe("issuer.example.test");
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
      req.end = () => { callback({ statusCode: 302, resume() {} }); req.emit("close"); };
      req.destroy = () => { req.emit("close"); };
      return req;
    }) as never);
    await expect(oidcMetadataRequest("https://issuer.example.test")).rejects.toThrow("OIDC_HTTP_REJECTED");
    expect(options).toMatchObject({ family: 4, servername: "issuer.example.test", rejectUnauthorized: true });
    const lookup = options.lookup as (host: string, opts: unknown, callback: (...args: unknown[]) => void) => void;
    const callback = vi.fn(); lookup("issuer.example.test", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
