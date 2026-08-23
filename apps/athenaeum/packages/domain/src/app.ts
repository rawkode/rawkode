import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString, PendingMarker } from "./node.js"

// App Library domain-extension task ("full agent-authored apps with real sandboxed execution via
// Cloudflare Worker Loaders — the same mechanism cloudflare-os's own gadgets use"). Terminology
// note, deliberate and load-bearing: this codebase calls the concept **App**/**Apps**/**App
// Library** throughout, never "gadget" — a rename from cloudflare-os's own vocabulary
// (`packages/workshop-backend/src/overseer.ts`'s `GadgetRecord`/`loadGadgetWorker`/etc.), not an
// oversight. Every doc comment below that cites cloudflare-os's mechanism uses its real
// identifiers (so the citation is checkable against that source), while every *Athenaeum* type
// name uses "App".
//
// Scope for this stage: the `domain` package's schema surface only — entities, RPC wire schemas
// (app-rpc.ts), agent tool schemas (agent-tools.ts's `CreateAppTool`/`UpdateAppCodeTool` pair),
// and `Data.TaggedError`s (errors.ts). No `AppService`/`WorkspaceDurableObject` implementation,
// no Worker Loader wiring, and no web UI exist yet — those are later stages, mirroring every
// prior phase's own "schema-only, wired into the envelope round trip so the backend stage that
// DOES throw/implement this has nothing left to add here" scope note (see e.g. gatekeeper-rpc.ts,
// meeting-rpc.ts's header comments for the identical precedent).
//
// Sandboxing note (why this file exists at all, security-relevance for later stages): an App's
// `server` code runs inside a Worker Loader-isolated dynamic worker
// (`env.LOADER.get(key, async () => workerDef)`, per `overseer.ts`'s `loadGadgetWorker`) with NO
// ambient access to the workspace's own storage, other Apps, or gatekeeper connections unless a
// later stage explicitly, narrowly binds one in — the same capability-scoped discipline
// `cloudflare-os/AGENTS.md`/`REVIEW.md` document ("a resource becomes 'ambient' ... only through
// user or admin configuration ... a gatekeeper must never assert its own ambience"). An App's
// `client` code renders inside a genuinely sandboxed iframe with no arbitrary access to the parent
// page's DOM/storage/cookies. None of that execution/sandboxing machinery is built by this schema
// stage; it is the reason the two code kinds are modeled as separate, independently-versioned
// artifacts below rather than one opaque blob, since the backend stage that DOES load them needs
// to treat `server` and `client` code as distinct trust/execution surfaces from day one.
//
// Explicitly out of scope this pass (per hard constraint, noted here so a future reader doesn't
// wonder why it's missing): no blueprint/template system (`docs/blueprints.md`'s "a blueprint
// lets a user share a gadget's source code so others can create their own gadget instances from
// it" — Athenaeum Apps are created once, not duplicated from a shared template, so there is no
// `AppBlueprint`/version-bundle-for-sharing concept here); no native (iOS/macOS) App execution
// surface (web only this pass, native sandboxed code execution is a materially bigger lift,
// deferred).

/** The two independently-versioned code artifacts an App carries — mirrors cloudflare-os's own
 *  `server.js`/`client.js` file-kind split (`overseer.ts`'s `loadGadgetWorker` only treats files
 *  ending `.js` as modules; the Workshop frontend's own convention further splits those into a
 *  server-side dynamic-worker module vs. a client-side iframe UI bundle — `getGadgetUiBundle`
 *  reads `client.js` specifically). `"server"` is the sandboxed Worker Loader module
 *  (`AppCodeVersion.code` for that kind becomes `overseer.ts`'s `modules["server.js"]` analog);
 *  `"client"` is the iframe-rendered UI bundle. Exported as `AppCodeKind` (not inlined per-field)
 *  so `AppCodeVersion.kind`, every App-related RPC method's `kind` parameter (app-rpc.ts), and the
 *  `UpdateAppCodeTool` input (agent-tools.ts) all share the identical literal union rather than
 *  three independently-typed copies that could silently drift apart. */
export const AppCodeKind = Schema.Literal("client", "server")
export type AppCodeKind = typeof AppCodeKind.Type

/** An App's simple icon — "a simple string — emoji or short identifier" per this task's own
 *  field spec, deliberately NOT a richer `{glyph, color}`-shaped record: an App's identity in the
 *  UI (App Library grid, workspace tab) needs only a single glanceable token, and cloudflare-os's
 *  own closed `OUTPUT_ICONS` enum (`docs/blueprints.md` §"Output Formats") is a heavier mechanism
 *  this codebase's out-of-scope blueprint/format system would need, not something a same-account,
 *  no-blueprint App needs today. Bounded to 1-32 chars (generous enough for an emoji plus a
 *  variation selector or a short slug like `"todo"`, tight enough that a future `AppService`
 *  storing this inline on the `App` row never needs a separate large-value tier for it). */
export const AppIcon = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(32),
  Schema.brand("AppIcon")
)
export type AppIcon = typeof AppIcon.Type

/**
 * The upper bound (bytes, measured as UTF-8-encoded byte length — see `AppCodeTooLarge`'s doc
 * comment in errors.ts for why this is a runtime-checked `Data.TaggedError`, not a `Schema`
 * length constraint) on a single `AppCodeVersion.code` value. Chosen against the plan's own
 * documented Cloudflare DO SQLite ceilings (`plans/i-ve-tried-to-build-proud-thacker.md` §"Storage
 * & domain model": "2MB max row/blob, 100KB max SQL statement") with generous headroom below
 * both: 256 KiB is far more than a hand-written or agent-generated single-file counter/todo-list
 * app needs (this stage's own Verification requirement is exactly such an app, fed through
 * `ModelClientScripted`), while staying small enough that a version history of dozens of edits
 * per App never approaches the 2MB per-row ceiling or forces R2 offload the way large note/meeting
 * blobs do (plan: "Enforce blob-size discipline ... so large content never lands in DO SQLite
 * directly"). A future `AppService` is expected to compare `new TextEncoder().encode(code).length`
 * against this constant before writing a new `AppCodeVersion` row, throwing `AppCodeTooLarge`
 * (errors.ts) rather than a generic `ValidationError` when it's exceeded — the same
 * "well-known, specifically-named conflict" precedent `PendingNameConflict`/`WorkoutImportConflict`
 * already set, deliberately not enforced inside `AppCodeVersion`'s own schema so the exact byte
 * count and limit can be reported back to the caller via typed error fields instead of a bare
 * `ParseError`.
 */
export const MAX_APP_CODE_BYTES = 256 * 1024

/**
 * One App — the workspace-scoped, agent-authored sandboxed application this task's own field
 * list defines verbatim: `{id, workspaceId, title, icon, clientCodeVersion, serverCodeVersion,
 * createdAt, updatedAt, pending?: PendingMarker}`.
 *
 * `clientCodeVersion`/`serverCodeVersion` are **version-number pointers**, not embedded code —
 * mirrors cloudflare-os's own `storage.codeVersion` counter (`overseer.ts`'s `loadGadgetWorker`:
 * `let codeVersion = \`${this.storage.codeVersion.get()}\`\`), adapted to Athenaeum's per-App,
 * per-kind granularity. `0` means "no code of that kind has ever been written" (an App can exist
 * — titled, iconed — with no server or client code yet, exactly as a freshly-`createGadget`'d
 * cloudflare-os gadget starts with an empty file map); a positive value is the current *mainline
 * accepted* version number, resolved against the `AppCodeVersion` collection (app.ts) by
 * `(appId, kind, version)`. The actual code lives in `AppCodeVersion` rows, one per version, never
 * inline here — see that class's own doc comment for the full versioning model and how it carries
 * the provisional/pending mechanism without `AppCodeVersion` itself needing a `pending` field.
 *
 * `pending` (optional, reusing `PendingMarker` verbatim per this task's own instruction) marks
 * this App as having an agent-chat-proposed change awaiting accept/revert — covering BOTH cases
 * uniformly: a wholly agent-created App not yet accepted (mirrors `Node.pending` exactly: the row
 * is real so the chat's own preview works, invisible to mainline `listApps` until accepted), and
 * an already-mainline App with a proposed code update in flight (there is deliberately no second,
 * separate "pending code change" flag — see `AppCodeVersion`'s doc comment for why one `pending`
 * marker per `App` row is sufficient and what it implies about concurrent edits).
 */
export class App extends Schema.Class<App>("App")({
  id: EntityId,
  workspaceId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  icon: AppIcon,
  clientCodeVersion: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  serverCodeVersion: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
  pending: Schema.optional(PendingMarker)
}) {}

/**
 * One immutable, versioned snapshot of an App's client or server code — this task's own field
 * list verbatim: `{id, appId, kind: "client"|"server", version, code: string, createdAt}`.
 *
 * **Versioning model** (the "Decisions stage" this task's own item 2 refers to, made explicit
 * here since no separate decisions document exists to cite): `version` is a positive integer,
 * monotonically increasing per `(appId, kind)` starting at 1 — i.e. an App's `client` and
 * `server` code kinds each have their own independent version sequence, mirroring the two
 * independent `clientCodeVersion`/`serverCodeVersion` pointers on `App` itself. Rows are
 * append-only and never mutated or deleted once written (mirrors cloudflare-os's own blueprint
 * code-version retention: "Old code versions are retained in storage to avoid race conditions
 * during concurrent instantiation", `docs/blueprints.md`) — the exception is a *reverted* pending
 * version (see below), which a future `AgentEditService`-analog is expected to actually delete,
 * since it never became real.
 *
 * **How this carries the accept/revert mechanism without its own `pending` field**: `App`'s
 * `clientCodeVersion`/`serverCodeVersion` pointers name the current *mainline accepted* version
 * number for each kind. A proposed-but-unaccepted code edit is written as a NEW `AppCodeVersion`
 * row whose `version` is one greater than the App's current pointer for that `kind` — its mere
 * existence, ahead of the pointer, IS the "this is pending" signal, exactly the way `overseer.ts`'s
 * own `loadGadgetWorker(gadgetId, chatId)` resolves a chat-specific code view by adding
 * `.{chatId}.{sequence}` on top of the mainline `codeVersion` rather than mutating a separate
 * pending-flag column. Because `App` carries only ONE `pending: PendingMarker` (not one per code
 * kind), only one chat may have an outstanding proposed code change against a given App at a time
 * — a second chat's attempted concurrent edit is expected to fail the same way a second chat's
 * conflicting `createNode`/`createApp` binding name does (`PendingNameConflict`, errors.ts) — so
 * there is never more than one `AppCodeVersion` row ahead of either pointer, and thus never an
 * ambiguity about which row a `mergeChanges`/`revertChanges` call (agent-edit-rpc.ts) should
 * promote or delete. Accepting bumps the relevant pointer(s) on `App` to match and clears
 * `App.pending`; reverting deletes the ahead-of-pointer row(s) and clears `App.pending` — no
 * `AppCodeVersion` row a caller can ever read back is itself ambiguous about being "the accepted
 * one" or "a pending proposal," because that state is entirely a function of comparing its
 * `version` against the parent `App`'s pointer, computed at read time, not stored redundantly on
 * this row.
 */
export class AppCodeVersion extends Schema.Class<AppCodeVersion>("AppCodeVersion")({
  id: EntityId,
  appId: EntityId,
  kind: AppCodeKind,
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  code: Schema.String,
  createdAt: IsoDateTimeString
}) {}
