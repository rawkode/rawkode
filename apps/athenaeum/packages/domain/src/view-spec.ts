import * as Schema from "effect/Schema"
import { JsonValue } from "./json-value.js"
import { EntityId } from "./node.js"

// Plan §"Storage & domain model": "Views: stored-query-AST is canonical; `ql view=board
// group=status` is a serialization surface over it, not a second query language... compiled
// from a ViewSpec schema (filter predicate tree, groupBy, sort, view: 'table'|'list'|'board',
// visibleColumns, rowLimit)." This file is that predicate tree plus the `ViewSpec` wrapper.
//
// Predicate-tree shape (plan task item 7 — "design a small recursive Schema... over field/tag/
// fact predicates, keep it minimal but real, not a stub"):
//
// A leaf predicate targets one of two kinds of comparable value via `FieldRef`:
//   - `{kind: "column", column}` — a physical column on the view being queried (e.g. `title`
//     on `graph_nodes`, `createdAt` on `graph_edges`).
//   - `{kind: "fact", predicateId}` — a `Fact.predicateId` value on the node in question (e.g.
//     filtering Task nodes by their `"status"` fact).
// Tag membership is its own predicate kind, `hasTag`, rather than an `eq`/`in` over some
// synthetic tag field — "does this node carry tag X" is a set-membership test against
// `tagClosure` (plan: "tagClosure — materialized transitive closure"), not an equality
// comparison against a scalar column, so giving it a dedicated op keeps the SQL compiler this
// feeds (a later stage, not built here) from having to special-case a fake column name.
// `and`/`or` combine any of the above (including nested `and`/`or`) recursively.
//
// This is a plain `Schema.Union` of `Schema.Struct`s built with `Schema.suspend`, not a
// `Schema.Class` like every other entity in this package: `Schema.Class` models one fixed
// struct shape, but a predicate tree is inherently a closed set of *variant* shapes (leaf ops
// vs. combinator ops) that must recurse into themselves — the standard Effect Schema pattern
// for that is a suspended union of structs, not a class.

export const FieldRef = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("column"), column: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({
    kind: Schema.Literal("fact"),
    predicateId: Schema.String.pipe(Schema.minLength(1))
  })
)
export type FieldRef = typeof FieldRef.Type

export type ViewPredicate =
  | { readonly op: "eq"; readonly field: FieldRef; readonly value: JsonValue }
  | { readonly op: "in"; readonly field: FieldRef; readonly values: ReadonlyArray<JsonValue> }
  | { readonly op: "hasTag"; readonly tagId: EntityId }
  | { readonly op: "and"; readonly predicates: ReadonlyArray<ViewPredicate> }
  | { readonly op: "or"; readonly predicates: ReadonlyArray<ViewPredicate> }

// The wire/encoded counterpart of `ViewPredicate` — identical except `tagId`, whose *encoded*
// form is a plain `string` (see node.ts: `EntityId`'s brand is a decode-time-only refinement,
// its `Encoded` type is `string`). A recursive `Schema.suspend` needs both the decoded (`A`) and
// encoded (`I`) type spelled out explicitly up front (there's no value yet to infer them from,
// since the schema being annotated is the very thing under construction) — a single-type-param
// `Schema.Schema<ViewPredicate>` would wrongly force `Encoded = ViewPredicate` too, i.e. claim
// the wire form also carries a branded `EntityId`, which `Schema.Struct({ tagId: EntityId })`
// does not actually produce.
export type ViewPredicateEncoded =
  | { readonly op: "eq"; readonly field: FieldRef; readonly value: JsonValue }
  | { readonly op: "in"; readonly field: FieldRef; readonly values: ReadonlyArray<JsonValue> }
  | { readonly op: "hasTag"; readonly tagId: string }
  | { readonly op: "and"; readonly predicates: ReadonlyArray<ViewPredicateEncoded> }
  | { readonly op: "or"; readonly predicates: ReadonlyArray<ViewPredicateEncoded> }

export const ViewPredicate: Schema.Schema<ViewPredicate, ViewPredicateEncoded> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Struct({ op: Schema.Literal("eq"), field: FieldRef, value: JsonValue }),
      Schema.Struct({
        op: Schema.Literal("in"),
        field: FieldRef,
        values: Schema.Array(JsonValue)
      }),
      Schema.Struct({ op: Schema.Literal("hasTag"), tagId: EntityId }),
      Schema.Struct({ op: Schema.Literal("and"), predicates: Schema.Array(ViewPredicate) }),
      Schema.Struct({ op: Schema.Literal("or"), predicates: Schema.Array(ViewPredicate) })
    )
)

/**
 * The named, read-only views a `ViewSpec` can be run against (plan §"Storage & domain model":
 * "carry forward Enchiridion's exact read-only view set and semantics"). See rpc.ts /
 * graph-rpc.ts's `RunViewInput` for why this is a separate field from `ViewSpec.view` (that one
 * is a UI *rendering* mode — table/list/board — not which SQL view is queried).
 */
export const GraphViewName = Schema.Literal(
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
)
export type GraphViewName = typeof GraphViewName.Type

export class ViewSpec extends Schema.Class<ViewSpec>("ViewSpec")({
  // Optional: an absent filter matches every row (bounded only by `rowLimit`), rather than
  // requiring every caller to spell out an always-true predicate.
  filter: Schema.optional(ViewPredicate),
  groupBy: Schema.optional(Schema.String),
  sortColumn: Schema.optional(Schema.String),
  sortDescending: Schema.optional(Schema.Boolean),
  view: Schema.Literal("table", "list", "board"),
  visibleColumns: Schema.Array(Schema.String),
  // Plan §"Storage & domain model": the view-compiling authorizer is "single-statement,
  // read-only, bounded" — `rowLimit` is what makes a `ViewSpec` boundable; a positive integer
  // (never 0/negative/fractional) so the SQL compiler always has a real `LIMIT` to emit.
  rowLimit: Schema.Number.pipe(Schema.int(), Schema.positive())
}) {}
