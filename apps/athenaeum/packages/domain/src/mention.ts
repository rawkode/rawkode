import { EntityId } from "./node.js"
import { RelationDefinition } from "./relation-definition.js"

// Rich-text-editor pass, item 5 of `docs/rich-text-editor-decisions.md` ("Entity-reference-to-edge
// projection design"): typing `@` in the web editor inserts an inline `entity-ref` mark carrying
// an immutable `nodeId`. The client-derived set of referenced node ids for a page is reconciled,
// via the dedicated `syncNoteReferences` RPC (see `graph-rpc.ts`), into real `Edge` rows under
// exactly **one** fixed, workspace-seeded `RelationDefinition` — this file's `MENTION_RELATION_DEFINITION`.
//
// Same fixed-nil-pattern-UUID, `builtin`-shaped discipline `tag.ts`'s `BaseTagIds`/`BASE_TAGS` and
// `workout.ts`'s `WorkoutRelationIds`/`WORKOUT_RELATION_DEFINITIONS` already establish (`createEdge`,
// per `graph-service-live.ts`, requires the referenced `RelationDefinition` to already exist by id —
// the reconciliation path needs a stable, known id to create edges against, not one minted fresh,
// and therefore random, per workspace). Deliberately a **separate, parallel file**, not folded into
// `tag.ts`/`workout.ts`, because this is a single relation with no accompanying tag set at all — see
// the `sourceTagId`/`targetTagId` note below for why no `MENTION_TAGS` array exists to seed.
//
// Id block: `00000000-0000-0000-0000-0000000002XX`, distinct from `BaseTagIds`'s `...0001`-`...0008`
// and `WorkoutTagIds`/`WorkoutRelationIds`'s `...0101`-`...0113` blocks, so every fixed/builtin id in
// this codebase stays trivially distinguishable and non-colliding at a glance.

export const MentionRelationId = EntityId.make("00000000-0000-0000-0000-000000000201")

/**
 * A placeholder tag id, **not** a real seeded `Tag` row — see the long note below. Exists purely so
 * `RelationDefinition.sourceTagId`/`targetTagId` (both schema-mandatory `EntityId` fields) have a
 * schema-valid value to point at; nothing ever looks this id up in the `tags` collection for the
 * "mentions" relation.
 */
export const MentionSentinelTagId = EntityId.make("00000000-0000-0000-0000-000000000202")

/**
 * The one fixed `"mentions"` / `"mentioned by"` relation every `@`-mention in a page's rich text
 * projects into (plan/decisions doc §5). Many-to-many: a note can mention many nodes, a node can be
 * mentioned by many notes.
 *
 * **`sourceTagId`/`targetTagId` are a deliberate, documented imprecision, not an oversight.**
 * `RelationDefinition`'s schema makes both fields mandatory (one source tag, one target tag per
 * relation kind — every other `RelationDefinition` in this codebase, `BASE_TAGS`-derived or
 * `WORKOUT_RELATION_DEFINITIONS`, really does mean "this relation only makes sense between nodes of
 * these two tags"). A `@`-mention has no such constraint by design — a daily note can mention a
 * Person, a Project, another daily note, anything with a node id — so there is no real pair of tags
 * to put here. Confirmed empirically (rich-text-editor-decisions.md §5, reading
 * `graph-service-live.ts#createEdge`): the real `createEdge` implementation never actually checks
 * `sourceTagId`/`targetTagId` against the nodes' own tags today, so this doesn't yet cause any
 * observable behavior difference — but it is a real gap that must not be silently relied upon
 * forever. `MentionSentinelTagId` is deliberately **not** one of `BaseTagIds`'s eight real tags
 * (which would misleadingly imply "mentions only work between Person nodes" or similar) and is
 * never inserted into the `tags` collection — it exists only to satisfy this schema field. If a
 * later stage adds real tag-constraint enforcement to `createEdge`, this relation definition will
 * need either a genuine "any node" sentinel *tag* (seeded for real, and exempted from the DAG
 * closure the way `builtin` tags already are) or an explicit per-relation enforcement bypass; that
 * is that future stage's decision to make, not this one's.
 */
export const MENTION_RELATION_DEFINITION: RelationDefinition = new RelationDefinition({
  id: MentionRelationId,
  forwardName: "mentions",
  inverseName: "mentioned by",
  sourceTagId: MentionSentinelTagId,
  targetTagId: MentionSentinelTagId,
  cardinality: "many-to-many"
})
