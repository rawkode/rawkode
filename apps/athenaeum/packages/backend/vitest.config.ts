import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"

/**
 * Tests run inside workerd (via vitest-pool-workers) against the real production entrypoint
 * (`src/index.ts`) and its real `wrangler.jsonc` (`WorkspaceDurableObject`/`UserDurableObject` under
 * `new_sqlite_classes`, reached via `ctx.exports` — no explicit `durable_objects` binding, hence
 * `wrangler.configPath` rather than a hand-rolled `miniflare.durableObjects` map), mirroring
 * cloudflare-os/packages/workshop-backend's own `vitest.integration.config.ts`
 * (`main: "./src/server.ts"`, `wrangler: { configPath: "./wrangler.jsonc" }`).
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc"
      }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["./vitest-setup.ts"],
    // The DO-recovery suite deliberately resets/evicts Durable Object instances mid-operation
    // (`abortAllDurableObjects`/`evictDurableObject`) — cold-starting the whole backend bundle
    // more than once per file, plus the actual reset/evict round trips, is slower than a plain
    // RPC call. Bounded generously rather than tuned tight, per this workspace's ulimit
    // convention (favor headroom over precision for resource/time limits).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Cap'n Web's promise-pipelining machinery reports a duplicate "shadow" rejection for an RPC
    // call whose primary promise the test suite already awaits and asserts on (see
    // `test/request-response.test.ts`'s `rejectionToDomainError`), independent of that
    // already-handled rejection — the same phenomenon cloudflare-os's own
    // `workshop-backend/vitest.integration.config.ts` documents ("a rejected future capability is
    // reported independently from the awaited pipelined call"). Only suppress rejections that are
    // themselves a well-formed `{tag, message, data}` RpcErrorEnvelope — i.e. exactly the
    // deliberately-triggered `DomainError` cases this suite already asserts on — never a
    // generic/unexpected error, so a real bug still fails the run.
    onUnhandledError(error) {
      // Deserialized across the workers-pool RPC boundary — not necessarily a real `Error`
      // instance by the time it reaches this callback, just something with a `.message`.
      const message = (error as { message?: unknown } | null)?.message
      if (typeof message !== "string") return
      try {
        const parsed: unknown = JSON.parse(message)
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).tag === "string" &&
          typeof (parsed as Record<string, unknown>).message === "string" &&
          typeof (parsed as Record<string, unknown>).data === "object"
        ) {
          return false
        }
      } catch {
        // Not JSON — not the shape we're allowlisting; fall through and treat as real.
      }
    }
  }
})
