import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Only resolves the "@/..." import alias from tsconfig.json so tests can import route handlers
// directly. Every other Vitest default is unchanged.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
});
