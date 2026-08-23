import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { RelationDefinitionNotFound, UnexpectedError } from "./errors.js"
import type { EntityId } from "./node.js"
import type { RelationDefinition } from "./relation-definition.js"

// Same `Context.Tag` pattern as `NodesRepository` — get/put/list(workspaceId). `list(workspaceId)`
// feeds the `graph_relation_definitions` view.
export class RelationDefinitionsRepository extends Context.Tag(
  "@athenaeum/domain/RelationDefinitionsRepository"
)<
  RelationDefinitionsRepository,
  {
    readonly get: (
      relationDefinitionId: EntityId
    ) => Effect.Effect<RelationDefinition, RelationDefinitionNotFound | UnexpectedError>
    readonly put: (
      relationDefinition: RelationDefinition
    ) => Effect.Effect<RelationDefinition, UnexpectedError>
    readonly list: (
      workspaceId: EntityId
    ) => Effect.Effect<ReadonlyArray<RelationDefinition>, UnexpectedError>
  }
>() {}
