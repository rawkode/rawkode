import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Every OTHER test in this package (`gatekeeper-account-service.test.ts`, `google-calendar-
 * client-real.test.ts`, `observer-verification.test.ts`) exercises pure business-logic Effect
 * programs against in-memory/scripted doubles and never touches anything workerd-specific, so
 * plain Vitest with zero config has always been sufficient (no `vitest-pool-workers` needed — see
 * this package's own README/header comments on that discipline). `worker-auth.test.ts` is the
 * first test to import `worker.ts` itself, which transitively imports `cloudflare:workers` (via
 * `gatekeeper-account-durable-object.ts`'s `DurableObject` base class) — a built-in module that
 * only exists inside workerd. Rather than pull in the full `vitest-pool-workers`/wrangler
 * machinery just to satisfy one import this test never actually exercises (see `worker-auth.
 * test.ts`'s own header comment — it never instantiates a real `GatekeeperAccountDurableObject`),
 * this alias swaps in `test/cloudflare-workers-stub.ts`, a minimal same-shape stand-in, for THIS
 * package's test runs only — production `wrangler.jsonc`/`wrangler dev`/a real deployment never
 * sees this alias; it resolves the real `cloudflare:workers` built-in as always.
 */
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve(__dirname, "test/cloudflare-workers-stub.ts")
    }
  },
  test: {
    include: ["test/**/*.test.ts"]
  }
})
