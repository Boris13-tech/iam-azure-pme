import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Resolves the "@/..." import alias from tsconfig.json so tests can import route handlers directly, refuses PostgreSQL
// suites on anything but a test database, and leaves the Playwright journeys (tests/e2e, run by `npm run test:e2e`) to
// Playwright. Every other Vitest default is unchanged.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { setupFiles: ["./tests/helpers/require-test-database.ts"], exclude: [...configDefaults.exclude, "tests/e2e/**"] },
});
