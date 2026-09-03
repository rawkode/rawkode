import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { NodeNotFound, UnexpectedError } from "./errors.js"
import type { EntityId, Node } from "./node.js"

// The Context.Tag this Phase 0 slice needs (plan §"Effect-TS integration": "Context.Tag per
// service"). Interface only — the real implementation is a `typed-storage-effect` collection
// wrapper composed into `WorkspaceDurableObject`'s Layer (plan §"Storage & domain model": "each
// owning its own typed-storage-effect collections"), which lives in `backend`/
// `typed-storage-effect`, not here. Keeping the tag in `domain` lets both the backend (to
// provide `NodesRepositoryLive`) and any test code (to provide an in-memory double per plan
// §"Testing payoff") depend on the same interface without either depending on the other.
export class NodesRepository extends Context.Tag("@athenaeum/domain/NodesRepository")<
  NodesRepository,
  {
    readonly get: (nodeId: EntityId) => Effect.Effect<Node, NodeNotFound | UnexpectedError>
    readonly put: (node: Node) => Effect.Effect<Node, UnexpectedError>
    readonly list: (
      workspaceId: EntityId
    ) => Effect.Effect<ReadonlyArray<Node>, UnexpectedError>
    /** Phase 3 addition (`AgentEditService`'s `revertChanges`/orphan-reap need to actually delete
     *  a pending `Node` row — see node.ts's `PendingMarker` doc comment): mirrors
     *  `PagesRepository.delete`'s existing precedent (a page can stop existing independent of its
     *  node; here, a *pending* node can stop existing independent of anything else). Never fails
     *  on an already-absent id — deleting something already gone is exactly the state a revert is
     *  trying to reach, same convention as `ChatForkService.revert`. */
    readonly delete: (nodeId: EntityId) => Effect.Effect<void, UnexpectedError>
  }
>() {}
