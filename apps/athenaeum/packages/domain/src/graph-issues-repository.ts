import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { GraphIssueNotFound, UnexpectedError } from "./errors.js"
import type { GraphIssue } from "./graph-issue.js"
import type { EntityId } from "./node.js"

// Same `Context.Tag` pattern as `NodesRepository` — get/put/list(workspaceId). `list(workspaceId)`
// feeds the `graph_issues` view. No `resolve`/`delete` method: per Evolution Rule #4 (plan
// §"Storage & domain model") a `GraphIssue` is a durable exposed record of a preserved conflict,
// not a task queue entry to be cleared by this repository — how/whether a `GraphIssue` is ever
// retired (e.g. once a user manually resolves the underlying cardinality conflict by deleting
// one of the conflicting edges) is a `GraphService`-level policy decision for a later stage, not
// part of this storage interface.
export class GraphIssuesRepository extends Context.Tag(
  "@athenaeum/domain/GraphIssuesRepository"
)<
  GraphIssuesRepository,
  {
    readonly get: (
      graphIssueId: EntityId
    ) => Effect.Effect<GraphIssue, GraphIssueNotFound | UnexpectedError>
    readonly put: (graphIssue: GraphIssue) => Effect.Effect<GraphIssue, UnexpectedError>
    readonly list: (
      workspaceId: EntityId
    ) => Effect.Effect<ReadonlyArray<GraphIssue>, UnexpectedError>
  }
>() {}
