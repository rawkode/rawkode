import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Tests run inside workerd (via vitest-pool-workers) against a real `DurableObjectStorage`
 * obtained through `runInDurableObject` — not a hand-rolled mock — so they exercise this
 * package's actual runtime dependency (DO's synchronous `storage.kv`/`storage.transactionSync()`
 * API), not an approximation of it.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          TEST_STORAGE: { className: "TestStorageDurableObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["./vitest-setup.ts"],
  },
});
