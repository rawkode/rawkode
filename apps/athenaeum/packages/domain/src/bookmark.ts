import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

// Phase 5 domain-extension task, item 2: `Bookmark` — per the plan's "Phase 5 — First gatekeeper:
// Google Calendar + Bookmarks... Bookmarks ship alongside (low complexity, validates 'external
// capture → node' before Phase 6's higher-stakes capture flows)." Deliberately the simplest new
// entity this stage adds: a capture-inbox record, not a gatekeeper-backed sync target — nothing
// about `Bookmark` requires OAuth, a provider API, or observer verification, which is exactly why
// the plan schedules it alongside Calendar as a low-complexity companion.

/** An absolute `http`/`https` URL — validated, not normalized (same "validate, don't normalize"
 *  discipline as `EntityId`/`Email`: a caller-side capture flow, e.g. a browser extension or a
 *  share-sheet target, is expected to hand this schema an already-well-formed absolute URL; this
 *  schema's job is only to reject malformed input before it reaches storage, not to canonicalize
 *  it (strip tracking params, resolve redirects, etc.) — that belongs to whatever future capture
 *  service builds on this schema, not the wire type itself). Branded (rather than a bare
 *  `Schema.String`) for the same reason `ShareKeyHash`/`EntityId`/`Email` all are: a bookmark URL
 *  should never be constructible from, or mistaken for, an arbitrary unvalidated string.
 *
 *  A plain regex, matching `EntityId`'s ULID/UUID pattern and `Email`'s address pattern, rather
 *  than the runtime `URL` constructor: this package has zero Cloudflare/Node.js/DOM-specific
 *  dependencies (`domain`'s own `tsconfig.json` deliberately sets `lib: ["ES2022"]`, no `dom`/
 *  `webworker` — `URL` is not in that type universe), the same reason `dev-auth.ts`'s
 *  `crypto.subtle`-based logic lives in `backend`, not here. */
const httpUrlPattern = /^https?:\/\/\S+$/i

export const BookmarkUrl = Schema.String.pipe(
  Schema.filter((value) => httpUrlPattern.test(value), {
    message: () => "BookmarkUrl must be an absolute http(s) URL"
  }),
  Schema.brand("BookmarkUrl")
)
export type BookmarkUrl = typeof BookmarkUrl.Type

/**
 * A captured bookmark, per the task's own `{id, workspaceId, url, title?, capturedAt, linkedNodeId?}`
 * shape. `title` is optional (a capture flow may only have a raw URL at capture time, e.g. a
 * share-sheet target with no page-title metadata available yet — unlike `CalendarEvent.title`,
 * which is always populated because it is copied straight from a provider's own event resource).
 * `linkedNodeId` mirrors `CalendarEvent.linkedNodeId`'s same "external capture → optional
 * companion node the user can annotate" shape (this file's header comment) — kept optional for
 * the identical reason: this schema takes no position on whether a companion node is created
 * eagerly or lazily, only on how one is referenced once it exists.
 */
export class Bookmark extends Schema.Class<Bookmark>("Bookmark")({
  id: EntityId,
  workspaceId: EntityId,
  url: BookmarkUrl,
  title: Schema.optional(Schema.String),
  capturedAt: IsoDateTimeString,
  linkedNodeId: Schema.optional(EntityId)
}) {}
