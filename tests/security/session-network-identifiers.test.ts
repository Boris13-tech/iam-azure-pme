import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// E15 / R1 (docs/architecture/RETENTION-AND-MINIMIZATION-DESIGN.md): sessions store no network identifier.
// Nothing ever read Session.ipHash or Session.userAgentHash, and an unsalted hash of an IPv4 address can be
// reversed by trial. The stored row is asserted on PostgreSQL in tests/resources/security-journal-postgres.test.ts.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("R1: no network identifier is stored with a session", () => {
  it("the session store takes no IP address or user agent, and writes both hashes as null", () => {
    const store = read("lib/auth/session-store.ts");
    expect(store).toMatch(/static async createSession\(ctx: SessionContext,\n\s+options:/);
    expect(store).toContain("ipHash: null,");
    expect(store).toContain("userAgentHash: null,");
    expect(store).not.toMatch(/update\(ip\)|update\(userAgent\)/);
  });

  it("neither sign-in route reads the client address or user agent for the session", () => {
    for (const path of ["app/api/auth/local/complete/route.ts", "app/auth/callback/route.ts"]) {
      const route = read(path);
      expect(route, path).not.toMatch(/user-agent/i);
      expect(route, path).not.toMatch(/headers\.get\("x-forwarded-for"\)/);
      expect(route, path).toMatch(/SessionStore\.createSession\(\{[\s\S]*?\},\s*\{ evidence:/);
    }
  });
});
