# Enchiridion Runtime

The shared Effect foundation for new worker code. It owns exactly one layer
per genuine cross-cutting service: typed runtime configuration and telemetry.
Worker-specific bindings stay in their own packages rather than being wrapped
in speculative layers.

`RuntimeConfig` holds only non-secret bounded operation defaults; workers own
their service-specific credentials. `withOperationPolicy` accepts a closed
`RuntimeOperation` constant (never a caller string), retries only an explicitly
retryable `ExternalServiceError`, and applies timeout plus safe telemetry.
Concurrency is enforced once by `layerRuntime`'s shared limiter; it is not a
misleading per-call policy field. `makeTestRuntime` supplies Effect's `TestContext`
(including `TestClock` and `TestServices`) plus in-memory telemetry.

`fromCloudflarePromise` and `unknownRecord` are the only Cloudflare/unknown
escape hatches. Their complete audit record is `cloudflareAdapterLedger`.
They discard platform causes at the boundary; public runtime errors and
telemetry contain only safe bounded classifications, never serialized causes.
New Effect worker modules must include `@enchiridion/effect-module`; the root
`lint:deployable-v2` gate then uses the TypeScript AST and type checker to
reject native Promise/thenable escapes (including inferred calls, `fetch`,
`request`, chaining, dynamic import, and template interpolation), all async
forms, and unchecked casts across `.ts`, `.mts`, `.cts`, and `.tsx`. All
non-test runtime source is checked unconditionally: only `src/adapters.ts` is
allowlisted to convert a platform Promise.

Quality commands:

```sh
bun run lint
bunx tsc --build packages/runtime/tsconfig.json
bun test packages/runtime/src
```

`bun run lint` is the strict deployable-v2 gate. Its fail-closed manifest
currently includes `packages/runtime`, `packages/protocol`, and
`workers/vault/src/v2`. The temporary exclusions are audited by
`scripts/check-deployable-v2-scope.ts`: legacy Vault source outside `src/v2` is E2-03 Vault debt,
`workers/gatekeeper-google` is E2-04 Gatekeeper debt, and
`workers/gadget-host` is E2-06 Gadget debt. Generated Swift is E2-05 debt and
is not TypeScript input. E2-07 must replace this registry with its Alchemy
deployment manifest before deployment is enabled.

`bun run lint:all` is an honest whole-tree Biome audit. The inherited baseline
currently has 518 diagnostics outside the deployable scope, so it is not a
release gate until those owners remediate them.
