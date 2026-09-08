import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EntityId } from "./node.js"
import { GraphViewName, ViewPredicate, ViewSpec } from "./view-spec.js"

const validUuid = "3fa85f64-5717-4562-b3fc-2c963f66afa6"

describe("ViewPredicate schema", () => {
  it("round-trips a leaf eq predicate over a column", () => {
    const predicate = {
      op: "eq" as const,
      field: { kind: "column" as const, column: "title" },
      value: "My note"
    }
    const encoded = Schema.encodeSync(ViewPredicate)(predicate)
    expect(Schema.decodeUnknownSync(ViewPredicate)(encoded)).toEqual(predicate)
  })

  it("round-trips a leaf in predicate over a fact field", () => {
    const predicate = {
      op: "in" as const,
      field: { kind: "fact" as const, predicateId: "status" },
      values: ["todo", "doing"]
    }
    const encoded = Schema.encodeSync(ViewPredicate)(predicate)
    expect(Schema.decodeUnknownSync(ViewPredicate)(encoded)).toEqual(predicate)
  })

  it("round-trips a hasTag predicate", () => {
    const predicate = { op: "hasTag" as const, tagId: EntityId.make(validUuid) }
    const encoded = Schema.encodeSync(ViewPredicate)(predicate)
    expect(Schema.decodeUnknownSync(ViewPredicate)(encoded)).toEqual(predicate)
  })

  it("round-trips a nested and/or tree at multiple levels of depth", () => {
    const predicate = {
      op: "and" as const,
      predicates: [
        { op: "hasTag" as const, tagId: EntityId.make(validUuid) },
        {
          op: "or" as const,
          predicates: [
            { op: "eq" as const, field: { kind: "column" as const, column: "title" }, value: "A" },
            {
              op: "eq" as const,
              field: { kind: "fact" as const, predicateId: "status" },
              value: "done"
            }
          ]
        }
      ]
    }
    const encoded = Schema.encodeSync(ViewPredicate)(predicate)
    expect(Schema.decodeUnknownSync(ViewPredicate)(encoded)).toEqual(predicate)
  })

  it("rejects an unknown op", () => {
    const result = Schema.decodeUnknownEither(ViewPredicate)({
      op: "not-a-real-op",
      field: { kind: "column", column: "title" },
      value: "x"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an eq predicate missing its field", () => {
    const result = Schema.decodeUnknownEither(ViewPredicate)({ op: "eq", value: "x" })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("ViewSpec schema", () => {
  it("round-trips a full spec with a filter", () => {
    const spec = new ViewSpec({
      filter: { op: "hasTag", tagId: EntityId.make(validUuid) },
      groupBy: "status",
      sortColumn: "createdAt",
      sortDescending: true,
      view: "board",
      visibleColumns: ["title", "status"],
      rowLimit: 100
    })
    const encoded = Schema.encodeSync(ViewSpec)(spec)
    expect(Schema.decodeUnknownSync(ViewSpec)(encoded)).toEqual(spec)
  })

  it("round-trips a minimal spec with no filter/groupBy/sort", () => {
    const spec = new ViewSpec({
      view: "table",
      visibleColumns: ["title"],
      rowLimit: 50
    })
    const encoded = Schema.encodeSync(ViewSpec)(spec)
    expect(Schema.decodeUnknownSync(ViewSpec)(encoded)).toEqual(spec)
  })

  it("rejects rowLimit <= 0", () => {
    const result = Schema.decodeUnknownEither(ViewSpec)({
      view: "table",
      visibleColumns: ["title"],
      rowLimit: 0
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects a fractional rowLimit", () => {
    const result = Schema.decodeUnknownEither(ViewSpec)({
      view: "table",
      visibleColumns: ["title"],
      rowLimit: 10.5
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an unknown view rendering mode", () => {
    const result = Schema.decodeUnknownEither(ViewSpec)({
      view: "calendar",
      visibleColumns: ["title"],
      rowLimit: 10
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("GraphViewName schema", () => {
  it("accepts every fixed read-only view name from the plan", () => {
    for (const name of [
      "graph_nodes",
      "graph_tags",
      "graph_tag_parents",
      "graph_tag_closure",
      "graph_node_tags",
      "graph_facts",
      "graph_relation_definitions",
      "graph_edges",
      "graph_issues",
      "graph_text_search"
    ] as const) {
      expect(Either.isRight(Schema.decodeUnknownEither(GraphViewName)(name))).toBe(true)
    }
  })

  it("rejects an arbitrary/ad-hoc table name", () => {
    const result = Schema.decodeUnknownEither(GraphViewName)("nodes")
    expect(Either.isLeft(result)).toBe(true)
  })
})
