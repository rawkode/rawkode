import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Edge } from "./edge.js"
import type { EdgeNotFound, UnexpectedError } from "./errors.js"
import type { EntityId } from "./node.js"

// Same `Context.Tag` pattern as `NodesRepository` — get/put/list(workspaceId). Per edge.ts /
// Evolution Rule #3, backlinks (target→edges) are a *query* over this same collection, not a
// separate repository — `list(workspaceId)` plus a `ViewSpec` filter on `targetNodeId` is how a
// backend service computes them, no `getBacklinks` method needed here.
export class EdgesRepository extends Context.Tag("@athenaeum/domain/EdgesRepository")<
  EdgesRepository,
  {
    readonly get: (edgeId: EntityId) => Effect.Effect<Edge, EdgeNotFound | UnexpectedError>
    readonly put: (edge: Edge) => Effect.Effect<Edge, UnexpectedError>
    readonly list: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Edge>, UnexpectedError>
    /** Phase 3 addition — see `NodesRepository.delete`'s doc comment for the rationale
     *  (`AgentEditService`'s `revertChanges`/orphan-reap on a pending `Edge`). */
    readonly delete: (edgeId: EntityId) => Effect.Effect<void, UnexpectedError>
  }
>() {}
