import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { MENTION_RELATION_DEFINITION, MentionRelationId, MentionSentinelTagId } from "./mention.js"
import { EntityId } from "./node.js"
import { RelationDefinition } from "./relation-definition.js"

describe("MENTION_RELATION_DEFINITION", () => {
  it("is the one fixed many-to-many 'mentions' / 'mentioned by' relation", () => {
    expect(MENTION_RELATION_DEFINITION.id).toBe(MentionRelationId)
    expect(MENTION_RELATION_DEFINITION.forwardName).toBe("mentions")
    expect(MENTION_RELATION_DEFINITION.inverseName).toBe("mentioned by")
    expect(MENTION_RELATION_DEFINITION.cardinality).toBe("many-to-many")
  })

  it("uses the sentinel tag id for both source and target (documented imprecision, not a real tag)", () => {
    expect(MENTION_RELATION_DEFINITION.sourceTagId).toBe(MentionSentinelTagId)
    expect(MENTION_RELATION_DEFINITION.targetTagId).toBe(MentionSentinelTagId)
  })

  it("MentionRelationId and MentionSentinelTagId are distinct, schema-valid EntityIds", () => {
    expect(() => Schema.decodeUnknownSync(EntityId)(MentionRelationId)).not.toThrow()
    expect(() => Schema.decodeUnknownSync(EntityId)(MentionSentinelTagId)).not.toThrow()
    expect(MentionRelationId).not.toBe(MentionSentinelTagId)
  })

  it("does not collide with the BaseTagIds/WorkoutTagIds/WorkoutRelationIds id blocks", () => {
    // BaseTagIds: ...0001-...0008; WorkoutTagIds/WorkoutRelationIds: ...0101-...0113.
    expect(MentionRelationId).toBe("00000000-0000-0000-0000-000000000201")
    expect(MentionSentinelTagId).toBe("00000000-0000-0000-0000-000000000202")
  })

  it("round-trips through the RelationDefinition schema", () => {
    const encoded = Schema.encodeSync(RelationDefinition)(MENTION_RELATION_DEFINITION)
    expect(Schema.decodeUnknownSync(RelationDefinition)(encoded)).toEqual(MENTION_RELATION_DEFINITION)
  })
})
