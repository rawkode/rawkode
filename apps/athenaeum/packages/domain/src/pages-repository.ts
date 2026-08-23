import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { PageNotFound, UnexpectedError } from "./errors.js"
import type { EntityId } from "./node.js"
import type { Page } from "./page.js"

// Same `Context.Tag` pattern as `NodesRepository` (nodes-repository.ts) — interface only, real
// implementation lives in `backend`'s `typed-storage-effect`-backed Layer. One deliberate shape
// difference from `NodesRepository`: no `list(workspaceId)`. `Page` (see page.ts) has no `workspaceId`
// field of its own — it's a 1:0-or-1 companion keyed by `nodeId`, per the plan's own `pages`
// collection shape (`{nodeId, ...}`, no `workspaceId`) — so there is no workspace-scoped listing to do
// here; enumerating a workspace's pages goes through `NodesRepository.list` and then `get`s each
// node's page, not through a `PagesRepository` listing of its own. `delete` exists (unlike
// `NodesRepository`, which has no delete in Phase 0) because a page can legitimately stop
// existing independent of its node — a node's prose body is removed while the node itself (and
// its tags/facts) remains.
export class PagesRepository extends Context.Tag("@athenaeum/domain/PagesRepository")<
  PagesRepository,
  {
    readonly get: (nodeId: EntityId) => Effect.Effect<Page, PageNotFound | UnexpectedError>
    readonly put: (page: Page) => Effect.Effect<Page, UnexpectedError>
    readonly delete: (nodeId: EntityId) => Effect.Effect<void, UnexpectedError>
  }
>() {}
