import { resolve4 } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import { ProviderManagementFailure } from "../../../provider-management/contracts";

export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

// Resolve once and pin the checked address. TLS still verifies the original host.
// IPv6-only issuers fail closed until a reviewed IPv6 range policy is provided.
export async function oidcMetadataRequest(value: string): Promise<unknown> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== "443") || isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new ProviderManagementFailure("OIDC_UNSAFE_ENDPOINT");
  }
  let addresses: string[];
  try { addresses = await resolve4(url.hostname); }
  catch { throw new ProviderManagementFailure("OIDC_DNS_UNAVAILABLE"); }
  if (!addresses.length || addresses.some(address => !publicIpv4(address))) {
    throw new ProviderManagementFailure("OIDC_UNSAFE_ENDPOINT");
  }
  return new Promise((resolve, reject) => {
    const fail = (code: string) => reject(new ProviderManagementFailure(code));
    const req = request(url, {
      method: "GET", servername: url.hostname, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, addresses[0], 4),
      headers: { Accept: "application/json" },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume(); fail("OIDC_HTTP_REJECTED"); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_000_000) { req.destroy(); fail("PROVIDER_RESPONSE_TOO_LARGE"); }
        else chunks.push(chunk);
      });
      response.on("error", () => fail("PROVIDER_UNAVAILABLE"));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { fail("INVALID_PROVIDER_RESPONSE"); }
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), 8000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", () => fail("PROVIDER_UNAVAILABLE"));
    req.end();
  });
}
