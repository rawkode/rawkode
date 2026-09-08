// `ViewsService` — the RPC-facing surface for `runView` (task item 4) and `searchNodes` (task
// item 5), backed entirely by `read-model.ts`'s compiler/executor. Backend-internal (same
// rationale as `GraphService`/`NotesService`/`SyncFeedService` — orchestration, not a
// storage-agnostic domain repository), and deliberately stateless (`Layer.succeed`, not
// `Layer.effect`): unlike `GraphServiceLive`/`NotesServiceLive`, this service holds no in-memory
// caches of its own — every call goes straight through to DO SQLite via `read-model.ts` — so
// there's no `ManagedRuntime`-vs-per-call-`Layer.provide` correctness hazard here the way there
// was for those two (see `workspace-durable-object.ts`'s constructor doc comment for that history).
//
// **Adversarial-review fix — `CalendarService#hiddenCalendarDerivedNodeIds` enforcement**: this
// service used to have zero awareness of that exclusion set at all, even though
// `workspace-durable-object.ts`'s `listNodes`/`getNode`/`listCalendarEvents` all correctly filtered
// on it — a live probe confirmed a denied observer, correctly excluded from those three, could
// still see a hidden calendar-derived node's raw `{nodeId, tagId}` via
// `runView("graph_node_tags", {visibleColumns:["nodeId","tagId"]})`, because `graph_node_tags`
// (unlike `graph_nodes`/`graph_facts`/`graph_text_search`) IS populated for calendar-derived
// nodes today (`graph-service-live.ts#assignTag` writes `rm_node_tags` unconditionally — see
// `calendar-service-live.ts#findOrCreatePersonNode`'s own doc comment for the separate,
// independently-real completeness gap this sits next to: calendar-derived nodes are never
// `upsertNode`/`indexNodeText`'d, so `graph_nodes`/search miss them entirely for EVERY viewer,
// even the owner — fixing THAT gap without also gating here would have silently turned this into
// a full title/content leak). Fixed by centralizing the filter at the read-model layer
// (`read-model.ts`'s `NODE_ID_COLUMNS`/`filterAndStripHiddenNodeRows`) rather than special-casing
// `graph_node_tags`: `runView`/`searchNodes` below now both REQUIRE the caller
// (`workspace-durable-object.ts`) to pass `CalendarService#hiddenCalendarDerivedNodeIds`'s result,
// the exact same set/computation `listNodes`/`getNode` already use — see those two RPC methods'
// own call sites for the identical pattern this mirrors.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { type EntityId, type GraphViewName, type UnexpectedError, type ValidationError, type ViewSpec } from "@athenaeum/domain"
import { compileRunView, filterAndStripHiddenNodeRows, runCompiledQuery, searchNodesReadModel } from "./read-model.js"

export interface SearchResultRow {
  readonly nodeId: EntityId
  readonly title: string
  readonly snippet: string
}

export class ViewsService extends Context.Tag("@athenaeum/backend/ViewsService")<
  ViewsService,
  {
    /**
     * `hiddenNodeIds` — adversarial-review fix (see this file's header comment and `read-
     * model.ts`'s `NODE_ID_COLUMNS`/`filterAndStripHiddenNodeRows` doc comments for the full
     * story): the caller MUST pass `CalendarService#hiddenCalendarDerivedNodeIds`'s result here,
     * exactly the same set `workspace-durable-object.ts`'s `listNodes`/`getNode`/`listCalendarEvents`
     * already compute and filter on. This is now a required parameter, not an optional add-on —
     * the previous shape (no such parameter existed at all) is exactly what let a denied observer
     * see a hidden calendar-derived node's raw id via `runView("graph_node_tags", ...)` even
     * though `listNodes`/`getNode` correctly excluded it.
     */
    readonly runView: (
      workspaceId: EntityId,
      viewName: GraphViewName,
      viewSpec: ViewSpec,
      hiddenNodeIds: ReadonlySet<EntityId>
    ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, ValidationError | UnexpectedError>
    readonly searchNodes: (
      workspaceId: EntityId,
      query: string,
      limit: number,
      hiddenNodeIds: ReadonlySet<EntityId>
    ) => Effect.Effect<ReadonlyArray<SearchResultRow>, ValidationError | UnexpectedError>
  }
>() {}

/** A short plain-text excerpt around the start of a matched page body — real (not stubbed)
 *  truncation, though not (yet) centered on the actual match offset the way a production search
 *  UI's highlighted snippet would be; FTS5's own `snippet()` auxiliary function would be the next
 *  step there and was deliberately not reached for here to keep this stage's scope to what the
 *  task actually asks to verify ("search returns correct results... across at least two nodes"),
 *  not polished snippet highlighting. */
const snippetOf = (body: string, maxLength = 160): string =>
  body.length <= maxLength ? body : `${body.slice(0, maxLength)}…`

export const makeViewsServiceLive = (sql: SqlStorage): Layer.Layer<ViewsService> =>
  Layer.succeed(ViewsService, {
    runView: (workspaceId, viewName, viewSpec, hiddenNodeIds) =>
      Effect.gen(function* () {
        // Every view is already workspace-scoped by which `WorkspaceDurableObject` instance owns this
        // SQLite database — `workspaceId` is accepted for interface symmetry with every other RPC
        // method here (which all take it, checked against `ctx.id.name` by
        // `workspace-durable-object.ts`'s `requireOwnWorkspace` before this is ever called), not used to
        // filter rows a second time.
        void workspaceId
        const compiled = yield* compileRunView(viewName, viewSpec)
        const rows = yield* runCompiledQuery(sql, compiled)
        // Adversarial-review fix — see this interface's own doc comment on `hiddenNodeIds`.
        return filterAndStripHiddenNodeRows(rows, compiled, hiddenNodeIds)
      }),
    searchNodes: (workspaceId, query, limit, hiddenNodeIds) =>
      Effect.gen(function* () {
        void workspaceId
        const rows = yield* searchNodesReadModel(sql, query, limit)
        // Same fix, applied to FTS results: `SearchRow.nodeId` is always present here (unlike
        // `runView`'s per-view column shape), so no alias/strip machinery is needed — a plain
        // membership filter against the same `hiddenNodeIds` set suffices.
        const visible = hiddenNodeIds.size === 0 ? rows : rows.filter((row) => !hiddenNodeIds.has(row.nodeId as EntityId))
        return visible.map((row) => ({
          nodeId: row.nodeId as EntityId,
          title: row.title,
          snippet: snippetOf(row.body)
        }))
      })
  })
