import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { secondsUntilRoomInWindow } from "../helpers/rate-limit-window";

// The rate-limit tests make their hits inside one fixed window of the database clock (tests/helpers/rate-limit-window.ts).
describe("rate-limit tests are independent of the wall-clock boundaries", () => {
  it("waits only when the current window has less room than the test needs, then lands just past the boundary", () => {
    const hour = 3600;
    expect(secondsUntilRoomInWindow(1_800_000_000, hour, 60)).toBe(0);              // a multiple of 3600: the window just started
    expect(secondsUntilRoomInWindow(1_800_000_000 + 3500, hour, 60)).toBe(0);       // 100 s left: enough
    expect(secondsUntilRoomInWindow(1_800_000_000 + 3593, hour, 60)).toBe(8);       // 7 s left: wait 7 + 1
    expect(secondsUntilRoomInWindow(1_800_000_000 + 3599.5, hour, 60)).toBe(1.5);   // 0.5 s left
    expect(secondsUntilRoomInWindow(1_800_000_000 + 590, 600, 30)).toBe(11);        // a 10-minute window
    expect(secondsUntilRoomInWindow(1_800_057_600 - 10, 86400, 30)).toBe(11);       // 10 s before midnight UTC (20834 × 86400)
    expect(() => secondsUntilRoomInWindow(0, 60, 60)).toThrow("RATE_LIMIT_TEST_WINDOW_INVALID");
    expect(() => secondsUntilRoomInWindow(0, 60, 0)).toThrow("RATE_LIMIT_TEST_WINDOW_INVALID");
  });

  it("every PostgreSQL test that expects a rate limit to bite first places itself inside one window", () => {
    const expectations: Array<[file: string, guard: string]> = [
      ["tests/resources/recovery-postgres.test.ts", "withinOneRateLimitWindow(3600, 60)"],     // recovery, recovery-identity
      ["tests/resources/recovery-postgres.test.ts", "withinOneRateLimitWindow(86400, 30)"],    // recovery-generate
      ["tests/resources/organization-login-postgres.test.ts", "withinOneRateLimitWindow(600, 30)"],
      ["tests/resources/domains-invitations-postgres.test.ts", "withinOneRateLimitWindow(3600, 30)"],
      ["tests/resources/self-onboarding-postgres.test.ts", "withinOneRateLimitWindow(86400, 30)"],
    ];
    for (const [file, guard] of expectations) expect(readFileSync(file, "utf8"), `${file}: ${guard}`).toContain(`await ${guard};`);
  });
});
