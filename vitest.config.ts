import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolves the "@/..." import alias from tsconfig.json so tests can import route handlers directly, and refuses
// PostgreSQL suites on anything but a test database. Every other Vitest default is unchanged.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { setupFiles: ["./tests/helpers/require-test-database.ts"] },
});
