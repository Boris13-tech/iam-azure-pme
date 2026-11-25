import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GET as runtimeInfoGet } from "../../app/api/internal/runtime-info/route";
import { provenanceTokenAccepted } from "../../lib/monitoring/provenance-token";
import { clientNetworkKey } from "../../lib/security/rate-limit";

describe("G2-R06 (F-06 & F-07): constant-time provenance token and proxy header trust chain", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("enforces >= 32-char length and constant-time SHA-256 digest equality on STAGING_PROVENANCE_TOKEN", async () => {
    const validToken = "p".repeat(32);
    const shortToken = "p".repeat(31);

    expect(provenanceTokenAccepted(validToken, undefined)).toBe(false);
    expect(provenanceTokenAccepted(null, validToken)).toBe(false);
    expect(provenanceTokenAccepted(shortToken, shortToken)).toBe(false); // < 32 chars refused even when equal
    expect(provenanceTokenAccepted("wrong", validToken)).toBe(false);
    expect(provenanceTokenAccepted("x".repeat(200), validToken)).toBe(false);
    expect(provenanceTokenAccepted(validToken, validToken)).toBe(true);

    // Route returns 404 with Cache-Control: no-store when unset in Production
    delete process.env.STAGING_PROVENANCE_TOKEN;
    const prodRes = await runtimeInfoGet(
      new NextRequest("https://iam-azure-pme.vercel.app/api/internal/runtime-info", {
        headers: { "x-luxia-provenance-token": validToken },
      }),
    );
    expect(prodRes.status).toBe(404);
    expect(prodRes.headers.get("cache-control")).toBe("no-store");

    // Route returns 200 with Cache-Control: no-store when >= 32-char token matches
    process.env.STAGING_PROVENANCE_TOKEN = validToken;
    process.env.APP_ENV = "staging";
    process.env.AUTHZ_MODE = "native";
    const stagingRes = await runtimeInfoGet(
      new NextRequest("https://staging.luxia.test/api/internal/runtime-info", {
        headers: { "x-luxia-provenance-token": validToken },
      }),
    );
    expect(stagingRes.status).toBe(200);
    expect(stagingRes.headers.get("cache-control")).toBe("no-store");
    expect(await stagingRes.json()).toMatchObject({ environment: "staging", authzMode: "native" });
  });

  it("enforces Vercel edge header precedence on Vercel and refuses spoofed X-Forwarded-For / X-Real-IP off Vercel in Production", () => {
    // 1. On Vercel (VERCEL="1"): uses x-vercel-forwarded-for / x-real-ip, ignores spoofed leftmost x-forwarded-for
    const vercelEnv = { VERCEL: "1", VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://iam-azure-pme.vercel.app" };
    const spoofAttemptOnVercel = new Request("https://iam-azure-pme.vercel.app/api/auth/local/begin", {
      method: "POST",
      headers: {
        "x-forwarded-for": "198.51.100.99, 203.0.113.7",
        "x-vercel-forwarded-for": "203.0.113.7",
        "x-real-ip": "203.0.113.7",
      },
    });
    expect(clientNetworkKey(spoofAttemptOnVercel, vercelEnv)).toBe("ip:203.0.113.7");

    // On Vercel without edge headers, x-forwarded-for alone is never trusted
    const missingEdgeHeaders = new Request("https://iam-azure-pme.vercel.app/api/auth/local/begin", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.99" },
    });
    expect(clientNetworkKey(missingEdgeHeaders, vercelEnv)).toBe("ip:vercel-unknown");

    // 2. Off-Vercel Production WITHOUT LUXIA_TRUSTED_CLIENT_IP_HEADER: rotated spoofed IPs collapse to ip:untrusted-proxy
    const offVercelProd = { APP_ENV: "production", NEXT_PUBLIC_APP_URL: "https://id.luxia-it.eu" };
    const spoof1 = new Request("https://id.luxia-it.eu/api/auth/local/begin", {
      headers: { "x-real-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.1" },
    });
    const spoof2 = new Request("https://id.luxia-it.eu/api/auth/local/begin", {
      headers: { "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.2" },
    });
    expect(clientNetworkKey(spoof1, offVercelProd)).toBe("ip:untrusted-proxy");
    expect(clientNetworkKey(spoof2, offVercelProd)).toBe("ip:untrusted-proxy");

    // Setting LUXIA_TRUSTED_CLIENT_IP_HEADER="x-forwarded-for" is explicitly forbidden
    expect(
      clientNetworkKey(spoof1, { ...offVercelProd, LUXIA_TRUSTED_CLIENT_IP_HEADER: "x-forwarded-for" }),
    ).toBe("ip:untrusted-proxy");

    // 3. Off-Vercel Production WITH explicit single-IP header (e.g. x-luxia-real-ip set by EU ingress)
    const configuredProxyEnv = { ...offVercelProd, LUXIA_TRUSTED_CLIENT_IP_HEADER: "x-luxia-real-ip" };
    const proxiedReq = new Request("https://id.luxia-it.eu/api/auth/local/begin", {
      headers: {
        "x-forwarded-for": "198.51.100.1",
        "x-real-ip": "198.51.100.2",
        "x-luxia-real-ip": "2001:DB8::42",
      },
    });
    expect(clientNetworkKey(proxiedReq, configuredProxyEnv)).toBe("ip:2001:db8::42");

    // 4. Local loopback E2E (http://localhost:3200, NODE_ENV=production) still isolates virtual test devices via x-real-ip
    const localE2eEnv = { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3200" };
    const e2eReq = new Request("http://localhost:3200/api/auth/signup/begin", {
      headers: { "x-real-ip": "2001:db8:abcd::1" },
    });
    expect(clientNetworkKey(e2eReq, localE2eEnv)).toBe("ip:2001:db8:abcd::1");
  });
});
