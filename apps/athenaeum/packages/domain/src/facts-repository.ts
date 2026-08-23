import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { FactNotFound, UnexpectedError } from "./errors.js"
import type { Fact } from "./fact.js"
import type { EntityId } from "./node.js"

// Same `Context.Tag` pattern as `NodesRepository` — get/put/list(workspaceId). `list(workspaceId)`
// feeds the `graph_facts` view (view-spec.ts's `GraphViewName`); a per-node lookup ("facts for
// this node") is a `ViewSpec` filter (`{op: "eq", field: {kind: "column", column: "nodeId"},
// value: ...}`, see view-spec.ts) compiled against `graph_facts`, not a second repository
// method — keeps this interface as thin as `NodesRepository`'s and pushes filtering logic to
// the one place (the ViewSpec→SQL compiler) the plan designates for it.
export class FactsRepository extends Context.Tag("@athenaeum/domain/FactsRepository")<
  FactsRepository,
  {
    readonly get: (factId: EntityId) => Effect.Effect<Fact, FactNotFound | UnexpectedError>
    readonly put: (fact: Fact) => Effect.Effect<Fact, UnexpectedError>
    readonly list: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Fact>, UnexpectedError>
    /** Phase 3 addition — see `NodesRepository.delete`'s doc comment for the rationale
     *  (`AgentEditService`'s `revertChanges`/orphan-reap on a pending `Fact`). */
    readonly delete: (factId: EntityId) => Effect.Effect<void, UnexpectedError>
  }
>() {}
