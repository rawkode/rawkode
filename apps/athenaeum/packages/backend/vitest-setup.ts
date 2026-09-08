// Fails the suite unless it is genuinely executing inside workerd, mirroring the guard
// `typed-storage-effect`'s own `vitest-setup.ts` uses (copied verbatim, same rationale): this
// package's tests exercise a real `WorkspaceDurableObject` over a real Cap'n Web WebSocket session,
// and if the vitest-pool-workers pool failed to start and vitest fell back to plain Node, the
// suite could stay green while silently testing nothing real at all.
if (navigator.userAgent !== "Cloudflare-Workers") {
  throw new Error(
    `Expected to be running inside workerd, but navigator.userAgent is ${JSON.stringify(
      navigator.userAgent
    )}. The vitest-pool-workers pool did not start -- fix that rather than deleting this check.`
  )
}
