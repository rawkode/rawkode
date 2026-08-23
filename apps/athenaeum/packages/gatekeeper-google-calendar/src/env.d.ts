// Module augmentation for `ctx.exports`/`this.ctx.exports` typing — same pattern and rationale as
// `@athenaeum/backend`'s own `env.d.ts` (read as this file's template): `wrangler.jsonc` declares
// `GatekeeperAccountDurableObject` under `new_sqlite_classes` with no explicit `durable_objects`
// binding, reached via `ctx.exports.GatekeeperAccountDurableObject`/`this.ctx.exports
// .GatekeeperAccountDurableObject` (this package's own cross-DO hop, `gatekeeper-account-
// durable-object.ts#addObserver`'s `#resolveObserverAccessToken`).

import type * as MainModule from "./worker.js"

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof MainModule
      durableNamespaces: "GatekeeperAccountDurableObject"
    }
  }
}

export {}
