import { describe, expect, it } from "vitest";
import { formatRecoveryCode, newRecoveryCode, normalizeRecoveryCode, recoveryCodeHash } from "../../lib/auth/recovery";

// First Admin / Break-glass v1, B2 (design section 2): code format, normalization and hashing.
describe("B2 recovery codes", () => {
  it("are 20 Crockford base32 characters, shown as XXXXX-XXXXX-XXXXX-XXXXX", () => {
    for (let i = 0; i < 200; i++) {
      const code = newRecoveryCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
      expect(formatRecoveryCode(code)).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
      expect(normalizeRecoveryCode(formatRecoveryCode(code))).toBe(code);
    }
  });

  it("use the whole alphabet without bias (5 bits of each random byte)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const c of newRecoveryCode()) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(32);
    // 40 000 characters, 1 250 expected per symbol: a biased generator falls far outside this band.
    for (const [symbol, count] of counts) {
      expect(count, symbol).toBeGreaterThan(1000);
      expect(count, symbol).toBeLessThan(1500);
    }
  });

  it("normalize input: case, spaces and hyphens, O read as 0, I and L read as 1", () => {
    const code = "0123456789ABCDEFGHJK";
    expect(normalizeRecoveryCode(" 01234-56789 abcde-fghjk ")).toBe(code);
    expect(normalizeRecoveryCode("O1234-56789-ABCDE-FGHJK")).toBe(code);
    expect(normalizeRecoveryCode("0i234-56789-ABCDE-FGHJK")).toBe(code);
    expect(normalizeRecoveryCode("0L234-56789-ABCDE-FGHJK")).toBe(code);
  });

  it("refuse anything that is not a code", () => {
    for (const input of [undefined, null, 42, "", "0123456789ABCDEFGHJ", "0123456789ABCDEFGHJKM", "0123456789ABCDEFGHJU",
      "0123456789ABCDEFGH*K", `${"0".repeat(20)}${" ".repeat(45)}`, { code: "0123456789ABCDEFGHJK" }])
      expect(normalizeRecoveryCode(input), String(input)).toBeNull();
  });

  it("hash with domain separation and the identity account: the same code never matches another account", () => {
    const code = "0123456789ABCDEFGHJK";
    const a = recoveryCodeHash("account-a", code);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryCodeHash("account-a", code)).toBe(a);
    expect(recoveryCodeHash("account-b", code)).not.toBe(a);
    expect(recoveryCodeHash("account-a", "0123456789ABCDEFGHJM")).not.toBe(a);
    expect(a).not.toContain(code.toLowerCase());
  });
});
