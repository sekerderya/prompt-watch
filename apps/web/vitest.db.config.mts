import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Database-backed tests: they exercise the real route handlers against a real
 * Postgres, so they cover the advisory locks, the enum constraints and the
 * joins that the unit suite cannot reach.
 *
 * Kept in a separate project because they need a throwaway database, while
 * `npm test` must stay runnable with nothing installed but node.
 *
 * They share one database, so they run in a single worker: parallel files would
 * truncate each other's rows mid-test. The concurrency the tests care about is
 * driven inside them, with Promise.all against one handler.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.db.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
