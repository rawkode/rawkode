import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { App } from "./app.js"
import type { AppNotFound, UnexpectedError } from "./errors.js"
import type { EntityId } from "./node.js"

// `AppsRepository` — the App Library backend-implementation stage's domain `Context.Tag` for the
// `App` entity (app.ts), mirroring `NodesRepository` (nodes-repository.ts) field-for-field and for
// the identical reason stated in that file's own header comment: the interface lives in `domain`
// (zero Cloudflare/`typed-storage-effect` dependency) so both `backend` (to provide
// `AppsRepositoryLive`) and test code can depend on the same contract. `AppCodeVersion` (app.ts)
// deliberately has NO repository tag of its own here — it is a versioned content blob keyed by
// `(appId, kind, version)`, the same "backend-internal raw collection, no public domain interface"
// treatment `pages-repository-live.ts`'s `pageDocs` collection gets alongside `PagesRepository`'s
// own `Page` reference-row tag (see `notes-service-live.ts`'s header comment) — nothing outside
// `AppsService`/`AgentEditService` needs to address an `AppCodeVersion` row through a generic
// repository contract, only through those two services' own typed methods.
export class AppsRepository extends Context.Tag("@athenaeum/domain/AppsRepository")<
  AppsRepository,
  {
    readonly get: (appId: EntityId) => Effect.Effect<App, AppNotFound | UnexpectedError>
    readonly put: (app: App) => Effect.Effect<App, UnexpectedError>
    /** Mainline-only (matches `NodesRepository.list`): a pending App (either a wholly new
     *  agent-proposed App, or an already-mainline App with a pending code update in flight — see
     *  app.ts's `App.pending` doc comment) is filtered out here, the one place every mainline App
     *  listing funnels through, exactly mirroring `NodesRepository.list`'s own doc comment. */
    readonly list: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<App>, UnexpectedError>
    /** Mirrors `NodesRepository.delete`'s doc comment precisely: needed both by the mainline
     *  `deleteApp` RPC and by `AgentEditService`'s `revertChanges`/orphan-reap paths (a wholly
     *  new, never-accepted pending App must be fully removable). Never fails on an already-absent
     *  id, same convention. */
    readonly delete: (appId: EntityId) => Effect.Effect<void, UnexpectedError>
  }
>() {}
