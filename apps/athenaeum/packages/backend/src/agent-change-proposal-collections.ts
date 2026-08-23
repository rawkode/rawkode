import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { AgentChangeProposal, AgentChangeProposalDecision, AgentChangeReservation, UnexpectedError, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type NonUniqueIndex, type TypedStorageError } from "@athenaeum/typed-storage-effect"

const proposals = collection<AgentChangeProposal>()({
  primaryKey: "proposalId",
  nonUniqueIndexes: {
    byRequestFingerprint: (proposal: AgentChangeProposal) => proposal.requestFingerprint,
    byChatId: (proposal: AgentChangeProposal) => proposal.chatId
  }
})
const reservations = collection<AgentChangeReservation>()({ primaryKey: "key" })
const decisions = collection<AgentChangeProposalDecision>()({ primaryKey: "proposalId" })

export interface AgentChangeProposalCollections {
  readonly proposals: Collection<AgentChangeProposal, EntityId> & {
    readonly byRequestFingerprint: NonUniqueIndex<AgentChangeProposal, string>
    readonly byChatId: NonUniqueIndex<AgentChangeProposal, EntityId>
  }
  /** Primary key is `${kind}:${id}`: this is the durable uniqueness constraint, not a read-then-write convention. */
  readonly reservations: Collection<AgentChangeReservation, string>
  readonly decisions: Collection<AgentChangeProposalDecision, EntityId>
}

/** `Collection.put` is intentionally an upsert. Capture therefore uses these SQLite primary-key
 * tables as its authoritative insert-if-absent reservation and request-identity constraints. */
export const makeAgentChangeProposalCollections = (storage: DurableObjectStorage, sql: SqlStorage): AgentChangeProposalCollections => {
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_change_request_identities (
    requestId TEXT PRIMARY KEY, canonicalPayload TEXT NOT NULL, fingerprint TEXT NOT NULL, proposalId TEXT NOT NULL UNIQUE
  )`)
  // P5.1 is not published yet, but make a local/restarted DO carrying an earlier capture table
  // fail closed on replay rather than silently treating its caller fingerprint as canonical.
  const identityColumns = sql.exec<{ name: string }>("PRAGMA table_info(agent_change_request_identities)").toArray()
  if (!identityColumns.some((column) => column.name === "canonicalPayload")) {
    sql.exec("ALTER TABLE agent_change_request_identities ADD COLUMN canonicalPayload TEXT")
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS agent_change_reservation_keys (
    reservationKey TEXT PRIMARY KEY, kind TEXT NOT NULL, entityId TEXT NOT NULL, proposalId TEXT NOT NULL,
    chatId TEXT NOT NULL, expectedVersion TEXT NOT NULL, expectedDigest TEXT NOT NULL, capturedAt TEXT NOT NULL
  )`)
  const typed = createEffectTypedStorage(storage, {
    collections: { agentChangeProposals: proposals, agentChangeReservations: reservations, agentChangeDecisions: decisions }
  })
  return { proposals: typed.agentChangeProposals, reservations: typed.agentChangeReservations, decisions: typed.agentChangeDecisions }
}

export const proposalStorageError = (error: TypedStorageError): UnexpectedError => new UnexpectedError({
  message: error._tag === "StorageError" ? error.message : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
})

export const reviveAgentChangeProposal = (raw: unknown): Effect.Effect<AgentChangeProposal, UnexpectedError> =>
  Schema.decodeUnknown(AgentChangeProposal)(raw).pipe(Effect.mapError((error) => new UnexpectedError({ message: `corrupt stored agent change proposal: ${TreeFormatter.formatErrorSync(error)}` })))
