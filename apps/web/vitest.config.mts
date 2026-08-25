import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Mirrors the `@/*` path alias from tsconfig.json so tests can import the real
 * route handlers and middleware instead of re-implementing what they do.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // Database-backed tests live in their own project (vitest.db.config.mts)
    // because they need a throwaway Postgres; `npm test` must not need one.
    exclude: ["node_modules/**", ".next/**", "tests/db/**"],
  },
});
