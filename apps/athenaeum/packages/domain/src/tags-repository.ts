import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { TagNotFound, UnexpectedError } from "./errors.js"
import type { EntityId } from "./node.js"
import type { Tag } from "./tag.js"

// Same `Context.Tag` pattern as `NodesRepository` (nodes-repository.ts): get/put/list(workspaceId).
// `Tag` itself (see tag.ts) carries no `workspaceId` field — like `Node`'s own row, storage is
// already workspace-scoped by which `WorkspaceDurableObject` instance owns the collection — but `list`
// still takes `workspaceId` for interface symmetry with `NodesRepository` and because it's the read
// path the `graph_tags` view (view-spec.ts's `GraphViewName`) compiles down to: "give me every
// tag in this workspace."
export class TagsRepository extends Context.Tag("@athenaeum/domain/TagsRepository")<
  TagsRepository,
  {
    readonly get: (tagId: EntityId) => Effect.Effect<Tag, TagNotFound | UnexpectedError>
    readonly put: (tag: Tag) => Effect.Effect<Tag, UnexpectedError>
    readonly list: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Tag>, UnexpectedError>
  }
>() {}
