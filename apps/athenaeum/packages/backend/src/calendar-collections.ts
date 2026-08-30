// `typed-storage-effect` collections backing `CalendarService` (`calendar-service-live.ts`) —
// same "one small collections module per repository/service" convention as
// `sharing-collections.ts`/`edges-repository-live.ts` (plan §"Storage & domain model", God-object
// mitigation). Three collections, per the plan's own `gatekeeperBindings`/`calendarEvents`/
// `bookmarks` collection names:
//
//   - `gatekeeperBindings` — one row per workspace-level external connection (domain's
//     `GatekeeperBinding`), keyed by `id`, with a `byWorkspaceId` index (a workspace's "does it already
//     have a google-calendar binding" lookup — `gatekeeperKind` is filtered in-memory over the
//     small per-workspace result set, not a second index, since one workspace is expected to have at most
//     a handful of bindings total across every gatekeeper kind it will ever have).
//   - `calendarEvents` — one row per synced `CalendarEvent` (domain's own entity, see that
//     file's header comment for the master/occurrence identity semantics), keyed by `id`, with a
//     `byWorkspaceId` index (`listCalendarEvents`) and a `byProviderEventId` index (sync-loop upsert:
//     "does a row for this provider event already exist" without a full-workspace scan).
//   - `bookmarks` — one row per captured `Bookmark`, keyed by `id`, with a `byWorkspaceId` index.
//
// Two more, added for the observer-verification wiring task ("wire the observer verification
// mechanism into the REAL Phase 4 SharingService"). Neither is a `@athenaeum/domain` schema type
// (both are backend-storage-only bookkeeping, never sent over Cap'n Web) — plain interfaces stored
// raw, same convention as `workspace-ownership.ts`'s own `WorkspaceMeta` (no `revive*`/`Schema.decodeUnknown`
// round trip, since nothing outside this DO ever reads or writes these rows directly):
//
//   - `calendarObservers` — one row per (bindingId, observerEmail) pair this workspace has ever asked
//     the gatekeeper to verify, per `docs/observers.md`'s "re-verify on every open" contract
//     (re-running `verifyObserver` overwrites the prior row rather than accumulating history).
//     `status: "granted"` means this observer's OWN connected Google account independently
//     qualifies to see this binding's calendar-derived content right now; `"denied"` covers both
//     "never attempted" and "attempted and failed" — either way, the content stays hidden from
//     them. Keyed by `${workspaceId}:${bindingId}:${observerEmail}` (see `calendarObserverKey` below),
//     with a `byWorkspaceId` index (`isCalendarContentVisible`'s per-caller lookup).
//   - `calendarDerivedNodes` — one row per Person node `CalendarService#findOrCreatePersonNode`
//     created FROM an attendee import (never a node a user created by hand, even one that later
//     happens to carry an `"email"` fact) — the real, queryable membership `listNodes`/`getNode`
//     filter against to enforce "linked Person nodes are excluded from what a non-qualifying
//     viewer can see" (task item 3). Keyed by `nodeId` (one row per node, at most once — the
//     attendee-import path only ever creates a Person node once, per `findOrCreatePersonNode`'s
//     own email-dedup cache), with a `byWorkspaceId` index.

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TreeFormatter } from "effect/ParseResult"
import { Bookmark, CalendarEvent, GatekeeperBinding, UnexpectedError, canonicalJsonBytes, sha256HexSync, type EntityId } from "@athenaeum/domain"
import {
  type BindingConnectionRecord,
  type CalendarOAuthAttemptId,
  type CalendarOAuthAttemptRecord,
  type CalendarOAuthStateNonceDigest,
  type ProviderConnectionId,
  type ProviderConnectionRecord
} from "./calendar-connection-identity.js"
import {
  collection,
  createEffectTypedStorage,
  type Collection,
  type NonUniqueIndex,
  type TypedStorageError
} from "@athenaeum/typed-storage-effect"

/** One workspace's-worth of "did observer X pass verification for binding Y" state. `message` is the
 *  human-readable denial reason (mirrors `ObserverVerificationDenied.message`, domain's
 *  `gatekeeper.ts`) — `undefined` for a granted row. */
export interface CalendarObserverRecord {
  readonly id: string
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly observerEmail: string
  /** Exact private provider connection for opaque observer verification; absent is legacy-only. */
  readonly observerConnectionId?: ProviderConnectionId
  readonly status: "granted" | "denied"
  readonly message?: string
  readonly verifiedAt: string
}

/** The one composite-key builder every reader/writer of `calendarObservers` must use — never
 *  hand-assembled inline, so the three parts can never drift out of the `:`-joined order this
 *  file's header comment documents. */
export const calendarObserverKey = (workspaceId: EntityId, bindingId: EntityId, observerEmail: string): string =>
  `${workspaceId}:${bindingId}:${observerEmail}`

/** One Person node created by attendee import — see this file's header comment. */
export interface CalendarDerivedNodeRecord {
  readonly nodeId: EntityId
  readonly workspaceId: EntityId
}

/** Private replay boundary for one provider event projection. Provider ids never leave this
 * collection: the public ledger/outbox carries only `sourceRevisionDigest`. */
export interface CalendarSourceRevisionRecord {
  readonly id: string
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly providerEventId: string
  readonly sourceRevisionDigest: string
  /** Provider-monotonic revision cursor when the connector supplies one (Google `updated`). */
  readonly sourceUpdatedAt?: string
  readonly calendarEventId: EntityId
  readonly status: "confirmed" | "cancelled"
  readonly appliedAt: string
}

/** Private binding-scoped ownership for a provider event. CalendarEvent remains public-schema
 * compatible; this record is the sole authority that prevents two connected accounts with the
 * same provider event id from colliding. */
export interface CalendarEventSourceIdentityRecord {
  readonly id: string
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly providerEventId: string
  readonly calendarEventId: EntityId
  readonly adoptedAt: string
}

/** One canonical private source-scope key for collection storage, replay, and Today projection. */
export const calendarEventSourceIdentityKey = (workspaceId: EntityId, bindingId: EntityId, providerEventId: string): string =>
  sha256HexSync(canonicalJsonBytes({ version: 1, workspaceId, bindingId, providerEventId }))

/** Private attendee observation dedupe record. `emailDigest` is a keyed workspace-local
 * fingerprint, never an email address, and is the sole identity exposed to workforce scheduling. */
export interface CalendarAttendeeObservationRecord {
  readonly id: string
  readonly workspaceId: EntityId
  readonly bindingId: EntityId
  readonly calendarEventId: EntityId
  readonly sourceRevisionDigest: string
  readonly emailDigest: string
  readonly personNodeId?: EntityId
  readonly observedAt: string
}

const gatekeeperBindingsCollectionSchema = collection<GatekeeperBinding>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (binding: GatekeeperBinding) => binding.workspaceId
  }
})

const calendarEventsCollectionSchema = collection<CalendarEvent>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (event: CalendarEvent) => event.workspaceId,
    byProviderEventId: (event: CalendarEvent) => event.providerEventId
  }
})

const bookmarksCollectionSchema = collection<Bookmark>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (bookmark: Bookmark) => bookmark.workspaceId
  }
})

const calendarObserversCollectionSchema = collection<CalendarObserverRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarObserverRecord) => record.workspaceId
  }
})

const calendarDerivedNodesCollectionSchema = collection<CalendarDerivedNodeRecord>()({
  primaryKey: "nodeId",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarDerivedNodeRecord) => record.workspaceId
  }
})

const calendarSourceRevisionsCollectionSchema = collection<CalendarSourceRevisionRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarSourceRevisionRecord) => record.workspaceId,
    byBindingAndProviderEvent: (record: CalendarSourceRevisionRecord) => `${record.bindingId}:${record.providerEventId}`
  }
})

const calendarEventSourceIdentitiesCollectionSchema = collection<CalendarEventSourceIdentityRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarEventSourceIdentityRecord) => record.workspaceId,
    byCalendarEventId: (record: CalendarEventSourceIdentityRecord) => record.calendarEventId
  }
})

const calendarAttendeeObservationsCollectionSchema = collection<CalendarAttendeeObservationRecord>()({
  primaryKey: "id",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarAttendeeObservationRecord) => record.workspaceId,
    byCalendarEventId: (record: CalendarAttendeeObservationRecord) => record.calendarEventId
  }
})

// MCA-B identity foundation. These are intentionally dormant until the connection lifecycle and
// Gatekeeper token-store migration are implemented: declaring the collections now makes the
// private mapping durable without changing how any legacy binding is read or routed.
const providerConnectionsCollectionSchema = collection<ProviderConnectionRecord>()({
  primaryKey: "providerConnectionId",
  nonUniqueIndexes: {
    byWorkspaceId: (record: ProviderConnectionRecord) => record.workspaceId
  }
})

const bindingConnectionsCollectionSchema = collection<BindingConnectionRecord>()({
  // A primary key on bindingId intentionally enforces one private connection map per binding.
  primaryKey: "bindingId",
  nonUniqueIndexes: {
    byWorkspaceId: (record: BindingConnectionRecord) => record.workspaceId,
    byProviderConnectionId: (record: BindingConnectionRecord) => record.providerConnectionId
  }
})

const calendarOAuthAttemptsCollectionSchema = collection<CalendarOAuthAttemptRecord>()({
  primaryKey: "attemptId",
  nonUniqueIndexes: {
    byWorkspaceId: (record: CalendarOAuthAttemptRecord) => record.workspaceId,
    byStateNonceDigest: (record: CalendarOAuthAttemptRecord) => record.stateNonceDigest,
    byProviderConnectionId: (record: CalendarOAuthAttemptRecord) => record.providerConnectionId
  }
})

export interface CalendarCollections {
  readonly gatekeeperBindings: Collection<GatekeeperBinding, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<GatekeeperBinding, EntityId>
  }
  readonly calendarEvents: Collection<CalendarEvent, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarEvent, EntityId>
    readonly byProviderEventId: NonUniqueIndex<CalendarEvent, string>
  }
  readonly bookmarks: Collection<Bookmark, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<Bookmark, EntityId>
  }
  readonly calendarObservers: Collection<CalendarObserverRecord, string> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarObserverRecord, EntityId>
  }
  readonly calendarDerivedNodes: Collection<CalendarDerivedNodeRecord, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarDerivedNodeRecord, EntityId>
  }
  readonly calendarSourceRevisions: Collection<CalendarSourceRevisionRecord, string> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarSourceRevisionRecord, EntityId>
    readonly byBindingAndProviderEvent: NonUniqueIndex<CalendarSourceRevisionRecord, string>
  }
  readonly calendarEventSourceIdentities: Collection<CalendarEventSourceIdentityRecord, string> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarEventSourceIdentityRecord, EntityId>
    readonly byCalendarEventId: NonUniqueIndex<CalendarEventSourceIdentityRecord, EntityId>
  }
  readonly calendarAttendeeObservations: Collection<CalendarAttendeeObservationRecord, string> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarAttendeeObservationRecord, EntityId>
    readonly byCalendarEventId: NonUniqueIndex<CalendarAttendeeObservationRecord, EntityId>
  }
  readonly providerConnections: Collection<ProviderConnectionRecord, ProviderConnectionId> & {
    readonly byWorkspaceId: NonUniqueIndex<ProviderConnectionRecord, EntityId>
  }
  readonly bindingConnections: Collection<BindingConnectionRecord, EntityId> & {
    readonly byWorkspaceId: NonUniqueIndex<BindingConnectionRecord, EntityId>
    readonly byProviderConnectionId: NonUniqueIndex<BindingConnectionRecord, ProviderConnectionId>
  }
  readonly calendarOAuthAttempts: Collection<CalendarOAuthAttemptRecord, CalendarOAuthAttemptId> & {
    readonly byWorkspaceId: NonUniqueIndex<CalendarOAuthAttemptRecord, EntityId>
    readonly byStateNonceDigest: NonUniqueIndex<CalendarOAuthAttemptRecord, CalendarOAuthStateNonceDigest>
    readonly byProviderConnectionId: NonUniqueIndex<CalendarOAuthAttemptRecord, ProviderConnectionId>
  }
}

export const makeCalendarCollections = (storage: DurableObjectStorage): CalendarCollections => {
  const typedStorage = createEffectTypedStorage(storage, {
    collections: {
      gatekeeperBindings: gatekeeperBindingsCollectionSchema,
      calendarEvents: calendarEventsCollectionSchema,
      bookmarks: bookmarksCollectionSchema,
      calendarObservers: calendarObserversCollectionSchema,
      calendarDerivedNodes: calendarDerivedNodesCollectionSchema,
      calendarSourceRevisions: calendarSourceRevisionsCollectionSchema,
      calendarEventSourceIdentities: calendarEventSourceIdentitiesCollectionSchema,
      calendarAttendeeObservations: calendarAttendeeObservationsCollectionSchema,
      providerConnections: providerConnectionsCollectionSchema,
      bindingConnections: bindingConnectionsCollectionSchema,
      calendarOAuthAttempts: calendarOAuthAttemptsCollectionSchema
    }
  })
  return {
    gatekeeperBindings: typedStorage.gatekeeperBindings,
    calendarEvents: typedStorage.calendarEvents,
    bookmarks: typedStorage.bookmarks,
    calendarObservers: typedStorage.calendarObservers,
    calendarDerivedNodes: typedStorage.calendarDerivedNodes,
    calendarSourceRevisions: typedStorage.calendarSourceRevisions,
    calendarEventSourceIdentities: typedStorage.calendarEventSourceIdentities,
    calendarAttendeeObservations: typedStorage.calendarAttendeeObservations,
    providerConnections: typedStorage.providerConnections,
    bindingConnections: typedStorage.bindingConnections,
    calendarOAuthAttempts: typedStorage.calendarOAuthAttempts
  }
}

export const toUnexpectedError = (error: TypedStorageError): UnexpectedError =>
  new UnexpectedError({
    message:
      error._tag === "StorageError"
        ? error.message
        : `index conflict: ${error.collection}.${error.index} (key ${error.key})`
  })

/** `DurableObjectStorage` round-trips values through structured clone — a record read back is a
 *  plain object, not the `Schema.Class` instance callers need (same concern as every other
 *  `revive*` helper in this codebase — `nodes-repository-live.ts#reviveNode` is this file's own
 *  template). */
export const reviveGatekeeperBinding = (raw: unknown): Effect.Effect<GatekeeperBinding, UnexpectedError> =>
  Schema.decodeUnknown(GatekeeperBinding)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored gatekeeper binding: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveCalendarEvent = (raw: unknown): Effect.Effect<CalendarEvent, UnexpectedError> =>
  Schema.decodeUnknown(CalendarEvent)(raw).pipe(
    Effect.mapError(
      (parseError) =>
        new UnexpectedError({ message: `corrupt stored calendar event: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )

export const reviveBookmark = (raw: unknown): Effect.Effect<Bookmark, UnexpectedError> =>
  Schema.decodeUnknown(Bookmark)(raw).pipe(
    Effect.mapError(
      (parseError) => new UnexpectedError({ message: `corrupt stored bookmark: ${TreeFormatter.formatErrorSync(parseError)}` })
    )
  )
