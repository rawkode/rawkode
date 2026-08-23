import * as Schema from "effect/Schema"
import { App, AppCodeKind, AppCodeVersion, AppIcon } from "./app.js"
import { EntityId, IsoDateTimeString } from "./node.js"

// App Library domain-extension task, item 3: "RPC schemas: createApp, updateAppCode, listApps,
// getApp, deleteApp, getAppCode." Same one-`Schema.Class`-input/output-pair-per-method convention
// as rpc.ts/graph-rpc.ts/gatekeeper-rpc.ts. Schema-only — no `AppService`/`WorkspaceDurableObject`
// implementation exists yet, same explicit scope note every prior domain-extension stage's own
// header comment carries (see e.g. gatekeeper-rpc.ts's).
//
// **These six methods are the direct/mainline write&read path**, used by a caller acting outside
// any agent chat (e.g. a future web "App Library" UI editing an App's code directly) — they never
// take a `chatId` and never produce a `pending` row, mirroring `rpc.ts`'s `CreateNodeInput`/
// `graph-rpc.ts`'s `AddFactInput` precedent exactly (those, too, have no `chatId` and always write
// mainline). The parallel agent-facing path (`CreateAppTool`/`UpdateAppCodeTool`, agent-tools.ts)
// is the one that takes a `chatId` + chat-local `binding` and produces `App.pending`/an
// ahead-of-pointer `AppCodeVersion` row — see app.ts's `AppCodeVersion` doc comment for the full
// versioning/pending mechanism both paths share.
//
// **Every method below is workspace-scoped** (`workspaceId: EntityId`), and — per this task's hard
// constraint — every one of these RPC methods, once a real `WorkspaceDurableObject` implementation
// exists, MUST call `requireRoleForGovernedWorkspace` exactly like every other governed-workspace
// RPC method already does (`workspace-durable-object.ts`'s established Phase 4 discipline: "EVERY
// new mutating/reading RPC method on a governed workspace MUST call the same
// requireRoleForGovernedWorkspace gate... no exceptions"). That gating is NOT implemented in this
// domain-only stage, for the identical reason every prior domain-extension stage's schemas predate
// their service (`requireRoleForGovernedWorkspace` lives in `backend`, a Cloudflare-dependent
// package `@athenaeum/domain` never imports). Recommended role split, so the next stage has an
// unambiguous answer ready: `createApp`/`updateAppCode`/`deleteApp` are mutations that change what
// sandboxed code a workspace runs → `"build"` (mirrors `createRelationDefinition`/
// `connectGoogleCalendar`'s existing `"build"` gating for structural/capability-widening
// mutations); `listApps`/`getApp`/`getAppCode` are reads → `"use"` (mirrors `listNodes`/
// `listCalendarEvents`'s existing `"use"` gating).

/** Creates a new, codeless App (mirrors cloudflare-os's own `createGadget`: a fresh gadget starts
 *  with an empty file map — `title`/`icon` are set immediately, `clientCodeVersion`/
 *  `serverCodeVersion` start at `0` until a subsequent `updateAppCode` call writes the first
 *  version of either kind). `id` is optional and caller-supplied only for the same deterministic-
 *  id resolution pattern `rpc.ts`'s `CreateNodeInput.id` documents (defaulted server-side via
 *  `crypto.randomUUID()` when absent) — no current Athenaeum caller needs this for Apps, but the
 *  precedent is cheap to keep uniform rather than special-cased away. */
export class CreateAppInput extends Schema.Class<CreateAppInput>("CreateAppInput")({
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  icon: AppIcon,
  id: Schema.optional(EntityId)
}) {}

export class CreateAppOutput extends Schema.Class<CreateAppOutput>("CreateAppOutput")({
  app: App
}) {}

/** Writes a new `AppCodeVersion` for one `kind` and immediately advances the App's matching
 *  pointer (`clientCodeVersion`/`serverCodeVersion`) to it — the mainline/direct path, never
 *  pending (see this file's header comment). Fails `AppNotFound` (errors.ts) if `appId` doesn't
 *  exist in the workspace, `AppCodeTooLarge` if `code`'s UTF-8 byte length exceeds
 *  `MAX_APP_CODE_BYTES` (app.ts). */
export class UpdateAppCodeInput extends Schema.Class<UpdateAppCodeInput>("UpdateAppCodeInput")({
  workspaceId: EntityId,
  appId: EntityId,
  kind: AppCodeKind,
  code: Schema.String
}) {}

export class UpdateAppCodeOutput extends Schema.Class<UpdateAppCodeOutput>("UpdateAppCodeOutput")({
  app: App,
  codeVersion: AppCodeVersion
}) {}

/** Lists every mainline (non-`pending`) App in a workspace — mirrors `ListNodesOutput`'s own
 *  mainline-only read convention; a chat previewing its own pending App creation/edits reads
 *  through a separate future mechanism (mirroring `listNodes` vs. a chat's own pending-inclusive
 *  preview), not this method. */
export class ListAppsInput extends Schema.Class<ListAppsInput>("ListAppsInput")({
  workspaceId: EntityId
}) {}

export class ListAppsOutput extends Schema.Class<ListAppsOutput>("ListAppsOutput")({
  apps: Schema.Array(App)
}) {}

/** Fetches a single App by id. Fails `AppNotFound` if it doesn't exist in the workspace. */
export class GetAppInput extends Schema.Class<GetAppInput>("GetAppInput")({
  workspaceId: EntityId,
  appId: EntityId
}) {}

export class GetAppOutput extends Schema.Class<GetAppOutput>("GetAppOutput")({
  app: App
}) {}

/** Deletes an App and (a future `AppService`'s responsibility, not fixed by this schema) every
 *  `AppCodeVersion` row under it. Fails `AppNotFound` if it doesn't exist in the workspace. */
export class DeleteAppInput extends Schema.Class<DeleteAppInput>("DeleteAppInput")({
  workspaceId: EntityId,
  appId: EntityId
}) {}

export class DeleteAppOutput extends Schema.Class<DeleteAppOutput>("DeleteAppOutput")({
  deleted: Schema.Boolean
}) {}

/** Fetches one `AppCodeVersion` row. `version` is optional and defaults to the App's current
 *  mainline pointer for `kind` (`clientCodeVersion`/`serverCodeVersion`) when omitted — the
 *  common case (a Worker Loader load, or a UI's "view current code" panel). An explicit `version`
 *  lets a caller fetch a specific historical (or, for the owning chat only, pending
 *  ahead-of-pointer) snapshot, mirroring cloudflare-os's own retained-old-versions precedent
 *  (`docs/blueprints.md`: "Old code versions are retained in storage to avoid race conditions").
 *  Fails `AppNotFound` if the App doesn't exist, `AppCodeVersionNotFound` (errors.ts) if `kind`
 *  has no code yet (pointer is `0` and no `version` was given) or the requested `version` doesn't
 *  exist. */
export class GetAppCodeInput extends Schema.Class<GetAppCodeInput>("GetAppCodeInput")({
  workspaceId: EntityId,
  appId: EntityId,
  kind: AppCodeKind,
  version: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)))
}) {}

export class GetAppCodeOutput extends Schema.Class<GetAppCodeOutput>("GetAppCodeOutput")({
  codeVersion: AppCodeVersion
}) {}

/**
 * **Adversarial-review fix** (the one open finding from this task's own security review):
 * `AppLibraryPanel.tsx`'s preview iframe and the App's own sandboxed client-side code had no way
 * to authenticate their `client.js`/`run` HTTP requests on a GOVERNED workspace — every real
 * signed-in user's default workspace — without either (a) leaving those two routes reachable
 * anonymously (widening the hole `requireRoleForGovernedWorkspace` exists to close) or (b) handing
 * the sandboxed iframe the caller's own real session credential, which would let ANY
 * agent-authored App impersonate the user against every other RPC method on this workspace, not
 * just its own `run`/`client.js` routes — a strictly worse hole than the one being fixed.
 *
 * `mintAppRunCredential` closes this the same way `gatekeeper-service-credential.ts` closes the
 * analogous service-to-service gap: a caller who already holds "use" role on `workspaceId` mints a
 * fresh, narrowly-scoped, short-lived credential naming exactly `{workspaceId, appId}` — nothing
 * else. That credential authorizes ONLY `GET .../apps/:appId/client.js` and `.../apps/:appId/
 * run(/...)` for this exact App in this exact workspace (`app-run-credential.ts`'s own header
 * comment has the full verification-side story) — it carries no user identity, no email, and
 * cannot be presented to any other RPC method or any other App/workspace, so a real agent-authored
 * App's client bundle can safely be handed this token (via its `srcDoc` bootstrap, never the
 * user's own session Bearer token) without gaining any capability beyond "run this one App."
 */
export class MintAppRunCredentialInput extends Schema.Class<MintAppRunCredentialInput>("MintAppRunCredentialInput")({
  workspaceId: EntityId,
  appId: EntityId
}) {}

export class MintAppRunCredentialOutput extends Schema.Class<MintAppRunCredentialOutput>("MintAppRunCredentialOutput")({
  credential: Schema.String,
  expiresAt: IsoDateTimeString
}) {}
