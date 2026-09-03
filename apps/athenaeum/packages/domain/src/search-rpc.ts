import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Plan §"Full-text search" (resolved by the Decisions stage: "Search is a server RPC over
// WorkspaceDurableObject's DO SQLite, uniform for web and native... Implement graph_text_search as
// a real FTS5 virtual table... a searchNodes RPC method"). Wire schemas for that RPC — kept in
// their own file rather than folded into graph-rpc.ts because `graph_text_search` is
// deliberately *not* reachable through the general `RunViewInput`/`ViewSpec` compiler (see
// `read-model.ts`'s `compileRunView` doc comment for why: FTS5 `MATCH` query syntax doesn't fit
// the `eq`/`in`/`hasTag` predicate grammar `ViewPredicate` models), so this is a distinct,
// narrower RPC surface, not a `GraphViewName` case of the general one.

export class SearchNodesInput extends Schema.Class<SearchNodesInput>("SearchNodesInput")({
  workspaceId: EntityId,
  query: Schema.String.pipe(Schema.minLength(1)),
  // Optional so callers don't have to think about a limit for the common case; the backend
  // still clamps whatever's supplied (or defaulted) to its own hard cap — see `read-model.ts`'s
  // `MAX_SEARCH_RESULTS`.
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive()))
}) {}

/** One search hit: the matching node's id/title plus a short excerpt of the matched page body
 *  (empty string if the node has no page, i.e. the match was on `title` alone). */
export class SearchResultEntry extends Schema.Class<SearchResultEntry>("SearchResultEntry")({
  nodeId: EntityId,
  title: Schema.String,
  snippet: Schema.String
}) {}

export class SearchNodesOutput extends Schema.Class<SearchNodesOutput>("SearchNodesOutput")({
  results: Schema.Array(SearchResultEntry)
}) {}
