import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { BaseTagIds, CreateRelationDefinitionInput, EntityId, type DomainError } from "@athenaeum/domain"
import type { WorkspaceRpcClientService } from "./rpc-client.js"

// Backlinks-demo affordance (task: "seeing at least one backlink appear after creating a related
// node/edge via a quick script or a minimal UI affordance"). `createEdge` needs a real,
// already-existing `RelationDefinition` id — there is no RPC to "find or create a relation
// definition by name" (the domain package doesn't model relation names as unique), so this module
// is that missing piece for the UI's own "+ link a node here" button: reuse one lazily-created
// "mentions"/"mentioned by" relation definition per workspace, cached in `localStorage` (keyed by
// `workspaceId`, since a different workspace means a different DO instance with no memory of any
// previously-created relation definition).
//
// `sourceTagId`/`targetTagId` are required by `RelationDefinition`'s schema (relation-definition.ts)
// but `createEdge` never actually checks that its source/target nodes carry those tags (see
// `graph-service-live.ts`'s `createEdge` — only relation-definition existence and node existence
// are checked); `BaseTagIds.Project` is used here purely because Base Tags always exist in a
// freshly-seeded workspace (`seed-base-tags.ts`), not because "mentions" is semantically Project-only.

const storageKey = (workspaceId: EntityId): string => `athenaeum:mentionsRelationDefinitionId:${workspaceId}`

export const ensureMentionsRelationDefinition = (
  client: WorkspaceRpcClientService,
  workspaceId: EntityId
): Effect.Effect<EntityId, DomainError> =>
  Effect.gen(function* () {
    const cached = window.localStorage.getItem(storageKey(workspaceId))
    if (cached !== null) {
      const decoded = Schema.decodeUnknownOption(EntityId)(cached)
      if (Option.isSome(decoded)) return decoded.value
    }

    const { relationDefinition } = yield* client.createRelationDefinition(
      new CreateRelationDefinitionInput({
        workspaceId,
        forwardName: "mentions",
        inverseName: "mentioned by",
        sourceTagId: BaseTagIds.Project,
        targetTagId: BaseTagIds.Project,
        cardinality: "many-to-many"
      })
    )
    window.localStorage.setItem(storageKey(workspaceId), relationDefinition.id)
    return relationDefinition.id
  })
