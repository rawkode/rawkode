// `AppsService` — the App Library's mainline/direct CRUD surface (app-rpc.ts's own header
// comment: "the direct/mainline write&read path... never takes a chatId and never produces a
// pending row"). Backend-internal `Context.Tag` (same rationale as `GraphService`/`NotesService`'s
// own header comments: this is orchestration — business rules like `MAX_APP_CODE_BYTES`
// enforcement and the version-pointer bookkeeping have no home in `domain`'s storage-agnostic
// `AppsRepository` interface). The agent-facing, always-pending counterpart
// (`createAppTool`/`updateAppCodeTool`) lives on `AgentEditService` instead — see
// `agent-edit-service-live.ts`'s own additions for that path, and app.ts's `AppCodeVersion` doc
// comment for the shared versioning model both paths write into.
//
// Six methods, exactly app-rpc.ts's six schema pairs: `createApp`, `updateAppCode`, `listApps`,
// `getApp`, `getAppCode`, `deleteApp`. `requireRoleForGovernedWorkspace` gating is applied by
// `workspace-durable-object.ts`'s RPC shim for each, per that file's own established discipline —
// not duplicated here (mirrors every other backend service in this codebase: `GraphService`,
// `NotesService`, etc. are never themselves aware of the caller's role).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  App,
  AppCodeTooLarge,
  AppCodeVersion,
  AppCodeVersionNotFound,
  AppsRepository,
  EntityId,
  IsoDateTimeString,
  MAX_APP_CODE_BYTES,
  UnexpectedError,
  ValidationError,
  type AppCodeKind,
  type AppIcon,
  type DomainError
} from "@athenaeum/domain"
import type { AppCollections } from "./app-collections.js"
import { appCodeVersionKey, appCodeVersionKeyOf, reviveAppCodeVersion, toUnexpectedError } from "./app-collections.js"

const nowIso = (): IsoDateTimeString => Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())

const pointerForKind = (app: App, kind: AppCodeKind): number =>
  kind === "client" ? app.clientCodeVersion : app.serverCodeVersion

const withPointer = (app: App, kind: AppCodeKind, version: number): App =>
  new App(
    kind === "client"
      ? { ...app, clientCodeVersion: version, revision: app.revision + 1, acceptedRevision: app.revision + 1, updatedAt: nowIso() }
      : { ...app, serverCodeVersion: version, revision: app.revision + 1, acceptedRevision: app.revision + 1, updatedAt: nowIso() }
  )

/** UTF-8-encoded byte length check against `MAX_APP_CODE_BYTES` (app.ts's own doc comment on why
 *  this is a runtime check, not a `Schema` length constraint). Shared by `AppsService.updateAppCode`
 *  (below) and `AgentEditService.updateAppCodeTool` (agent-edit-service-live.ts) — the one
 *  App-specific business rule both the mainline and agent-facing write paths must enforce
 *  identically. */
export const checkAppCodeSize = (appId: EntityId, kind: AppCodeKind, code: string): Effect.Effect<void, AppCodeTooLarge> => {
  const sizeBytes = new TextEncoder().encode(code).length
  return sizeBytes > MAX_APP_CODE_BYTES
    ? Effect.fail(new AppCodeTooLarge({ appId, kind, sizeBytes, maxBytes: MAX_APP_CODE_BYTES }))
    : Effect.void
}

export class AppsService extends Context.Tag("@athenaeum/backend/AppsService")<
  AppsService,
  {
    readonly createApp: (
      workspaceId: EntityId,
      title: string,
      icon: AppIcon,
      id?: EntityId
    ) => Effect.Effect<App, DomainError>
    readonly updateAppCode: (
      workspaceId: EntityId,
      appId: EntityId,
      kind: AppCodeKind,
      code: string
    ) => Effect.Effect<{ app: App; codeVersion: AppCodeVersion }, DomainError>
    readonly listApps: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<App>, DomainError>
    readonly getApp: (workspaceId: EntityId, appId: EntityId) => Effect.Effect<App, DomainError>
    readonly getAppCode: (
      workspaceId: EntityId,
      appId: EntityId,
      kind: AppCodeKind,
      version?: number
    ) => Effect.Effect<AppCodeVersion, DomainError>
    readonly deleteApp: (workspaceId: EntityId, appId: EntityId) => Effect.Effect<boolean, DomainError>
  }
>() {}

export const makeAppsServiceLive = (collections: AppCollections): Layer.Layer<AppsService, never, AppsRepository> =>
  Layer.effect(
    AppsService,
    Effect.gen(function* () {
      const appsRepository = yield* AppsRepository

      /** Deletes every `AppCodeVersion` row under `appId`, both kinds, every version — the
       *  cascade `deleteApp` needs (an App's code history has no independent existence once the
       *  App itself is gone) and the identical cascade `AgentEditService`'s orphan-reap path needs
       *  for a never-accepted pending App (see that file's own `reconcilePendingChanges`
       *  additions). Exported implicitly via `deleteApp` below; kept private here since no other
       *  consumer of `AppsService` needs it directly. */
      const deleteAllCodeVersions = (appId: EntityId): Effect.Effect<void, UnexpectedError> =>
        collections.appCodeVersions.byAppId.get(appId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveAppCodeVersion)),
          Effect.flatMap((rows) =>
            Effect.forEach(
              rows,
              (row) => collections.appCodeVersions.delete(appCodeVersionKey(row)).pipe(Effect.mapError(toUnexpectedError)),
              { discard: true }
            )
          )
        )

      const maxVersionForKind = (appId: EntityId, kind: AppCodeKind): Effect.Effect<number, UnexpectedError> =>
        collections.appCodeVersions.byAppIdKind.get(`${appId}:${kind}`).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveAppCodeVersion)),
          Effect.map((rows) => rows.reduce((max, row) => Math.max(max, row.version), 0))
        )

      return {
        createApp: (workspaceId, title, icon, id) =>
          Effect.gen(function* () {
            if (id === undefined) {
              return yield* Effect.fail(new ValidationError({ message: "createApp requires a stable caller-supplied app id; migrate the caller to the intent API." }))
            }
            const now = nowIso()
            const app = new App({
              id,
              workspaceId,
              title,
              icon,
              clientCodeVersion: 0,
              serverCodeVersion: 0,
              revision: 1,
              acceptedRevision: 1,
              createdAt: now,
              updatedAt: now
            })
            return yield* appsRepository.put(app)
          }),

        updateAppCode: (workspaceId, appId, kind, code) =>
          Effect.gen(function* () {
            const app = yield* appsRepository.get(appId)
            if (app.workspaceId !== workspaceId) {
              return yield* Effect.fail(new ValidationError({ message: "App does not belong to the requested workspace." }))
            }
            if (app.pending !== undefined) {
              return yield* Effect.fail(
                new ValidationError({
                  message: `App ${appId} has a pending change awaiting accept/revert from chat ${app.pending.chatId}; ` +
                    "resolve it before editing mainline code directly."
                })
              )
            }
            yield* checkAppCodeSize(appId, kind, code)
            const currentMax = yield* maxVersionForKind(appId, kind)
            const currentPointer = pointerForKind(app, kind)
            if (currentMax !== currentPointer) {
              return yield* Effect.fail(new ValidationError({
                message: `App ${appId} has an ahead-of-pointer ${kind} code version; reconcile that pending history before editing mainline code.`
              }))
            }
            const newVersion = currentPointer + 1
            const codeVersion = new AppCodeVersion({
              id: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
              appId,
              kind,
              version: newVersion,
              code,
              createdAt: nowIso()
            })
            yield* collections.appCodeVersions.put(codeVersion).pipe(Effect.mapError(toUnexpectedError))
            const updatedApp = yield* appsRepository.put(withPointer(app, kind, newVersion))
            return { app: updatedApp, codeVersion }
          }),

        listApps: (workspaceId) => appsRepository.list(workspaceId),

        getApp: (workspaceId, appId) => appsRepository.get(appId).pipe(
          Effect.flatMap((app) => app.workspaceId === workspaceId
            ? Effect.succeed(app)
            : Effect.fail(new ValidationError({ message: "App does not belong to the requested workspace." })))
        ),

        getAppCode: (workspaceId, appId, kind, version) =>
          Effect.gen(function* () {
            const app = yield* appsRepository.get(appId)
            if (app.workspaceId !== workspaceId) {
              return yield* Effect.fail(new ValidationError({ message: "App does not belong to the requested workspace." }))
            }
            const resolvedVersion = version ?? pointerForKind(app, kind)
            if (resolvedVersion === 0) {
              return yield* Effect.fail(new AppCodeVersionNotFound({ appId, kind, version: 0 }))
            }
            const key = appCodeVersionKeyOf({ appId, kind, version: resolvedVersion })
            const raw = yield* collections.appCodeVersions.get(key).pipe(Effect.mapError(toUnexpectedError))
            if (raw === undefined) {
              return yield* Effect.fail(new AppCodeVersionNotFound({ appId, kind, version: resolvedVersion }))
            }
            return yield* reviveAppCodeVersion(raw)
          }),

        deleteApp: (workspaceId, appId) =>
          Effect.gen(function* () {
            const app = yield* appsRepository.get(appId)
            if (app.workspaceId !== workspaceId) {
              return yield* Effect.fail(new ValidationError({ message: "App does not belong to the requested workspace." }))
            }
            if (app.pending !== undefined) {
              return yield* Effect.fail(new ValidationError({ message: "A pending App cannot be deleted from the mainline." }))
            }
            yield* deleteAllCodeVersions(appId)
            yield* appsRepository.delete(appId)
            return true
          })
      }
    })
  )
