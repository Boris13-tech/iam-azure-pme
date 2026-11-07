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
      expect(route, path).not.toMatch(/x-forwarded-for|x-real-ip/i);
      // The only arguments are the context and the evidence: no address can reach the session.
      expect(route, path).toMatch(/SessionStore\.createSession\(\{[\s\S]*?\},\s*\{ evidence:/);
    }
  });

  it("recovery sessions are written without network identifiers, and no administrator response returns them", () => {
    const recovery = read("lib/auth/recovery.ts");
    expect(recovery).toMatch(/tx\.session\.create\(/);
    expect(recovery).not.toMatch(/ipHash|userAgentHash/);
    const admin = read("lib/admin/canonical-administration.ts");
    expect(admin).not.toMatch(/ipHash: true|userAgentHash: true/);
    // Every session read in the administration library and the session store selects its columns explicitly, and
    // none selects a network hash: no exemption, whatever the formatting.
    for (const path of ["lib/admin/canonical-administration.ts", "lib/auth/session-store.ts"]) {
      const source = read(path);
      const reads = source.match(/tx\.session\.find\w*\([^;]*/g) ?? [];
      expect(reads.length, path).toBeGreaterThanOrEqual(path.includes("admin") ? 3 : 1);
      for (const call of reads) {
        expect(call, `${path}: ${call.slice(0, 80)}`).toMatch(/\bselect\s*:/);
        expect(call, `${path}: ${call.slice(0, 80)}`).not.toMatch(/\binclude\s*:|ipHash|userAgentHash/);
      }
    }
  });
});
