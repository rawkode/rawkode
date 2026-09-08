// A minimal runtime stand-in for the `cloudflare:workers` built-in module (real inside workerd,
// absent in plain Node) — aliased in for THIS package's plain-Vitest test runs only (see
// `vitest.config.ts`'s `resolve.alias`), so `worker.ts` (which re-exports `GatekeeperAccountDurableObject`,
// and therefore transitively imports `gatekeeper-account-durable-object.ts#DurableObject` from
// `cloudflare:workers`) can be imported at all outside workerd.
//
// `worker-auth.test.ts` is the one test in this package that needs this: it exercises `worker.ts`'s
// `fetch()` handler directly (the caller-credential auth gate — plain request/response logic, no
// real Durable Object storage involved) without spinning up a full `vitest-pool-workers`/workerd
// environment, matching this package's existing "swap real storage for an in-memory double, no
// workerd needed" testing discipline (`observer-verification.test.ts`'s own header comment) — the
// `GatekeeperAccountDurableObject` CLASS itself is never instantiated by that test (it only
// exercises routes that either short-circuit on the auth gate, or use a hand-built `ctx.exports`
// spy instead of a real DO — see that test file's own header comment), so this stub's `DurableObject`
// base class only needs to exist as an importable symbol, not behave like a real one.
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env
  ) {}
}
