import { defineConfig, devices } from "@playwright/test";

// Passkey journeys end to end through the real pages (tests/e2e), with Chrome's virtual WebAuthn
// authenticator. The suite does not start the application: run it against a local build started with
// AUTHZ_MODE=native and NEXT_PUBLIC_APP_URL equal to the base URL (see .github/workflows/e2e-passkeys.yml).
// Local only: the signup codes are written with E2E_OWNER_DATABASE_URL, refused unless it is this machine.
const baseURL = process.env.E2E_BASE_URL || "http://localhost:3200";
// The journeys sign up and write: they run against a local server only.
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) throw new Error("E2E_BASE_URL_NOT_LOCAL");

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    locale: "fr-FR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
