import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Plan §"Storage & domain model": "relationDefinitions — {forwardName, inverseName,
// sourceTagId, targetTagId, cardinality}." A `RelationDefinition` is the typed schema for an
// edge kind (e.g. forward "employs" / inverse "employed by", source tag Company, target tag
// Person, cardinality one-to-many) — `Edge` rows (see edge.ts) are instances of one of these.

export const RelationCardinality = Schema.Literal(
  "one-to-one",
  "one-to-many",
  "many-to-one",
  "many-to-many"
)
export type RelationCardinality = typeof RelationCardinality.Type

export class RelationDefinition extends Schema.Class<RelationDefinition>("RelationDefinition")({
  id: EntityId,
  forwardName: Schema.String.pipe(Schema.minLength(1)),
  inverseName: Schema.String.pipe(Schema.minLength(1)),
  sourceTagId: EntityId,
  targetTagId: EntityId,
  cardinality: RelationCardinality
}) {}
