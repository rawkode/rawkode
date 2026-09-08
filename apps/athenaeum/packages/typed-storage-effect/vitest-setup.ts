// Fails the suite unless it is genuinely executing inside workerd, mirroring the guard
// cloudflare-os's typed-storage/router packages use for the same reason (see
// cloudflare-os/scripts/assert-workerd.ts — not imported directly since this package lives
// outside that repo, but the check is copied verbatim: it is small and self-contained).
//
// This package's tests exercise a real `DurableObjectStorage` via `runInDurableObject` and don't
// otherwise import `cloudflare:test`/`cloudflare:workers` from every file, so if the
// vitest-pool-workers pool failed to start and vitest fell back to plain Node, the suite could
// stay green while silently testing the wrong runtime (no real DO storage at all). Checking
// `navigator.userAgent` here catches that unconditionally, for every test file.
if (navigator.userAgent !== "Cloudflare-Workers") {
  throw new Error(
    `Expected to be running inside workerd, but navigator.userAgent is ${JSON.stringify(
      navigator.userAgent,
    )}. The vitest-pool-workers pool did not start -- fix that rather than deleting this check.`,
  );
}
