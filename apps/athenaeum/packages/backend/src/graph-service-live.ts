// `GraphService` — the plan's diagrammed Effect Service ("Tags/facts/edges/tagClosure,
// ViewSpec→SQL compiler, graphIssues" — the ViewSpec→SQL compiler half is deliberately out of
// scope for this stage, see `graph-rpc.ts`'s "Backend/Views-stage additions" comment for why).
// Backend-internal (not a domain `Context.Tag`): `GraphService` is orchestration — it composes
// several domain repositories, the tag-closure module, and `SyncFeedService`, and contains real
// business logic (cardinality-conflict detection) that has no home in `domain`'s zero-CF/React,
// storage-agnostic repository interfaces. Mirrors `NotesService`'s own placement
// (`notes-service-live.ts`) and the plan's own C4 component diagram, which draws these as
// backend-hosted Effect Services distinct from the `typed-storage-effect`-backed repositories
// they sit on top of.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  CardinalityViolation,
  Edge,
  EdgesRepository,
  Fact,
  FactsRepository,
  GraphIssue,
  GraphIssueDetected,
  GraphIssuesRepository,
  IsoDateTimeString,
  MentionRelationId,
  NodesRepository,
  type PendingMarker,
  RelationCardinality,
  RelationDefinition,
  RelationDefinitionsRepository,
  Tag,
  TagFieldDefinition,
  type TagFieldValueKind,
  TagsRepository,
  UnexpectedError,
  ValidationError,
  tagNameKey,
  tagRevision,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import type { EdgesCollections } from "./edges-repository-live.js"
import { reviveEdge } from "./edges-repository-live.js"
import { reviveTag, toUnexpectedError as tagsToUnexpectedError } from "./tags-repository-live.js"
import type { TagsCollections } from "./tags-repository-live.js"
import { recomputeAndPersistTagClosure, type TagClosureCollections, type TagClosureRow } from "./tag-closure.js"
import { SyncFeedService } from "./sync-feed-service-live.js"
import { isLedgerMutationCapability, type LedgerMutationCapability, type LedgerMutationScope } from "./ledger-mutation-capability.js"
import { nodeTagRowId, nodeTagsToUnexpectedError, type NodeTagsCollections } from "./node-tags-live.js"
import {
  reviveTagFieldDefinition,
  toUnexpectedError as tagFieldDefinitionsToUnexpectedError,
  type TagFieldDefinitionsCollections
} from "./tag-field-definitions-live.js"
import {
  deleteEdge,
  deleteNodeTag,
  replaceAllTagClosure,
  replaceTagParents,
  upsertEdge,
  upsertFact,
  upsertGraphIssue,
  upsertNodeTag,
  upsertRelationDefinition,
  upsertTag
} from "./read-model.js"

/** Cardinalities where a single source node may have at most one outgoing edge for a given
 *  `RelationDefinition` — the plan's own worked example: "two concurrent createEdge calls both
 *  trying to set the single allowed edge for a 'one-to-one'/'many-to-one' relation from the same
 *  source node." (`one-to-many`/`many-to-many` place no such cap on the source side.) */
const isMaxOneFromSource = (cardinality: RelationCardinality): boolean =>
  cardinality === "one-to-one" || cardinality === "many-to-one"

const validateTagDag = (tags: ReadonlyArray<Tag>): Effect.Effect<void, DomainError> =>
  Effect.gen(function* () {
    const byId = new Map(tags.map((tag) => [tag.id, tag]))
    for (const tag of tags) {
      if (new Set(tag.parentIds).size !== tag.parentIds.length) return yield* Effect.fail(new ValidationError({ message: "Supertag parents must be unique." }))
      for (const parentId of tag.parentIds) if (parentId === tag.id || !byId.has(parentId)) {
        return yield* Effect.fail(new ValidationError({ message: "Supertag parents must exist and cannot include itself." }))
      }
    }
    const visiting = new Set<EntityId>(); const visited = new Set<EntityId>()
    const visit = (id: EntityId): boolean => {
      if (visiting.has(id)) return false
      if (visited.has(id)) return true
      visiting.add(id)
      for (const parentId of byId.get(id)!.parentIds) if (!visit(parentId)) return false
      visiting.delete(id); visited.add(id); return true
    }
    for (const tag of tags) if (!visit(tag.id)) return yield* Effect.fail(new ValidationError({ message: "Supertag parents must form a DAG." }))
  })

export interface SyncNoteReferencesResult {
  readonly edges: ReadonlyArray<Edge>
  readonly created: ReadonlyArray<Edge>
  /** Full edge tombstones captured before deletion. */
  readonly removed: ReadonlyArray<Edge>
}

const compareMentionEdges = (left: Edge, right: Edge): number =>
  left.targetNodeId.localeCompare(right.targetNodeId) || left.id.localeCompare(right.id)

/** Test-only deterministic conflict seam. The public ledger route executes graph mutations
 * synchronously inside one storage transaction, so an async suspension point here would make the
 * atomic path impossible to execute. Tests may instead persist one competing edge after the
 * ordinary pre-check and before the candidate write; production always sees `undefined`. */
export interface CreateEdgeTestHookContext {
  readonly relationDefinitionId: EntityId
  readonly sourceNodeId: EntityId
  readonly targetNodeId: EntityId
  readonly insertConflictingEdge: (targetNodeId: EntityId) => Edge
}

export const createEdgeTestHook: {
  beforeWrite: ((context: CreateEdgeTestHookContext) => void) | undefined
} = {
  beforeWrite: undefined
}

export class GraphService extends Context.Tag("@athenaeum/backend/GraphService")<
  GraphService,
  {
    readonly createTag: (
      workspaceId: EntityId,
      name: string,
      parentIds: ReadonlyArray<EntityId>
    ) => Effect.Effect<Tag, DomainError>
    /** Ledger-only mutation primitive. A capability can only be minted by LedgerService during
     * a non-replay executeV2 callback; callers cannot construct or reuse one. */
    readonly updateTag: (capability: LedgerMutationCapability, scope: LedgerMutationScope, workspaceId: EntityId, tagId: EntityId, expectedRevision: string, name: string, parentIds: ReadonlyArray<EntityId>) => Effect.Effect<Tag, DomainError>
    readonly addFact: (
      workspaceId: EntityId,
      nodeId: EntityId,
      predicateId: string,
      value: unknown,
      // Optional caller-supplied id (adversarial-review fix — mirrors `createNode`'s existing
      // `decoded.id ?? crypto.randomUUID()` convention). Passing the same id on a retry makes the
      // write and its sync-feed entry genuinely idempotent (see `sync-feed-service-live.ts`'s
      // `append` doc comment); omitting it preserves the original fresh-id-per-call behavior.
      id?: EntityId,
      // Phase 3 addition (`AgentEditService`'s `addFact` tool, plan §Q15): when provided, the
      // fact is persisted with this `pending` marker AND the read-model (`rm_facts`) / sync-feed
      // writes below are SKIPPED — a pending fact must stay invisible to `runView`/`searchNodes`
      // and absent from the structured-record sync feed until `AgentEditService.mergeChanges`
      // promotes it (at which point the promotion path performs exactly those two writes itself,
      // via `promoteFact` in agent-edit-service-live.ts). Every existing call site omits this
      // parameter, so existing behavior (immediate read-model + sync-feed write) is unchanged —
      // this is a pure, additive widening of the same method, not a new one, per this task's
      // instruction to "reuse GraphService's existing methods, don't duplicate mutation logic":
      // the existence check, id-minting, and `Fact` construction below are shared by both paths.
      pending?: PendingMarker
    ) => Effect.Effect<Fact, DomainError>
    readonly createRelationDefinition: (
      workspaceId: EntityId,
      forwardName: string,
      inverseName: string,
      sourceTagId: EntityId,
      targetTagId: EntityId,
      cardinality: RelationCardinality
    ) => Effect.Effect<RelationDefinition, DomainError>
    readonly createEdge: (
      workspaceId: EntityId,
      relationDefinitionId: EntityId,
      sourceNodeId: EntityId,
      targetNodeId: EntityId,
      // Phase 3 addition (`AgentEditService`'s `addEdge` tool) — same contract as `addFact`'s
      // `pending` parameter above: when provided, the edge is persisted with this marker and the
      // read-model/sync-feed writes are skipped (deferred to `mergeChanges`'s promotion path).
      // The cardinality pre-check/post-check below still runs for a pending edge exactly as for
      // a mainline one — catching a cardinality violation at proposal time, before the user ever
      // sees it, is strictly better than deferring that check to accept time.
      pending?: PendingMarker
    ) => Effect.Effect<Edge, DomainError>
    readonly listBacklinks: (nodeId: EntityId) => Effect.Effect<ReadonlyArray<Edge>, DomainError>
    readonly listGraphIssues: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<GraphIssue>, DomainError>
    readonly listTagClosure: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<TagClosureRow>, DomainError>
    /** Every tag in the workspace (`tagsCollections`'s own backing `TagsRepository.list`), needed as
     *  a real RPC method rather than only the `graph_tags` view — same rationale as
     *  `listBacklinks`/`listGraphIssues`/`listTagClosure` above: the plan names `listTags`
     *  itself (`graph-rpc.ts`'s already-shipped `ListTagsInput`/`ListTagsOutput` schemas) as a
     *  narrower, always-available surface distinct from the general ViewSpec-compiled path. */
    readonly listTags: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Tag>, DomainError>
    /** Assigns an existing tag to an existing node — the real underlying mutation
     *  `graph_node_tags`/the `hasTag` `ViewPredicate` op need (see `graph-rpc.ts`'s
     *  `AssignTagInput` doc comment for why this stage added it). Idempotent: re-assigning the
     *  same `(nodeId, tagId)` pair is a no-op and does not emit a duplicate projection/feed row. */
    readonly assignTag: (
      workspaceId: EntityId,
      nodeId: EntityId,
      tagId: EntityId
    ) => Effect.Effect<boolean, DomainError>
    /** Returns whether a workspace-owned node currently carries a specific tag. This is a
     * read-side validation primitive for server projections; it never mutates the graph or emits
     * a feed entry. */
    readonly hasTag: (
      workspaceId: EntityId,
      nodeId: EntityId,
      tagId: EntityId
    ) => Effect.Effect<boolean, DomainError>
    /** `assignTag`'s symmetric counterpart (supertag-centering pass, docs/supertag-centering-
     *  decisions.md §2's `unassignTag` addition) — removes the `(nodeId, tagId)` `graph_node_tags`
     *  row, mirroring `syncNoteReferences`' own edge-delete branch's three-step shape (KV delete,
     *  read-model delete, `"delete"` sync-feed entry). Idempotent: unassigning a tag the node
     *  doesn't currently carry is a no-op with no phantom projection/feed row, not an error —
     *  the same "re-running a reconciliation step is safe" discipline every other mutation here
     *  follows. */
    readonly unassignTag: (
      workspaceId: EntityId,
      nodeId: EntityId,
      tagId: EntityId
    ) => Effect.Effect<boolean, DomainError>
    /** Rich-text-editor pass, entity-reference-to-edge projection (`mention.ts`'s
     *  `MENTION_RELATION_DEFINITION`, `graph-rpc.ts`'s `SyncNoteReferencesInput`/`Output`):
     *  reconciles `nodeId`'s current `"mentions"` edges against the caller-reported
     *  `referencedNodeIds` — the complete current set, not a delta — creating whichever are
     *  missing and deleting whichever no longer belong, so repeated calls with the identical set
     *  are a true no-op (idempotent). The one and only place a client-derived, ProseMirror-shaped
     *  fact (which nodes a note's rich-text body currently `@`-mentions) gets projected into the
     *  real graph; the backend never parses the note's Automerge/ProseMirror document itself to
     *  discover this (`notes-service-live.ts`'s "doc bytes are opaque" property stays intact — see
     *  `docs/rich-text-editor-decisions.md` §5). */
    readonly syncNoteReferences: (
      workspaceId: EntityId,
      nodeId: EntityId,
      referencedNodeIds: ReadonlyArray<EntityId>
    ) => Effect.Effect<SyncNoteReferencesResult, DomainError>

    // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) -------------------

    /** Declares a new `TagFieldDefinition` on an existing tag (`defineTagField` RPC,
     *  graph-rpc.ts's `DefineTagFieldInput` doc comment). Validates only that `tagId` exists
     *  (`TagNotFound`, same as `createRelationDefinition`'s own tag validation) — no field-name
     *  uniqueness constraint within a tag is enforced this pass (deliberately narrow, matching
     *  `tag-field-definition.ts`'s own "deliberately deferred" scope note). */
    readonly defineTagField: (
      workspaceId: EntityId,
      tagId: EntityId,
      name: string,
      valueKind: TagFieldValueKind,
      sortOrder: number
    ) => Effect.Effect<TagFieldDefinition, DomainError>

    /** The effective field set for `tagId` — its own `TagFieldDefinition`s plus every ancestor's,
     *  resolved via the existing `tagClosure` (no new closure computation; see graph-rpc.ts's
     *  `ListTagFieldsInput` doc comment for the exact rule). Backend-internal return shape (a
     *  plain `{field, inherited}` pair, not the RPC-wire `ResolvedTagField` schema class) — same
     *  "return a plain internal type, let the DO map it onto its own wire schema" split
     *  `listTagClosure`'s `TagClosureRow` already establishes. Ordering: this tag's own fields
     *  first (by `sortOrder`), then every inherited field (grouped by declaring tag, tag-id order,
     *  then `sortOrder`) — a deterministic, but not semantically load-bearing, tiebreak for the
     *  "ordering between several ancestors' field groups" case the decisions doc explicitly leaves
     *  to the presentation layer. */
    readonly listTagFields: (
      workspaceId: EntityId,
      tagId: EntityId
    ) => Effect.Effect<
      ReadonlyArray<{ readonly field: TagFieldDefinition; readonly inherited: boolean }>,
      DomainError
    >

    /** Tags `nodeId` with `tagId` and optionally seeds initial field values, atomically from the
     *  caller's perspective (`applySupertag` RPC, graph-rpc.ts's `ApplySupertagInput` doc
     *  comment). Composes the already-real `assignTag`/`addFact` mutations above rather than
     *  duplicating either — `fieldValues` become fresh `Fact`s (`predicateId = fieldId`), in the
     *  same order supplied, none of them `pending` (this is the mainline/direct-CRUD write path;
     *  `applySupertagTool`, agent-edit-service-live.ts, is the pending-producing equivalent for
     *  agent chats). */
    readonly applySupertag: (
      workspaceId: EntityId,
      nodeId: EntityId,
      tagId: EntityId,
      fieldValues: ReadonlyArray<{ readonly fieldId: EntityId; readonly value: unknown }>
    ) => Effect.Effect<ReadonlyArray<Fact>, DomainError>
  }
>() {}

export const makeGraphServiceLive = (
  tagsCollections: TagsCollections,
  tagClosureCollections: TagClosureCollections,
  edgesCollections: EdgesCollections,
  nodeTagsCollections: NodeTagsCollections,
  tagFieldDefinitionsCollections: TagFieldDefinitionsCollections,
  sql: SqlStorage
): Layer.Layer<GraphService, never, TagsRepository | FactsRepository | RelationDefinitionsRepository | EdgesRepository | GraphIssuesRepository | NodesRepository | SyncFeedService> =>
  Layer.effect(
    GraphService,
    Effect.gen(function* () {
      const tagsRepository = yield* TagsRepository
      const factsRepository = yield* FactsRepository
      const relationDefinitionsRepository = yield* RelationDefinitionsRepository
      const edgesRepository = yield* EdgesRepository
      const graphIssuesRepository = yield* GraphIssuesRepository
      const nodesRepository = yield* NodesRepository
      const syncFeed = yield* SyncFeedService

      const edgesForSourceAndRelation = (
        sourceNodeId: EntityId,
        relationDefinitionId: EntityId
      ): Effect.Effect<ReadonlyArray<Edge>, UnexpectedError> =>
        edgesCollections.edges.bySourceNodeId.get(sourceNodeId).pipe(
          Effect.mapError((error) =>
            error._tag === "StorageError"
              ? new UnexpectedError({ message: error.message })
              : new UnexpectedError({ message: `index conflict: ${error.collection}.${error.index}` })
          ),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveEdge)),
          Effect.map((edges) => edges.filter((e) => e.relationDefinitionId === relationDefinitionId))
        )

      // Named (rather than inlined directly in the returned object below) so `applySupertag`
      // (Supertag-centering pass) can reuse both without duplicating their mutation logic — see
      // that method's own doc comment on the `GraphService` interface above.
      const addFactImpl = (
        workspaceId: EntityId,
        nodeId: EntityId,
        predicateId: string,
        value: unknown,
        id?: EntityId,
        pending?: PendingMarker
      ): Effect.Effect<Fact, DomainError> =>
        Effect.gen(function* () {
          void workspaceId
          yield* nodesRepository.get(nodeId)

          const fact = new Fact({
            id: id ?? (crypto.randomUUID() as EntityId),
            nodeId,
            predicateId,
            value: value as Fact["value"],
            pending
          })
          yield* factsRepository.put(fact)
          if (pending === undefined) {
            yield* upsertFact(sql, fact)
            yield* syncFeed.append("fact", fact.id, "put", fact)
          }
          return fact
        })

      const assignTagImpl = (workspaceId: EntityId, nodeId: EntityId, tagId: EntityId): Effect.Effect<boolean, DomainError> =>
        Effect.gen(function* () {
          void workspaceId
          yield* nodesRepository.get(nodeId)
          yield* tagsRepository.get(tagId)

          const row = { id: nodeTagRowId(nodeId, tagId), nodeId, tagId }
          const existing = yield* nodeTagsCollections.nodeTags.get(row.id).pipe(Effect.mapError(nodeTagsToUnexpectedError))
          if (existing !== undefined) return false
          yield* nodeTagsCollections.nodeTags.put(row).pipe(Effect.mapError(nodeTagsToUnexpectedError))
          yield* upsertNodeTag(sql, nodeId, tagId)
          // `entityId` carries the node (rather than the tag, or the composite key, neither of
          // which fits `SyncFeedEntry`'s single-`EntityId` field) — a client replaying this
          // feed entry cares primarily about "this node's tag membership changed"; `payload`
          // carries the full `(nodeId, tagId)` pair for anyone who needs both.
          yield* syncFeed.append("nodeTag", nodeId, "put", row)
          return true
        })

      return {
        createTag: (workspaceId, name, parentIds) =>
          Effect.gen(function* () {
            void workspaceId
            // Every declared parent must already exist — a `createTag` referencing an unknown
            // parent id fails closed as `TagNotFound` rather than silently creating a dangling
            // DAG edge the closure computation would then just ignore.
            yield* Effect.forEach(parentIds, (parentId) => tagsRepository.get(parentId), { discard: true })
            const beforeRaw = yield* tagsCollections.tags.list().pipe(Effect.mapError(tagsToUnexpectedError))
            const beforeTags = yield* Effect.forEach(beforeRaw, reviveTag)
            if (beforeTags.some((candidate) => tagNameKey(candidate.name) === tagNameKey(name))) {
              return yield* Effect.fail(new ValidationError({ message: "A Supertag with that name already exists." }))
            }

            const tag = new Tag({
              id: crypto.randomUUID() as EntityId,
              name,
              parentIds,
              builtin: false
            })
            const allTags = [...beforeTags, tag]
            yield* validateTagDag(allTags)
            yield* tagsRepository.put(tag)
            yield* upsertTag(sql, tag)
            yield* replaceTagParents(sql, tag.id, tag.parentIds)

            yield* recomputeAndPersistTagClosure(tagClosureCollections, allTags)
            const closureRows = yield* tagClosureCollections.tagClosure.list().pipe(
              Effect.mapError((error) =>
                error._tag === "StorageError"
                  ? new UnexpectedError({ message: error.message })
                  : new UnexpectedError({ message: `index conflict: ${error.collection}.${error.index}` })
              )
            )
            yield* replaceAllTagClosure(sql, closureRows)

            yield* syncFeed.append("tag", tag.id, "put", tag)
            return tag
          }),

        updateTag: (capability, scope, workspaceId, tagId, expectedRevision, name, parentIds) =>
          Effect.gen(function* () {
            if (!isLedgerMutationCapability(capability, scope) || scope.type !== "updateTag" || scope.workspaceId !== workspaceId || scope.targetKind !== "tag" || scope.targetId !== tagId) {
              return yield* Effect.fail(new UnexpectedError({ message: "Supertag updates require the matching ledger command." }))
            }
            const current = yield* tagsRepository.get(tagId)
            if (current.builtin) return yield* Effect.fail(new ValidationError({ message: "Built-in Supertags cannot be edited." }))
            if (tagRevision(current) !== expectedRevision) return yield* Effect.fail(new ValidationError({ message: "This Supertag changed elsewhere. Reload it before saving." }))
            const existingRaw = yield* tagsCollections.tags.list().pipe(Effect.mapError(tagsToUnexpectedError))
            const allTags = yield* Effect.forEach(existingRaw, reviveTag)
            const collision = allTags.find((candidate) => candidate.id !== tagId && tagNameKey(candidate.name) === tagNameKey(name))
            if (collision !== undefined && tagNameKey(name) !== tagNameKey(current.name)) return yield* Effect.fail(new ValidationError({ message: "A Supertag with that name already exists." }))
            const next = new Tag({ id: current.id, name, parentIds: [...parentIds], builtin: current.builtin })
            const prospective = allTags.map((candidate) => candidate.id === tagId ? next : candidate)
            yield* validateTagDag(prospective)
            yield* tagsRepository.put(next)
            yield* upsertTag(sql, next)
            yield* replaceTagParents(sql, next.id, next.parentIds)
            yield* recomputeAndPersistTagClosure(tagClosureCollections, prospective)
            const closureRows = yield* tagClosureCollections.tagClosure.list().pipe(Effect.mapError(tagsToUnexpectedError))
            yield* replaceAllTagClosure(sql, closureRows)
            yield* syncFeed.append("tag", next.id, "put", next)
            return next
          }),

        addFact: addFactImpl,

        createRelationDefinition: (workspaceId, forwardName, inverseName, sourceTagId, targetTagId, cardinality) =>
          Effect.gen(function* () {
            void workspaceId
            yield* tagsRepository.get(sourceTagId)
            yield* tagsRepository.get(targetTagId)

            const relationDefinition = new RelationDefinition({
              id: crypto.randomUUID() as EntityId,
              forwardName,
              inverseName,
              sourceTagId,
              targetTagId,
              cardinality
            })
            yield* relationDefinitionsRepository.put(relationDefinition)
            yield* upsertRelationDefinition(sql, relationDefinition)
            yield* syncFeed.append("relationDefinition", relationDefinition.id, "put", relationDefinition)
            return relationDefinition
          }),

        createEdge: (workspaceId, relationDefinitionId, sourceNodeId, targetNodeId, pending) =>
          Effect.gen(function* () {
            void workspaceId
            const relationDefinition = yield* relationDefinitionsRepository.get(relationDefinitionId)
            yield* nodesRepository.get(sourceNodeId)
            yield* nodesRepository.get(targetNodeId)

            const maxOne = isMaxOneFromSource(relationDefinition.cardinality)

            if (maxOne) {
              const existingBefore = yield* edgesForSourceAndRelation(sourceNodeId, relationDefinitionId)
              if (existingBefore.length >= 1) {
                // The straightforward, non-concurrent rejection path (errors.ts's
                // `CardinalityViolation`: "a single, non-concurrent mutation... the mutation
                // never happens"). A caller that already sees the conflicting edge at pre-check
                // time is, by construction, not racing anything — it simply asked for a second
                // edge under a cardinality that forbids one.
                return yield* Effect.fail(
                  new CardinalityViolation({
                    relationDefinitionId,
                    message:
                      `Source node ${sourceNodeId} already has an edge under relationDefinition ` +
                      `${relationDefinitionId} (cardinality ${relationDefinition.cardinality} allows at most one)`
                  })
                )
              }
            }

            const insertConflictingEdge = (conflictingTargetNodeId: EntityId): Edge => {
              const conflictingEdge = new Edge({
                id: crypto.randomUUID() as EntityId,
                relationDefinitionId,
                sourceNodeId,
                targetNodeId: conflictingTargetNodeId
              })
              const exit = Effect.runSyncExit(Effect.gen(function* () {
                yield* edgesRepository.put(conflictingEdge)
                yield* upsertEdge(sql, conflictingEdge)
                yield* syncFeed.append("edge", conflictingEdge.id, "put", conflictingEdge)
                return conflictingEdge
              }))
              if (Exit.isFailure(exit)) throw new Error("failed to inject deterministic edge conflict")
              return exit.value
            }

            // Deterministic test-only conflict injection; unlike the old async hook this remains
            // valid inside the ledger's synchronous transaction boundary.
            yield* Effect.sync(() => createEdgeTestHook.beforeWrite?.({
              relationDefinitionId,
              sourceNodeId,
              targetNodeId,
              insertConflictingEdge
            }))

            const edge = new Edge({
              id: crypto.randomUUID() as EntityId,
              relationDefinitionId,
              sourceNodeId,
              targetNodeId,
              pending
            })
            yield* edgesRepository.put(edge)
            if (pending === undefined) {
              yield* upsertEdge(sql, edge)
              yield* syncFeed.append("edge", edge.id, "put", edge)
            }

            if (maxOne) {
              const existingAfter = yield* edgesForSourceAndRelation(sourceNodeId, relationDefinitionId)
              if (existingAfter.length > 1) {
                // Two (or more) calls both passed the pre-check before either wrote — a genuine
                // concurrent conflict. Evolution Rule #4 (plan §"Storage & domain model"):
                // preserve every conflicting edge, never silently drop/last-write-wins; expose a
                // deterministic `GraphIssue` instead of rejecting.
                const conflictingEdgeIds = existingAfter.map((e) => e.id)
                yield* recordGraphIssueOnce(
                  graphIssuesRepository,
                  sql,
                  workspaceId,
                  relationDefinitionId,
                  sourceNodeId,
                  conflictingEdgeIds
                )
              }
            }

            return edge
          }),

        listBacklinks: (nodeId) =>
          edgesCollections.edges.byTargetNodeId.get(nodeId).pipe(
            Effect.mapError((error) =>
              error._tag === "StorageError"
                ? new UnexpectedError({ message: error.message })
                : new UnexpectedError({ message: `index conflict: ${error.collection}.${error.index}` })
            ),
            Effect.flatMap((raw) => Effect.forEach(raw, reviveEdge)),
            // Phase 3 addition: mainline `listBacklinks` must never surface a not-yet-accepted
            // pending edge (plan §Q15) — same guarantee `NodesRepository.list`/
            // `EdgesRepository.list` apply, needed here too since this method reads the raw
            // `byTargetNodeId` index directly rather than going through `EdgesRepository.list`.
            Effect.map((edges) => edges.filter((edge) => edge.pending === undefined))
          ),

        listGraphIssues: (workspaceId) => graphIssuesRepository.list(workspaceId),

        listTags: (workspaceId) => tagsRepository.list(workspaceId),

        listTagClosure: (workspaceId) =>
          Effect.gen(function* () {
            void workspaceId
            return yield* tagClosureCollections.tagClosure.list().pipe(
              Effect.mapError((error) =>
                error._tag === "StorageError"
                  ? new UnexpectedError({ message: error.message })
                  : new UnexpectedError({ message: `index conflict: ${error.collection}.${error.index}` })
              )
            )
          }),

        assignTag: assignTagImpl,

        hasTag: (workspaceId, nodeId, tagId) =>
          Effect.gen(function* () {
            const node = yield* nodesRepository.get(nodeId)
            if (node.workspaceId !== workspaceId || node.pending !== undefined) return false
            yield* tagsRepository.get(tagId)
            const row = yield* nodeTagsCollections.nodeTags.get(nodeTagRowId(nodeId, tagId)).pipe(Effect.mapError(nodeTagsToUnexpectedError))
            return row !== undefined
          }),

        unassignTag: (workspaceId, nodeId, tagId) =>
          Effect.gen(function* () {
            void workspaceId
            const id = nodeTagRowId(nodeId, tagId)
            const row = { id, nodeId, tagId }
            const existing = yield* nodeTagsCollections.nodeTags.get(id).pipe(Effect.mapError(nodeTagsToUnexpectedError))
            if (existing === undefined) return false
            yield* nodeTagsCollections.nodeTags.delete(id).pipe(Effect.mapError(nodeTagsToUnexpectedError))
            yield* deleteNodeTag(sql, nodeId, tagId)
            yield* syncFeed.append("nodeTag", nodeId, "delete", row)
            return true
          }),

        syncNoteReferences: (workspaceId, nodeId, referencedNodeIds) =>
          Effect.gen(function* () {
            void workspaceId
            yield* nodesRepository.get(nodeId)
            // Fails closed (`RelationDefinitionNotFound`) if the workspace-seeded "mentions"
            // relation is somehow missing rather than silently writing edges against a dangling
            // `relationDefinitionId` — same validation `createEdge` already applies to every edge
            // it writes.
            yield* relationDefinitionsRepository.get(MentionRelationId)

            // The complete desired set, de-duplicated: a caller reporting the same referenced
            // node id twice (e.g. two separate `@`-mentions of the same node in one page) must
            // reconcile to exactly one edge, not be treated as "two edges wanted".
            const desired = new Set(referencedNodeIds)
            const existing = [...(yield* edgesForSourceAndRelation(nodeId, MentionRelationId))].sort(compareMentionEdges)

            const toDelete = existing.filter((edge) => !desired.has(edge.targetNodeId)).sort(compareMentionEdges)
            const kept = existing.filter((edge) => desired.has(edge.targetNodeId)).sort(compareMentionEdges)
            const keptTargetIds = new Set(kept.map((edge) => edge.targetNodeId))
            const toCreateIds = [...desired].filter((targetNodeId) => !keptTargetIds.has(targetNodeId)).sort()

            // Validate every NEW target exists before writing anything — a stale/mistyped
            // `@`-mention referencing a node id that no longer exists rejects the whole call
            // rather than silently creating a dangling edge (same fail-closed discipline
            // `createEdge` already applies to both of its endpoints).
            yield* Effect.forEach(toCreateIds, (targetNodeId) => nodesRepository.get(targetNodeId), {
              discard: true
            })

            yield* Effect.forEach(
              toDelete,
              (edge) =>
                edgesRepository.delete(edge.id).pipe(
                  Effect.zipRight(deleteEdge(sql, edge.id)),
                  Effect.zipRight(syncFeed.append("edge", edge.id, "delete", edge))
                ),
              { discard: true }
            )

            const created = yield* Effect.forEach(toCreateIds, (targetNodeId) =>
              Effect.gen(function* () {
                const edge = new Edge({
                  id: crypto.randomUUID() as EntityId,
                  relationDefinitionId: MentionRelationId,
                  sourceNodeId: nodeId,
                  targetNodeId
                })
                yield* edgesRepository.put(edge)
                yield* upsertEdge(sql, edge)
                yield* syncFeed.append("edge", edge.id, "put", edge)
                return edge
              })
            )

            const orderedCreated = created.sort(compareMentionEdges)
            return {
              edges: [...kept, ...orderedCreated].sort(compareMentionEdges),
              created: orderedCreated,
              removed: toDelete
            }
          }),

        defineTagField: (workspaceId, tagId, name, valueKind, sortOrder) =>
          Effect.gen(function* () {
            void workspaceId
            // Same "the tag itself must exist" fail-closed check `createRelationDefinition`
            // already applies to its own `sourceTagId`/`targetTagId` — `TagFieldDefinitionNotFound`
            // is not raised here (that error covers a future edit/delete path, not this one; see
            // tag-field-definition.ts's own doc comment on that error class).
            yield* tagsRepository.get(tagId)

            const fieldDefinition = new TagFieldDefinition({
              id: crypto.randomUUID() as EntityId,
              tagId,
              name,
              valueKind,
              sortOrder,
              builtin: false
            })
            yield* tagFieldDefinitionsCollections.tagFieldDefinitions
              .put(fieldDefinition)
              .pipe(Effect.mapError(tagFieldDefinitionsToUnexpectedError))
            // Workspace-wide schema, like `createTag`/`createRelationDefinition` — synced to every
            // other connected client the same way. `entityKind` is a plain, open string
            // (sync.ts's own doc comment), so introducing `"tagFieldDefinition"` needs no change
            // there.
            yield* syncFeed.append("tagFieldDefinition", fieldDefinition.id, "put", fieldDefinition)
            return fieldDefinition
          }),

        listTagFields: (workspaceId, tagId) =>
          Effect.gen(function* () {
            void workspaceId
            yield* tagsRepository.get(tagId)

            // Every ancestor-or-self of `tagId` in the materialized closure (reflexive — `tagId`
            // is always its own ancestor, tag-closure.ts's own doc comment) — no new closure
            // computation, exactly per this method's own doc comment on the `GraphService`
            // interface above.
            const closureRows = yield* tagClosureCollections.tagClosure.byDescendant.get(tagId).pipe(
              Effect.mapError((error) =>
                error._tag === "StorageError"
                  ? new UnexpectedError({ message: error.message })
                  : new UnexpectedError({ message: `index conflict: ${error.collection}.${error.index}` })
              )
            )
            const ancestorIds = new Set(closureRows.map((row) => row.ancestorId))

            const rawFields = yield* tagFieldDefinitionsCollections.tagFieldDefinitions
              .list()
              .pipe(Effect.mapError(tagFieldDefinitionsToUnexpectedError))
            const fields = yield* Effect.forEach(rawFields, reviveTagFieldDefinition)

            // Filtering by `ancestorIds.has(field.tagId)` naturally de-duplicates the diamond case
            // (A -> B -> D, A -> C -> D: D's fields are reached via two closure paths but D itself
            // appears in `ancestorIds` only once, since `tagClosure` stores unique
            // `(ancestorId, descendantId)` pairs) — no separate de-dup step needed.
            const effective = fields.filter((field) => ancestorIds.has(field.tagId))

            const ownFields = effective
              .filter((field) => field.tagId === tagId)
              .sort((a, b) => a.sortOrder - b.sortOrder)
            const inheritedFields = effective
              .filter((field) => field.tagId !== tagId)
              .sort((a, b) => (a.tagId === b.tagId ? a.sortOrder - b.sortOrder : a.tagId.localeCompare(b.tagId)))

            return [
              ...ownFields.map((field) => ({ field, inherited: false })),
              ...inheritedFields.map((field) => ({ field, inherited: true }))
            ]
          }),

        applySupertag: (workspaceId, nodeId, tagId, fieldValues) =>
          Effect.gen(function* () {
            // Composes the already-real `assignTag`/`addFact` mutations — no duplicated logic, no
            // new storage. Tag membership first (matches `ApplySupertagInput`'s framing: "tags a
            // node... and optionally seeds initial field values" — the tag assignment is the
            // primary act, field values are the optional follow-on).
            yield* assignTagImpl(workspaceId, nodeId, tagId)
            const facts = yield* Effect.forEach(fieldValues, (fieldValue) =>
              addFactImpl(workspaceId, nodeId, fieldValue.fieldId, fieldValue.value)
            )
            return facts
          })
      }
    })
  )

/** Skips creating a duplicate `GraphIssue` if one already covers exactly this
 *  `(relationDefinitionId, nodeId, conflictingEdgeIds)` combination — e.g. a third overlapping
 *  `createEdge` call detecting the same already-recorded conflict again. Compares
 *  `conflictingEdgeIds` order-insensitively (a `Set` of ids) since the underlying edge listing
 *  order is not itself meaningful. */
const recordGraphIssueOnce = (
  graphIssuesRepository: Context.Tag.Service<typeof GraphIssuesRepository>,
  sql: SqlStorage,
  workspaceId: EntityId,
  relationDefinitionId: EntityId,
  nodeId: EntityId,
  conflictingEdgeIds: ReadonlyArray<EntityId>
): Effect.Effect<void, DomainError> =>
  Effect.gen(function* () {
    const existing = yield* graphIssuesRepository.list(workspaceId)
    const conflictSet = new Set(conflictingEdgeIds)
    const alreadyRecorded = existing.some(
      (issue) =>
        issue.relationDefinitionId === relationDefinitionId &&
        issue.nodeId === nodeId &&
        issue.conflictingEdgeIds.length === conflictSet.size &&
        issue.conflictingEdgeIds.every((id) => conflictSet.has(id))
    )
    if (alreadyRecorded) return

    // Internally raises `GraphIssueDetected` and immediately catches it, per that error class's
    // own doc comment ("the caller catching this error is expected to persist a GraphIssue row
    // from its fields, not roll back") — modeled as raise-then-catch (rather than just calling a
    // plain function) so the "this is the GraphIssueDetected case" control-flow shape stays
    // explicit and matches the domain error class's documented contract literally.
    yield* Effect.fail(new GraphIssueDetected({ relationDefinitionId, nodeId, conflictingEdgeIds })).pipe(
      // `detected`'s own fields are the `Data.TaggedError`'s plain-`string` RPC-envelope payload
      // shape (see errors.ts), not re-branded `EntityId`s — use this closure's already-`EntityId`
      // -typed `relationDefinitionId`/`nodeId`/`conflictingEdgeIds` params instead of re-deriving
      // them from the caught error.
      Effect.catchTag("GraphIssueDetected", (_detected) =>
        Effect.gen(function* () {
          const issue = new GraphIssue({
            id: crypto.randomUUID() as EntityId,
            kind: "concurrent-max-one-edge-conflict",
            relationDefinitionId,
            nodeId,
            conflictingEdgeIds: conflictingEdgeIds as Array<EntityId>,
            createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
          })
          yield* graphIssuesRepository.put(issue)
          yield* upsertGraphIssue(sql, issue)
        })
      ),
      Effect.asVoid
    )
  })
