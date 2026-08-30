import * as Schema from "effect/Schema"
import { EntityId, IsoDateTimeString } from "./node.js"

/** The public, read-only audit vocabulary. Keep this narrower than the internal ledger tables:
 * request identities, fingerprints, policies, payloads, receipts, and outbox rows never cross the
 * RPC boundary. */
export const LedgerActivityType = Schema.Literal(
  "createNode",
  "createNodeWithIntent",
  "acceptChatFork",
  "acceptPageProposal",
  "agentChangeDecision",
  "applySupertag",
  "addFact",
  "createEdge",
  "createTag",
  "defineTagField",
  "assignTag",
  "unassignTag",
  "syncNoteReferences",
  "createRelationDefinition",
  "createBookmark",
  "linkCalendarEventToNode",
  "appendTranscriptSegment",
  "startMeeting",
  "prepareMeetingInDailyNote",
  "migrateLegacyPage",
  "commitLoroPageContent",
  "ensureLoroPage"
)
export type LedgerActivityType = typeof LedgerActivityType.Type

export const LedgerActivityActor = Schema.Literal("you", "workspace-member", "anonymous")
export type LedgerActivityActor = typeof LedgerActivityActor.Type

/** A privacy-safe description of the actor which made a recorded change. The historical
 * `actor` field remains for old clients; this detail never includes principal, grant, or run ids. */
export class LedgerActivityActorDetail extends Schema.Class<LedgerActivityActorDetail>("LedgerActivityActorDetail")({
  kind: Schema.Literal("user", "employee", "system"),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))
}) {}

/** The minimal stable target suitable for navigation from Today. */
export class LedgerActivityTarget extends Schema.Class<LedgerActivityTarget>("LedgerActivityTarget")({
  kind: Schema.Literal("node"),
  id: EntityId
}) {}

export class ListRecentLedgerActivityInput extends Schema.Class<ListRecentLedgerActivityInput>("ListRecentLedgerActivityInput")({
  workspaceId: EntityId,
  limit: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  /** Optional half-open timestamp window. Omitting both preserves the historical latest-N feed. */
  from: Schema.optional(IsoDateTimeString),
  to: Schema.optional(IsoDateTimeString)
}) {}

export class LedgerActivityEntry extends Schema.Class<LedgerActivityEntry>("LedgerActivityEntry")({
  occurredAt: IsoDateTimeString,
  type: LedgerActivityType,
  actor: LedgerActivityActor,
  message: Schema.String.pipe(Schema.minLength(1)),
  actorDetail: Schema.optional(LedgerActivityActorDetail),
  target: Schema.optional(LedgerActivityTarget)
}) {}

export class ListRecentLedgerActivityOutput extends Schema.Class<ListRecentLedgerActivityOutput>("ListRecentLedgerActivityOutput")({
  entries: Schema.Array(LedgerActivityEntry)
}) {}
