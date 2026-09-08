// `AppRuntimeService` — the App Library's real sandboxed-execution mechanism (this stage's own
// task: "An AppRuntimeService that loads an app's server.js via env.LOADER.get() with the
// capability-scoped env the Decisions stage designed — no ambient workspace access"). This is the
// SAME mechanism `cloudflare-os/packages/workshop-backend/src/overseer.ts`'s `loadGadgetWorker`
// uses (`this.env.LOADER.get(key, async () => workerDef)`, `worker_loaders: [{"binding":
// "LOADER"}]` in that package's own `wrangler.jsonc`) — adapted, not copied verbatim, to
// Athenaeum's simpler single-App-per-key shape (no Yjs/multi-gadget-workpiece system, no
// chat-scoped preview branch: this stage only ever loads an App's MAINLINE accepted `server` code
// — see this file's own header comment below for why that narrowing is deliberate, not an
// oversight).
//
// **Security boundary — the load-bearing property this whole file exists to guarantee**: the
// `env` object handed to a loaded App Worker (`buildAppWorkerCode` below) is a bare `{}`. Not
// "every workspace service except a sensitive one" — literally nothing. An App's sandboxed
// `server` code has:
//   - NO reference to this workspace's `NodesRepository`/`AppsRepository`/any other App's code —
//     none of that ever crosses into `WorkerLoaderWorkerCode.env`, so there is nothing for the
//     sandboxed code to even attempt to call.
//   - NO network egress: `globalOutbound: null` (the exact same value
//     `overseer.ts#loadGadgetWorker` sets) disables the loaded Worker's global `fetch()` entirely.
//     A future capability-grant stage (out of scope this pass, see `app.ts`'s header comment on
//     what's deliberately not built yet) would widen this per-App, narrowly, the same way
//     `overseer.ts#getEnvForLoader` adds one named binding per approved gatekeeper edge — never by
//     defaulting a whole class of App open.
//   - Its OWN, separate module-scope state per `(workspaceId, appId, serverCodeVersion)` isolate
//     key: two different Apps (or the same App before/after a code edit) never share a running
//     Worker instance, so in-memory state (e.g. a demo counter closed over at module scope) never
//     leaks across Apps.
//
// This is "capability-scoped, never ambient" applied at its strictest: not just "no
// automatically-widening ambient resource" (`cloudflare-os/AGENTS.md`'s framing) but *zero*
// bindings of any kind until a future stage deliberately adds one.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { AppsService } from "./apps-service-live.js"
import { AppCodeVersionNotFound, EntityId, UnexpectedError, type DomainError } from "@athenaeum/domain"

/**
 * The compatibility date every loaded App Worker runs under. Fixed (not derived from the host
 * Worker's own `wrangler.jsonc` at runtime — there is no API to read that from inside a Worker),
 * and deliberately no later than this package's own `compatibility_date` (`wrangler.jsonc`:
 * `"2026-02-02"`) — a dynamically-loaded Worker's compatibility date must not outrun the host
 * runtime's. Mirrors `overseer.ts#loadGadgetWorker`'s own `"2026-02-01"` (one day behind ITS
 * host's `"2026-02-02"`, the same one-step-behind discipline, applied against Athenaeum's own
 * host date instead).
 */
const APP_WORKER_COMPATIBILITY_DATE = "2026-02-01"

/**
 * Builds the key `env.LOADER.get(name, getCode)` uses to identify a loaded App Worker instance.
 * Includes `workspaceId` (defense-in-depth namespacing — App ids are already globally-unique
 * UUIDs/ULIDs, so this can't actually collide across workspaces, but a key that's visibly
 * workspace-qualified is easier to reason about than one relying solely on that uniqueness) and
 * `serverCodeVersion` (mirrors `overseer.ts#loadGadgetWorker`'s own `codeVersion`-in-key
 * discipline: editing an App's server code must load a FRESH Worker instance, with fresh
 * module-scope state, never the previous version's still-warm isolate).
 */
const appLoaderKey = (workspaceId: EntityId, appId: EntityId, serverCodeVersion: number): string =>
  `athenaeum-app.${workspaceId}.${appId}.${serverCodeVersion}`

export class AppRuntimeService extends Context.Tag("@athenaeum/backend/AppRuntimeService")<
  AppRuntimeService,
  {
    /**
     * Loads (or reuses an already-running instance of) `appId`'s current MAINLINE `server` code
     * and dispatches `request` into it, returning whatever `Response` the sandboxed code itself
     * produces. Fails `AppNotFound` if the App doesn't exist, `AppCodeVersionNotFound` if it has
     * no `server` code yet (`serverCodeVersion` pointer is still `0`).
     *
     * **Deliberately mainline-only, no `chatId` parameter** — unlike `overseer.ts#loadGadgetWorker`,
     * which can load a chat's proposed-but-unaccepted code for live preview
     * (`chatId`/`sequence`-suffixed loader key), this stage's `AppRuntimeService` only ever
     * executes the ACCEPTED, promoted `server` code. Running not-yet-reviewed agent-proposed
     * server code against a real request is a materially bigger security surface (arbitrary
     * unreviewed code, executing for real, before a human ever looked at it) than this stage's own
     * scope covers — noted here as explicit future work (a chat-preview execution path would need
     * its own, probably-more-restricted, sandbox policy — e.g. an even tighter resource limit —
     * not just reuse of this same unrestricted-by-that-axis path), not an oversight.
     */
    readonly runRequest: (
      workspaceId: EntityId,
      appId: EntityId,
      request: Request
    ) => Effect.Effect<Response, DomainError>
  }
>() {}

/**
 * The real Layer — a genuine `WorkerLoader` binding (`env.LOADER`), real dynamically-loaded
 * Worker isolates, no mocking. Depends on `AppsService` (already provided by
 * `workspace-durable-object.ts`'s `repositoriesLayer`-derived `appsServiceLive`) to resolve an
 * App's current mainline `server` code before constructing the `WorkerLoaderWorkerCode` — reuses
 * `AppsService.getApp`/`getAppCode` rather than reading `AppsRepository`/`appCodeVersions`
 * directly, so this service never needs to re-derive the version-pointer resolution logic
 * `AppsService` already owns.
 */
export const makeAppRuntimeServiceLive = (loader: WorkerLoader): Layer.Layer<AppRuntimeService, never, AppsService> =>
  Layer.effect(
    AppRuntimeService,
    Effect.gen(function* () {
      const apps = yield* AppsService

      const runRequest = (
        workspaceId: EntityId,
        appId: EntityId,
        request: Request
      ): Effect.Effect<Response, DomainError> =>
        Effect.gen(function* () {
          const app = yield* apps.getApp(workspaceId, appId)
          if (app.serverCodeVersion === 0) {
            return yield* Effect.fail(new AppCodeVersionNotFound({ appId, kind: "server", version: 0 }))
          }
          const codeVersion = yield* apps.getAppCode(workspaceId, appId, "server")

          const stub = loader.get(appLoaderKey(workspaceId, appId, codeVersion.version), async () => ({
            compatibilityDate: APP_WORKER_COMPATIBILITY_DATE,
            mainModule: "server.js",
            modules: {
              "server.js": codeVersion.code
            },
            // See this file's header comment: this is the ENTIRE capability surface a sandboxed
            // App's server code receives. Empty, deliberately — no ambient access to this
            // workspace's storage, no access to any other App, nothing. A future capability-grant
            // stage would add named entries here, one at a time, per explicit App/gatekeeper
            // binding — never widen this default.
            env: {},
            // Disables the loaded Worker's global `fetch()` outright — an App's sandboxed server
            // code gets no network egress by default (same value
            // `overseer.ts#loadGadgetWorker` sets for the identical reason).
            globalOutbound: null
          }))

          const entrypoint = stub.getEntrypoint()
          return yield* Effect.tryPromise({
            try: () => entrypoint.fetch(request),
            catch: (cause) =>
              new UnexpectedError({
                message: `App ${appId} server code threw while handling the request: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`
              })
          })
        })

      return { runRequest }
    })
  )

/** Fail-closed fallback for when `env.LOADER` is unset (should not happen once `wrangler.jsonc`'s
 *  `worker_loaders` binding is configured — see that file's own comment — but every other optional
 *  binding in this codebase follows this same "real client, cleanly unconfigured, fails per call"
 *  shape, e.g. `CalendarGatekeeperClientUnconfigured`/`MeetingAudioBucketUnconfigured`, so
 *  `AppRuntimeService` does too rather than crashing DO construction). */
export const AppRuntimeServiceUnconfigured: Layer.Layer<AppRuntimeService> = Layer.succeed(AppRuntimeService, {
  runRequest: () =>
    Effect.fail(new UnexpectedError({ message: "The LOADER (Worker Loader) binding is not configured on this deployment." }))
})
