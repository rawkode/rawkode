// Adapts `typed-storage-effect`'s Effect-wrapped DO-SQLite collection to `@athenaeum/domain`'s
// `AppsRepository` `Context.Tag` interface — the App Library counterpart of
// `nodes-repository-live.ts#makeNodesRepositoryLive`, following that file's exact pattern
// (including its `list` mainline-pending-filter discipline, verbatim rationale reused below).

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { App, AppNotFound, AppsRepository, UnexpectedError } from "@athenaeum/domain"
import type { AppCollections } from "./app-collections.js"
import { reviveApp, toUnexpectedError } from "./app-collections.js"

/** `AppsRepositoryLive`: the domain `Context.Tag` implementation, backed by `collections.apps`.
 *  A plain `Layer.succeed` (no resource acquisition of its own — `collections` is already live by
 *  the time this is called), mirroring `makeNodesRepositoryLive`'s own doc comment precisely. */
export const makeAppsRepositoryLive = (collections: AppCollections): Layer.Layer<AppsRepository> =>
  Layer.succeed(AppsRepository, {
    get: (appId) =>
      collections.apps.get(appId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap(
          (maybeApp): Effect.Effect<App, AppNotFound | UnexpectedError> =>
            maybeApp === undefined ? Effect.fail(new AppNotFound({ appId })) : reviveApp(maybeApp)
        )
      ),
    put: (app) => collections.apps.put(app).pipe(Effect.mapError(toUnexpectedError), Effect.as(app)),
    list: (workspaceId) =>
      collections.apps.byWorkspaceId.get(workspaceId).pipe(
        Effect.mapError(toUnexpectedError),
        Effect.flatMap((rawApps) => Effect.forEach(rawApps, reviveApp)),
        // Mainline `listApps` must never surface an agent chat's not-yet-accepted pending App
        // (a wholly new proposed App, or an already-mainline App with a pending code update in
        // flight — see `App.pending`'s own doc comment) — this is the one place every mainline
        // App listing funnels through, matching `NodesRepository.list`'s identical discipline.
        Effect.map((apps) => apps.filter((app) => app.pending === undefined))
      ),
    delete: (appId) => collections.apps.delete(appId).pipe(Effect.mapError(toUnexpectedError), Effect.asVoid)
  })
