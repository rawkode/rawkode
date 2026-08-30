// `CalendarService` — the Effect Service behind all eight `gatekeeper-rpc.ts` methods
// (connect/callback/disconnect/sync/list/link + createBookmark/listBookmarks). Same
// `WorkspaceDurableObject`-composed-from-Effect-Services convention as `GraphService`/`NotesService`
// (plan §"Storage & domain model", God-object mitigation) — backend-internal orchestration, not a
// `@athenaeum/domain` `Context.Tag` (mirrors `GraphService`'s own placement rationale verbatim:
// this has real business logic — calendar-merge, attendee dedup — with no home in `domain`'s
// zero-CF/React repository interfaces).
//
// **Attendee-to-Person-node import (task item 4)**: the provider projection stores only the private
// event and attendee observations. A calendar relationship concierge owns Person resolution and
// creation as a ledgered employee job, where deterministic ids and the transaction-time graph
// lookup make concurrent observations converge on one identity. This split is intentional: a
// provider retry cannot create an un-attributed public Person, and every resulting graph mutation
// carries the exact job/run custody and commit message.
//
// **Recurring-event identity (task's own `calendar-event.ts` semantics)**: `sync()` calls
// `events.list` with `singleEvents: true` — Google's own documented behavior for that mode is
// that only EXPANDED INSTANCES are returned, never the raw series-master resource itself (each
// instance instead carries `recurringEventId` pointing AT the master's id). This stage
// synthesizes a minimal master row (`providerEventId === seriesId`, `seriesId === seriesId`, no
// `occurrenceId`/`masterRecordId`) the FIRST time an occurrence of a not-yet-seen series is seen,
// rather than issuing a separate `events.get(seriesId)` call for the master's own true resource —
// a documented, deliberate simplification given this stage's scope (a full implementation would
// fetch and periodically refresh the true master resource; this stage's synthesized master is
// good enough to give every occurrence a real, stable `masterRecordId` to point at, which is the
// property `calendar-event.ts`'s own doc comment names as the important one: "what lets a client
// resolve which master row does this occurrence belong to with a single indexed lookup").
// `occurrenceId` uses the occurrence's CURRENT `start` (not its ORIGINAL pre-any-edit start, which
// this stage has no way to know on a first sync) — another documented simplification of
// `calendar-event.ts`'s own "stable across a cancel-then-reappear cycle" ideal.
//
// **Observer verification (task: "wire the observer verification mechanism into the REAL Phase 4
// SharingService")** — `verifyObserver`/`isCalendarContentVisible`/`hiddenCalendarDerivedNodeIds`
// are the real Strategy B/C wiring this task adds. `WorkspaceDurableObject`'s `addCollaborator`/
// `redeemShareLink` call `verifyObserver` once a new viewer is added to a workspace that has a
// `google-calendar` binding — see that method's own doc comment for the full round trip (mint the
// observer's own verifier, hand it to the bound account's `addObserver`, persist the outcome).
// **The enforcement itself is a real filter on reads, not a comment**: `listEvents` returns `[]`
// outright for a non-qualifying viewer (every row in `calendarEvents` is calendar-sourced, so
// there is nothing else to partially show), and `hiddenCalendarDerivedNodeIds` gives
// `workspace-durable-object.ts`'s `listNodes`/`getNode` the exact node-id set to exclude — the
// attendee-imported Person nodes `calendarDerivedNodes` (calendar-collections.ts) tracks. A
// qualifying viewer (the workspace owner, the account that connected the calendar, or an observer
// whose own connected account independently passed verification) sees everything; every other
// workspace-governed read (nodes NOT in that set, facts, tags, pages, chats, …) is completely
// unaffected — sharing a workspace does not itself gate on this, only the calendar-derived subset does
// (this file's own `isCalendarContentVisible` is the ONE gate both filters share, so they can never
// disagree about who currently qualifies).
//
// **`Bookmark.linkedNodeId` observer-visibility (adversarial-review fix, Phase 6)**: `listBookmarks`
// below returns rows as stored — it takes no position on whether the caller can currently see the
// node `linkedNodeId` points at, same split `listEvents` draws for its own already-real
// `isCalendarContentVisible` gate. The filter lives one layer up, in `workspace-durable-object.ts`'s
// `listBookmarks` RPC method (`sanitizeBookmarkLinkedNodeId`, calling this file's own
// `hiddenCalendarDerivedNodeIds` — no new gate, the identical one `listNodes`/`getNode` already
// use). Currently dormant (no RPC sets `linkedNodeId` on a `Bookmark` yet, matching
// `linkEventToNode`'s own "someone else's job" scope note above) but load-bearing the moment one
// does — this was the identical pre-existing (Phase 5) gap the Phase 6 adversarial review flagged
// as the same systemic pattern `Meeting.linkedNodeId` had, fixed for both at once.

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  Bookmark,
  BookmarkUrl,
  BaseTagIds,
  CalendarEvent,
  CalendarEventAttendee,
  type CalendarEventTime,
  Email,
  EntityId,
  FactsRepository,
  GatekeeperBinding,
  GatekeeperBindingSummary,
  GatekeeperNotConnected,
  GetTodayBriefInput,
  GetTodayBriefOutput,
  IanaTimeZone,
  GoogleCalendarBindingConfig,
  IsoDateTimeString,
  LocalDate,
  NodesRepository,
  OAuthExchangeFailed,
  UnexpectedError,
  ValidationError,
  TodayBriefCalendarHistory,
  TodayBriefEvent,
  TodayBriefPerson,
  canonicalJsonBytes,
  sha256HexSync,
  type DomainError,
  type MutationAttribution
} from "@athenaeum/domain"
import {
  CalendarGatekeeperClient,
  type RemoteCalendarEvent,
  type RemoteCalendarTime
} from "./calendar-gatekeeper-client.js"
import {
  calendarObserverKey,
  makeCalendarCollections,
  reviveBookmark,
  reviveCalendarEvent,
  reviveGatekeeperBinding,
  toUnexpectedError,
  type CalendarCollections,
  type CalendarAttendeeObservationRecord,
  type CalendarDerivedNodeRecord,
  type CalendarSourceRevisionRecord,
  type CalendarObserverRecord
} from "./calendar-collections.js"
import { CalendarProjectionGateway } from "./calendar-projection-gateway.js"
import { planCalendarRemoteEventWithSecret } from "./calendar-projection-plan.js"
import {
  digestCalendarOAuthStateNonce,
  makeCalendarOAuthStateNonce,
  mintCalendarOAuthState,
  mintCalendarOAuthAttemptState,
  verifyCalendarOAuthState,
  verifyCalendarOAuthAttemptState
} from "./calendar-oauth-state.js"
import {
  preparePendingCalendarOAuthAdmission,
  resolveGatekeeperConnectionLocator,
  type BindingConnectionRecord,
  CalendarOAuthAttemptRecord,
  ProviderConnectionRecord,
  type GatekeeperConnectionLocator
} from "./calendar-connection-identity.js"
import { GraphService } from "./graph-service-live.js"
import { SharingService } from "./sharing-service-live.js"
import { SyncFeedService } from "./sync-feed-service-live.js"

const now = (): IsoDateTimeString => IsoDateTimeString.make(new Date().toISOString())

const attendeeEmailPredicate = "email"

/** Pure CAS fence used by the callback's final private admission transaction. */
export const canFinalizeCalendarOAuthAttempt = (input: {
  readonly attempt: CalendarOAuthAttemptRecord
  readonly workspaceId: EntityId
  readonly principal: Email
  readonly providerConnectionId: string
  readonly bindingId: EntityId
  readonly leaseToken: string | undefined
  readonly fence: number
  readonly nowMs: number
}): boolean =>
  input.attempt.lifecycle === "exchanging" &&
  input.attempt.leaseToken === input.leaseToken &&
  input.attempt.fence === input.fence &&
  input.attempt.leaseExpiresAt !== undefined &&
  new Date(input.attempt.leaseExpiresAt).getTime() > input.nowMs &&
  new Date(input.attempt.expiresAt).getTime() > input.nowMs &&
  input.attempt.workspaceId === input.workspaceId &&
  input.attempt.principal === input.principal &&
  input.attempt.providerConnectionId === input.providerConnectionId &&
  input.attempt.bindingId === input.bindingId

/** Pages fetched per `sync()` call, bounded well under a Worker's CPU/subrequest budget — a real
 *  implementation would checkpoint `pageToken`/`syncToken` across calls (new-notes' own cited
 *  "one SQLite transaction applies a page... a crash before that commit resumes the immutable
 *  range" pattern) rather than looping this many pages in one RPC round trip; this stage's `sync`
 *  is a single-shot "full window, bounded" pass, documented as a simplification the next stage's
 *  real checkpointed incremental-sync loop should replace. */
const MAX_PAGES_PER_SYNC = 25

const remoteTimeToCalendarEventTime = (value: RemoteCalendarTime): CalendarEventTime =>
  value.kind === "date"
    ? { kind: "date", date: value.date }
    : { kind: "dateTime", dateTime: value.dateTime, ...(value.timeZone ? { timeZone: value.timeZone } : {}) }

export interface CalendarServiceApi {
  /** `redirectUri` is NOT a per-call argument — bound once via `CalendarServiceConfig` (below),
   *  same "config, not caller-supplied" reasoning as `gatekeeper-account-service-live.ts`'s own
   *  `accountEmail`: the redirect URI is a fixed, Google-Cloud-Console-registered value for this
   *  deployment (`AuthorizationUrlOptions.redirectUri`'s own doc comment — "MUST byte-for-byte
   *  match a URI registered in Google Cloud Console"), not something a caller should be able to
   *  vary per RPC call. `ConnectGoogleCalendarInput` (gatekeeper-rpc.ts) has no `redirectUri`
   *  field for exactly this reason. */
  readonly connect: (
    workspaceId: EntityId,
    boundByEmail: string
  ) => Effect.Effect<{ readonly authorizationUrl: string; readonly state: string }, DomainError>

  readonly completeOAuthCallback: (
    workspaceId: EntityId,
    code: string,
    state: string,
    calendarId: string,
    mode: "selected" | "allVisible",
    principal: string
  ) => Effect.Effect<GatekeeperBinding, DomainError>

  readonly disconnect: (workspaceId: EntityId, bindingId: EntityId, principal: string) => Effect.Effect<boolean, DomainError>

  /** Sync is an attributed write: user-triggered pulls use `humanUi`; a future scheduled provider
   * pull must supply its real employee job attribution. System/anonymous writes are rejected at the
   * RPC boundary rather than being labelled as a synthetic concierge run. */
  readonly sync: (workspaceId: EntityId, bindingId: EntityId, attribution: MutationAttribution, principal: string) => Effect.Effect<{ readonly triggered: boolean }, DomainError>

  /** Lists privacy-safe management projections of every Google Calendar binding for a workspace.
   *  This reads only the local binding index: it never contacts the provider, refreshes OAuth
   *  credentials, records observers, or appends to the sync feed. */
  readonly listBindings: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<GatekeeperBindingSummary>, DomainError>

  /** `callerEmail` is `undefined` only for an anonymous caller on an UNGOVERNED workspace (a governed
   *  workspace's `requireRoleForGovernedWorkspace` gate already rejects an anonymous caller upstream, in
   *  `workspace-durable-object.ts`, before this method is ever reached) — see `isCalendarContentVisible`'s
   *  own doc comment for exactly how that maps to visibility. */
  readonly listEvents: (
    workspaceId: EntityId,
    from: IsoDateTimeString | undefined,
    to: IsoDateTimeString | undefined,
    callerEmail: string | undefined
  ) => Effect.Effect<ReadonlyArray<CalendarEvent>, DomainError>

  /** Read-only local projection for the Today Brief. Visibility denial intentionally produces the
   * same retained-data result as an empty local projection. */
  readonly getTodayBrief: (
    input: GetTodayBriefInput,
    callerEmail: string | undefined
  ) => Effect.Effect<GetTodayBriefOutput, never>

  /** Resolves one privacy-safe retained event by its opaque occurrence key. This is an internal
   * preparation primitive: callers receive display names only, never provider ids or addresses. */
  readonly findTodayBriefEvent: (
    workspaceId: EntityId,
    localDate: LocalDate,
    timeZone: IanaTimeZone,
    occurrenceKey: string,
    callerEmail: string | undefined
  ) => Effect.Effect<TodayBriefEvent | undefined, DomainError>

  readonly linkEventToNode: (
    workspaceId: EntityId,
    calendarEventId: EntityId,
    nodeId: EntityId
  ) => Effect.Effect<CalendarEvent, DomainError>

  readonly createBookmark: (
    workspaceId: EntityId,
    url: BookmarkUrl,
    title: string | undefined
  ) => Effect.Effect<Bookmark, DomainError>

  readonly listBookmarks: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Bookmark>, DomainError>

  /**
   * Sets `Bookmark.linkedNodeId` — no RPC calls this yet (see this file's own header comment on
   * the `linkedNodeId` observer-visibility fix), reached only via
   * `WorkspaceDurableObject#debugLinkBookmarkToNode` (`ctx.exports`-only, same access rule as
   * `CalendarService`'s other debug-only surfaces). Exists specifically so
   * `test/calendar-service.test.ts` can genuinely exercise the `linkedNodeId` observer-visibility
   * filter end-to-end. Mirrors `linkEventToNode` exactly, including its node-existence check and
   * workspaceId defense-in-depth.
   */
  readonly linkBookmarkToNode: (
    workspaceId: EntityId,
    bookmarkId: EntityId,
    nodeId: EntityId
  ) => Effect.Effect<Bookmark, DomainError>

  // --- Observer verification (task: "wire the observer verification mechanism into the REAL
  // Phase 4 SharingService") — see this file's header comment for the full design. ---------------

  /**
   * Called by `workspace-durable-object.ts`'s `addCollaborator`/`redeemShareLink` once a NEW viewer
   * has been granted access to a workspace, per `docs/observers.md` §7's `addObserver()` contract
   * ("must throw if the user represented by verifier is not allowed to observe everything read
   * through this gatekeeper so far"). Verifies `observerEmail` against EVERY `google-calendar`
   * binding this workspace has (there is usually one, but this loops in case a future stage allows
   * more) and persists the outcome per binding — never fails the returned Effect on a denial (or
   * on the observer having no connected Google account at all, or on the gatekeeper being
   * unreachable/unconfigured): every failure mode folds into a stored `"denied"` row, so a
   * newly-added collaborator with no Google account of their own is silently excluded from
   * calendar-derived content rather than blocking `addCollaborator`/`redeemShareLink` itself. A
   * workspace with no `google-calendar` binding at all is a no-op (nothing to verify against).
   */
  readonly verifyObserver: (workspaceId: EntityId, observerEmail: string) => Effect.Effect<void, DomainError>

  /**
   * The one gate `listEvents`/`hiddenCalendarDerivedNodeIds` both consult — "can `callerEmail`
   * currently see this workspace's calendar-derived content." `true` whenever: (a) the workspace has no
   * `google-calendar` binding at all (nothing to gate); (b) `callerEmail` is the workspace's owner;
   * (c) `callerEmail` is the account that connected ANY of the workspace's calendar bindings (their
   * own data); (d) `callerEmail` is `undefined` AND the workspace is ungoverned (no owner at all —
   * the "ungoverned workspace stays fully open" carve-out `requireRoleForGovernedWorkspace` already
   * establishes for every other governed-read gate in this codebase); otherwise, `true` only if
   * the LAST `verifyObserver` run for `callerEmail` stored `"granted"` for every one of the
   * workspace's bindings (a viewer who was never verified at all — never added while a binding
   * existed — is `"denied"` by the same absence-means-denied rule `resolveCaller`'s own "no role
   * at all" case uses elsewhere in this codebase).
   */
  readonly isCalendarContentVisible: (
    workspaceId: EntityId,
    callerEmail: string | undefined
  ) => Effect.Effect<boolean, DomainError>

  /** The exact node-id set `workspace-durable-object.ts`'s `listNodes`/`getNode` must exclude for
   *  `callerEmail` right now — empty whenever `isCalendarContentVisible` is `true`, otherwise
   *  every node `calendarDerivedNodes` (calendar-collections.ts) has ever recorded for this
   *  workspace (Person nodes created by the ledgered concierge). */
  readonly hiddenCalendarDerivedNodeIds: (
    workspaceId: EntityId,
    callerEmail: string | undefined
  ) => Effect.Effect<ReadonlySet<EntityId>, DomainError>
}

export class CalendarService extends Context.Tag("@athenaeum/backend/CalendarService")<
  CalendarService,
  CalendarServiceApi
>() {}

export interface CalendarServiceConfig {
  /** Signs/verifies the OAuth `state` CSRF nonce (`calendar-oauth-state.ts`) — empty string means
   *  unconfigured (see `requireStateSecretConfigured` below), never a silently guessable default. */
  readonly stateSecret: string
  /** The fixed, registered OAuth redirect URI for this deployment — see `CalendarServiceApi
   *  .connect`'s own doc comment. Empty string means unconfigured, handled identically to
   *  `stateSecret` (`connect`/`completeOAuthCallback` both fail closed with the same clear
   *  `ValidationError` rather than sending Google a blank `redirect_uri`). */
  readonly redirectUri: string
  /** Private workspace/deployment key used for attendee identity HMACs. In local development this
   * may intentionally reuse the OAuth state secret; production should provide a separately
   * rotated secret. */
  readonly attendeeDigestSecret?: string
  /** The Workspace DO-owned atomic write boundary. Calendar provider I/O remains in this
   * service; every resulting second-brain projection is committed through this gateway. */
  readonly projectionGateway: CalendarProjectionGateway
  /** Raw storage is used only for the outer private OAuth admission CAS transaction. */
  readonly storage: DurableObjectStorage
}

export const makeCalendarServiceLive = (
  collections: CalendarCollections,
  config: CalendarServiceConfig
): Layer.Layer<
  CalendarService,
  never,
  CalendarGatekeeperClient | GraphService | NodesRepository | FactsRepository | SyncFeedService | SharingService
> =>
  Layer.effect(
    CalendarService,
    Effect.gen(function* () {
      const gatekeeperClient = yield* CalendarGatekeeperClient
      const graph = yield* GraphService
      const nodesRepository = yield* NodesRepository
      const factsRepository = yield* FactsRepository
      const syncFeed = yield* SyncFeedService
      const sharing = yield* SharingService
      const projectionGateway = config.projectionGateway
      const transaction = <A>(effect: Effect.Effect<A, DomainError>): Effect.Effect<A, DomainError> =>
        Effect.suspend(() => {
          try {
            // Run the Effect to an Exit inside the synchronous DO transaction, then rehydrate the
            // exact typed failure outside it; a validation conflict must not be collapsed into an
            // unexpected storage error merely because it crossed the transaction boundary.
            return Exit.match(config.storage.transactionSync(() => Effect.runSyncExit(effect)), {
              onFailure: Effect.failCause,
              onSuccess: Effect.succeed
            })
          } catch (cause) {
            return Effect.fail(new UnexpectedError({ message: `Calendar OAuth private transaction failed: ${describeError(cause)}` }))
          }
        })

      const findBinding = (workspaceId: EntityId, bindingId: EntityId): Effect.Effect<GatekeeperBinding, DomainError> =>
        Effect.gen(function* () {
          const raw = yield* collections.gatekeeperBindings.get(bindingId).pipe(Effect.mapError(toUnexpectedError))
          if (raw === undefined) {
            return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
          }
          const binding = yield* reviveGatekeeperBinding(raw)
          if (binding.workspaceId !== workspaceId) {
            return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
          }
          return binding
        })

      /** Active private mappings are authoritative and fail closed; only truly unmapped historical
       * bindings enter the legacy email adapter. */
      const resolveBindingLocator = (binding: GatekeeperBinding): Effect.Effect<GatekeeperConnectionLocator, DomainError> =>
        Effect.gen(function* () {
          const mappingRaw = yield* collections.bindingConnections.get(binding.id).pipe(Effect.mapError(toUnexpectedError))
          if (mappingRaw === undefined) return { kind: "legacy-email", email: binding.boundBy } as const
          const mapping = mappingRaw as BindingConnectionRecord
          const connectionRaw = yield* collections.providerConnections
            .get(mapping.providerConnectionId)
            .pipe(Effect.mapError(toUnexpectedError))
          if (connectionRaw === undefined) return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId: binding.workspaceId, gatekeeperKind: "google-calendar" }))
          const resolved = resolveGatekeeperConnectionLocator(binding, [mapping], [connectionRaw as ProviderConnectionRecord])
          if (resolved instanceof Error) {
            return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId: binding.workspaceId, gatekeeperKind: "google-calendar" }))
          }
          return resolved.locator
        })

      const isBindingActiveForVisibility = (binding: GatekeeperBinding): Effect.Effect<boolean, DomainError> =>
        Effect.gen(function* () {
          const mapping = yield* collections.bindingConnections.get(binding.id).pipe(Effect.mapError(toUnexpectedError))
          if (mapping === undefined) return true
          const connection = yield* collections.providerConnections
            .get((mapping as BindingConnectionRecord).providerConnectionId)
            .pipe(Effect.mapError(toUnexpectedError))
          return connection !== undefined && (connection as ProviderConnectionRecord).status === "active"
        })

      const listCalendarsForBinding = (binding: GatekeeperBinding): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly summary: string }>, DomainError> =>
        resolveBindingLocator(binding).pipe(
          Effect.flatMap((locator) =>
            locator.kind === "legacy-email"
              ? gatekeeperClient.listCalendars(locator.email)
              : gatekeeperClient.byConnection === undefined
                ? Effect.fail(new GatekeeperNotConnected({ workspaceId: binding.workspaceId, gatekeeperKind: "google-calendar" }))
                : gatekeeperClient.byConnection.listCalendars(locator)
          )
        )

      const eventsPageForBinding = (
        binding: GatekeeperBinding,
        calendarId: string,
        query: Parameters<NonNullable<typeof gatekeeperClient.byConnection>["eventsPage"]>[2]
      ) =>
        resolveBindingLocator(binding).pipe(
          Effect.flatMap((locator) =>
            locator.kind === "legacy-email"
              ? gatekeeperClient.eventsPage(locator.email, calendarId, query)
              : gatekeeperClient.byConnection === undefined
                ? Effect.fail(new GatekeeperNotConnected({ workspaceId: binding.workspaceId, gatekeeperKind: "google-calendar" }))
                : gatekeeperClient.byConnection.eventsPage(locator, calendarId, query)
          )
        )

      /** Every `google-calendar` binding this workspace currently has — the set `verifyObserver`/
       *  `isCalendarContentVisible` both iterate over (see this file's header comment). */
      const listCalendarBindingsForWorkspace = (workspaceId: EntityId): Effect.Effect<ReadonlyArray<GatekeeperBinding>, DomainError> =>
        collections.gatekeeperBindings.byWorkspaceId.get(workspaceId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveGatekeeperBinding)),
          Effect.map((bindings) => bindings.filter((b) => b.gatekeeperKind === "google-calendar"))
        )

      const listBindings: CalendarServiceApi["listBindings"] = (workspaceId) =>
        listCalendarBindingsForWorkspace(workspaceId).pipe(
          Effect.map((bindings) => bindings
            .filter((binding) => binding.config.kind === "google-calendar")
            .map((binding) => new GatekeeperBindingSummary({
              id: binding.id,
              workspaceId: binding.workspaceId,
              gatekeeperKind: binding.gatekeeperKind,
              mode: binding.config.mode,
              createdAt: binding.createdAt
            }))
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id))
            ))
        )

      const putObserverRecord = (record: CalendarObserverRecord): Effect.Effect<void, DomainError> =>
        collections.calendarObservers.put(record).pipe(Effect.mapError(toUnexpectedError))

      /** Verifies `observerEmail` against exactly ONE binding, persisting the outcome — the unit
       *  `verifyObserver` loops over every one of a workspace's bindings. The account that connected
       *  the binding (`binding.boundBy`) trivially qualifies for its OWN data without a round trip
       *  through the gatekeeper — mirrors `isCalendarContentVisible`'s identical carve-out. */
      const verifyObserverAgainstBinding = (
        workspaceId: EntityId,
        binding: GatekeeperBinding,
        observerEmail: string
      ): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          if (binding.config.kind !== "google-calendar") return
          const { mode, calendarId } = binding.config

          if (binding.boundBy === observerEmail) {
            yield* putObserverRecord({
              id: calendarObserverKey(workspaceId, binding.id, observerEmail),
              workspaceId,
              bindingId: binding.id,
              observerEmail,
              status: "granted",
              verifiedAt: now()
            })
            return
          }

          const bindingLocator = yield* resolveBindingLocator(binding)
          // The current public collaborator flow supplies only an email. For an active opaque
          // binding that is not enough to choose among a person's multiple Google grants, so fail
          // closed until the private observerConnectionId admission is wired by the collaborator
          // package; never guess or fall back to email.
          if (bindingLocator.kind === "provider-connection") {
            yield* putObserverRecord({
              id: calendarObserverKey(workspaceId, binding.id, observerEmail),
              workspaceId,
              bindingId: binding.id,
              observerEmail,
              status: "denied",
              message: "An exact calendar connection is required to verify this observer.",
              verifiedAt: now()
            })
            return
          }
          // The verifier is minted from the observer's own account. The binding locator only
          // selects the account that will evaluate the resulting verifier in `addObserver`.
          // Keeping those identities separate is essential for legacy sharing and remains the
          // same invariant when the observer path gains an opaque locator.
          const verifierExit = yield* gatekeeperClient.mintObserverVerifier(observerEmail).pipe(Effect.either)
          if (verifierExit._tag === "Left") {
            yield* putObserverRecord({
              id: calendarObserverKey(workspaceId, binding.id, observerEmail),
              workspaceId,
              bindingId: binding.id,
              observerEmail,
              status: "denied",
              message: `${observerEmail} has not connected their own Google account, so they cannot independently verify access to this binding's calendar-derived content.`,
              verifiedAt: now()
            })
            return
          }

          const addExit = yield* gatekeeperClient
            .addObserver(bindingLocator.email, binding.id, observerEmail, verifierExit.right.token, mode, calendarId)
            .pipe(Effect.either)
          yield* putObserverRecord({
            id: calendarObserverKey(workspaceId, binding.id, observerEmail),
            workspaceId,
            bindingId: binding.id,
            observerEmail,
            status: addExit._tag === "Right" ? "granted" : "denied",
            ...(addExit._tag === "Left" ? { message: describeError(addExit.left) } : {}),
            verifiedAt: now()
          })
        })

      const verifyObserver: CalendarServiceApi["verifyObserver"] = (workspaceId, observerEmail) =>
        Effect.gen(function* () {
          const bindings = yield* listCalendarBindingsForWorkspace(workspaceId)
          yield* Effect.forEach(bindings, (binding) => verifyObserverAgainstBinding(workspaceId, binding, observerEmail), {
            discard: true
          })
        })

      const isCalendarContentVisible: CalendarServiceApi["isCalendarContentVisible"] = (workspaceId, callerEmail) =>
        Effect.gen(function* () {
          const bindings = yield* listCalendarBindingsForWorkspace(workspaceId)
          // A cleanupPending opaque connection remains locally retained only long enough for a
          // retryable remote teardown. It is already unroutable, so its historical projection is
          // owner-only during that interval rather than remaining visible via stale observer rows.
          const activeBindings = yield* Effect.filter(bindings, isBindingActiveForVisibility)
          const ownerEmail = yield* sharing.getOwnerEmail
          // A disconnect removes credentials, not the already-synced private projection. In a
          // governed workspace retained calendar rows become owner-only until a new binding is
          // established; otherwise a disconnect would accidentally disclose old event metadata.
          if (activeBindings.length === 0) return ownerEmail === null || callerEmail === ownerEmail
          if (callerEmail !== undefined && callerEmail === ownerEmail) return true
          if (callerEmail !== undefined && activeBindings.some((b) => b.boundBy === callerEmail)) return true
          if (callerEmail === undefined) {
            // A governed workspace's `requireRoleForGovernedWorkspace` gate already rejects an anonymous
            // caller before this method is ever reached — reaching here with no email means the
            // workspace is ungoverned (`ownerEmail === null`), which stays fully open, same carve-out
            // every other governed-read gate in this codebase makes.
            return ownerEmail === null
          }

          for (const binding of activeBindings) {
            const raw = yield* collections.calendarObservers
              .get(calendarObserverKey(workspaceId, binding.id, callerEmail))
              .pipe(Effect.mapError(toUnexpectedError))
            if (raw === undefined || (raw as CalendarObserverRecord).status !== "granted") return false
          }
          return true
        })

      const hiddenCalendarDerivedNodeIds: CalendarServiceApi["hiddenCalendarDerivedNodeIds"] = (workspaceId, callerEmail) =>
        Effect.gen(function* () {
          const visible = yield* isCalendarContentVisible(workspaceId, callerEmail)
          if (visible) return new Set<EntityId>()
          const rows = yield* collections.calendarDerivedNodes.byWorkspaceId
            .get(workspaceId)
            .pipe(Effect.mapError(toUnexpectedError))
          return new Set(rows.map((row) => (row as CalendarDerivedNodeRecord).nodeId))
        })

      /**
       * Strategy C's "a new observation just read a calendar we've never logged before" half
       * (`observer-verification.ts#onDatasetTouched` in `gatekeeper-google-calendar`, called here
       * over the same JSON-over-service-binding hop every other gatekeeper call uses). No-op for a
       * `"selected"`-mode binding (Strategy B has no dataset log — mirrors
       * `GatekeeperAccountServiceApi.onCalendarTouched`'s own doc comment). Best-effort: a
       * transport failure here never fails `sync()` itself — the next sync (or the next
       * `verifyObserver` re-run) gets another chance.
       */
      const touchCalendar = (
        workspaceId: EntityId,
        binding: GatekeeperBinding,
        calendarId: string
      ): Effect.Effect<void, never> =>
        Effect.gen(function* () {
          if (binding.config.kind !== "google-calendar" || binding.config.mode !== "allVisible") return
          const result = yield* resolveBindingLocator(binding).pipe(
            Effect.flatMap((locator) =>
              locator.kind === "legacy-email"
                ? gatekeeperClient.notifyCalendarTouched(locator.email, binding.id, calendarId)
                : gatekeeperClient.byConnection === undefined
                  ? Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
                  : gatekeeperClient.byConnection.notifyCalendarTouched(locator, binding.id, calendarId)
            ),
            Effect.either
          )
          if (result._tag === "Left") return
          yield* Effect.forEach(
            result.right.failedObserverIds,
            (observerEmail) =>
              putObserverRecord({
                id: calendarObserverKey(workspaceId, binding.id, observerEmail),
                workspaceId,
                bindingId: binding.id,
                observerEmail,
                status: "denied",
                message: `Re-verification failed after this binding's sync touched a calendar ("${calendarId}") this observer cannot independently read.`,
                verifiedAt: now()
              }),
            { discard: true }
          ).pipe(Effect.orDie)
        })

      const requireOAuthConfigured: Effect.Effect<void, DomainError> =
        config.stateSecret.length === 0 || config.redirectUri.length === 0
          ? Effect.fail(
              new ValidationError({
                message:
                  "CALENDAR_OAUTH_STATE_SECRET/CALENDAR_OAUTH_REDIRECT_URI is not configured on this deployment — cannot start a Google Calendar OAuth flow."
              })
            )
          : Effect.void

      const connect: CalendarServiceApi["connect"] = (workspaceId, boundByEmail) =>
        Effect.gen(function* () {
          yield* requireOAuthConfigured
          if (gatekeeperClient.byConnection === undefined) {
            const state = yield* mintCalendarOAuthState(workspaceId, boundByEmail, config.stateSecret)
            const { url } = yield* gatekeeperClient.buildAuthorizationUrl(state, config.redirectUri)
            return { authorizationUrl: url, state }
          }
          const principal = yield* decodeEmail(boundByEmail)
          const nonce = makeCalendarOAuthStateNonce()
          const nonceDigest = yield* digestCalendarOAuthStateNonce(nonce).pipe(
            Effect.mapError((error) => new ValidationError({ message: error.message }))
          )
          const issuedAt = now()
          const expiresAt = IsoDateTimeString.make(new Date(Date.now() + 10 * 60 * 1000).toISOString())
          // Calendar selection stays public-flow compatible: the callback supplies it. These
          // provisional values remain only inside the pending private admission record and are
          // replaced before the public binding is activated.
          const admission = preparePendingCalendarOAuthAdmission({
            workspaceId,
            principal,
            calendarId: "primary",
            mode: "selected",
            stateNonceDigest: nonceDigest,
            rowHash: nonceDigest,
            issuedAt,
            expiresAt
          })
          yield* transaction(
            Effect.gen(function* () {
              yield* collections.providerConnections.put(admission.connection).pipe(Effect.mapError(toUnexpectedError))
              yield* collections.bindingConnections.put(admission.bindingConnection).pipe(Effect.mapError(toUnexpectedError))
              yield* collections.calendarOAuthAttempts.put(admission.attempt).pipe(Effect.mapError(toUnexpectedError))
            })
          )
          const state = yield* mintCalendarOAuthAttemptState(nonce, config.stateSecret).pipe(
            Effect.mapError((error) => new ValidationError({ message: error.message }))
          )
          const { url } = yield* gatekeeperClient.buildAuthorizationUrl(state, config.redirectUri)
          return { authorizationUrl: url, state }
        })

      const completeOAuthCallback: CalendarServiceApi["completeOAuthCallback"] = (
        workspaceId,
        code,
        state,
        calendarId,
        mode,
        callbackPrincipal
      ) =>
        Effect.gen(function* () {
          yield* requireOAuthConfigured
          if (gatekeeperClient.byConnection === undefined) {
            const legacy = yield* verifyCalendarOAuthState(state, config.stateSecret).pipe(
              Effect.mapError((error) => new ValidationError({ message: error.message }))
            )
            if (legacy.workspaceId !== workspaceId || legacy.boundByEmail !== callbackPrincipal) {
              return yield* Effect.fail(new ValidationError({ message: "OAuth state does not match this workspace." }))
            }
            const boundBy = yield* decodeEmail(legacy.boundByEmail)
            yield* gatekeeperClient.exchangeAndConnect(legacy.boundByEmail, code, config.redirectUri)
            const binding = new GatekeeperBinding({
              id: crypto.randomUUID() as EntityId,
              workspaceId,
              gatekeeperKind: "google-calendar",
              boundBy,
              config: new GoogleCalendarBindingConfig({ kind: "google-calendar", calendarId, mode }),
              createdAt: now()
            })
            yield* collections.gatekeeperBindings.put(binding).pipe(Effect.mapError(toUnexpectedError))
            return binding
          }
          const verified = yield* verifyCalendarOAuthAttemptState(state, config.stateSecret).pipe(
            Effect.mapError((e) => new ValidationError({ message: e.message }))
          )
          const principal = yield* decodeEmail(callbackPrincipal)
          const claimed = yield* transaction(
            collections.calendarOAuthAttempts.byStateNonceDigest.get(verified.nonceDigest).pipe(
              Effect.mapError(toUnexpectedError),
              Effect.flatMap((rows) => Effect.gen(function* () {
                const matching = rows.map((row) => row as CalendarOAuthAttemptRecord).filter((row) =>
                  row.workspaceId === workspaceId && row.principal === principal
                )
                if (matching.length !== 1) return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                const attempt = matching[0]!
                if (attempt.lifecycle === "committed") return { attempt, leaseToken: undefined as string | undefined }
                if (Date.now() >= new Date(attempt.expiresAt).getTime()) {
                  if (attempt.lifecycle === "pending" || attempt.lifecycle === "exchanging") {
                    yield* collections.calendarOAuthAttempts
                      .put(new CalendarOAuthAttemptRecord({
                        ...attempt,
                        lifecycle: "expired",
                        leaseToken: undefined,
                        leaseExpiresAt: undefined,
                        fence: attempt.fence + 1,
                        revision: attempt.revision + 1
                      }))
                      .pipe(Effect.mapError(toUnexpectedError))
                  }
                  return yield* Effect.fail(new ValidationError({ message: "OAuth authorization has expired." }))
                }
                if (attempt.lifecycle !== "pending" && attempt.lifecycle !== "exchanging") {
                  return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                }
                if (
                  attempt.lifecycle === "exchanging" &&
                  attempt.leaseExpiresAt !== undefined &&
                  new Date(attempt.leaseExpiresAt).getTime() > Date.now()
                ) {
                  return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is being completed." }))
                }
                const leaseToken = crypto.randomUUID()
                const updated = new CalendarOAuthAttemptRecord({
                  ...attempt,
                  lifecycle: "exchanging",
                  leaseToken,
                  leaseExpiresAt: IsoDateTimeString.make(new Date(Date.now() + 60_000).toISOString()),
                  fence: attempt.fence + 1,
                  revision: attempt.revision + 1
                })
                yield* collections.calendarOAuthAttempts.put(updated).pipe(Effect.mapError(toUnexpectedError))
                return { attempt: updated, leaseToken }
              }))
            )
          )
          if (claimed.attempt.lifecycle === "committed") return yield* findBinding(workspaceId, claimed.attempt.bindingId)
          const opaque = { kind: "provider-connection" as const, providerConnectionId: claimed.attempt.providerConnectionId }
          const operations = gatekeeperClient.byConnection
          if (operations === undefined) return yield* Effect.fail(new ValidationError({ message: "Calendar OAuth connection is unavailable." }))
          const receipt = yield* operations.completeOAuth(opaque, claimed.attempt.attemptId, code, config.redirectUri).pipe(
            Effect.catchAll((exchangeError) =>
              operations.getOAuthCompletion(opaque, claimed.attempt.attemptId).pipe(
                Effect.mapError(() => new OAuthExchangeFailed({ message: "Calendar OAuth exchange failed." }))
              )
            )
          )
          return yield* transaction(
            collections.calendarOAuthAttempts.get(claimed.attempt.attemptId).pipe(
              Effect.mapError(toUnexpectedError),
              Effect.flatMap((raw) => Effect.gen(function* () {
                if (raw === undefined) return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                const attempt = raw as CalendarOAuthAttemptRecord
                if (attempt.lifecycle === "committed") return yield* findBinding(workspaceId, attempt.bindingId)
                if (!canFinalizeCalendarOAuthAttempt({
                  attempt,
                  workspaceId,
                  principal,
                  providerConnectionId: claimed.attempt.providerConnectionId,
                  bindingId: claimed.attempt.bindingId,
                  leaseToken: claimed.leaseToken,
                  fence: claimed.attempt.fence,
                  nowMs: Date.now()
                })) {
                  return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is being completed." }))
                }
                // Receipt values are private completion proof; validate their shape but never disclose them.
                if (!/^[a-f0-9]{64}$/.test(receipt.receiptDigest) || !/^[a-f0-9]{64}$/.test(receipt.completionFactDigest)) {
                  return yield* Effect.fail(new ValidationError({ message: "Calendar OAuth completion is unavailable." }))
                }
                const binding = new GatekeeperBinding({
                  id: attempt.bindingId,
                  workspaceId,
                  gatekeeperKind: "google-calendar",
                  boundBy: principal,
                  config: new GoogleCalendarBindingConfig({ kind: "google-calendar", calendarId, mode }),
                  createdAt: attempt.issuedAt
                })
                const connectionRaw = yield* collections.providerConnections.get(attempt.providerConnectionId).pipe(Effect.mapError(toUnexpectedError))
                if (connectionRaw === undefined) return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                const connection = connectionRaw as ProviderConnectionRecord
                if (connection.workspaceId !== workspaceId || connection.principal !== principal || connection.status !== "pending") {
                  return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                }
                const mappingRaw = yield* collections.bindingConnections.get(attempt.bindingId).pipe(Effect.mapError(toUnexpectedError))
                if (
                  mappingRaw === undefined ||
                  (mappingRaw as BindingConnectionRecord).workspaceId !== workspaceId ||
                  (mappingRaw as BindingConnectionRecord).providerConnectionId !== attempt.providerConnectionId
                ) return yield* Effect.fail(new ValidationError({ message: "OAuth authorization is unavailable." }))
                const active = new ProviderConnectionRecord({ ...connection, status: "active", updatedAt: now() })
                const committed = new CalendarOAuthAttemptRecord({
                  ...attempt,
                  lifecycle: "committed",
                  leaseToken: undefined,
                  leaseExpiresAt: undefined,
                  revision: attempt.revision + 1
                })
                yield* collections.gatekeeperBindings.put(binding).pipe(Effect.mapError(toUnexpectedError))
                yield* collections.providerConnections.put(active).pipe(Effect.mapError(toUnexpectedError))
                yield* collections.calendarOAuthAttempts.put(committed).pipe(Effect.mapError(toUnexpectedError))
                return binding
              }))
            )
          )
        })

      const disconnect: CalendarServiceApi["disconnect"] = (workspaceId, bindingId, principalText) =>
        Effect.gen(function* () {
          const binding = yield* findBinding(workspaceId, bindingId)
          const principal = yield* decodeEmail(principalText)
          const mappingRaw = yield* collections.bindingConnections.get(bindingId).pipe(Effect.mapError(toUnexpectedError))
          if (mappingRaw === undefined) {
            // Preserve explicit legacy lifecycle compatibility; it never impersonates an opaque connection.
            if (binding.boundBy !== principal) {
              return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
            }
            yield* collections.gatekeeperBindings.delete(bindingId).pipe(Effect.mapError(toUnexpectedError))
            return true
          }
          const mapping = mappingRaw as BindingConnectionRecord
          const locator = { kind: "provider-connection" as const, providerConnectionId: mapping.providerConnectionId }
          yield* transaction(
            Effect.gen(function* () {
              const raw = yield* collections.providerConnections.get(locator.providerConnectionId).pipe(Effect.mapError(toUnexpectedError))
              if (raw === undefined) return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
              const connection = raw as ProviderConnectionRecord
              if (
                connection.workspaceId !== workspaceId ||
                connection.principal !== principal ||
                (connection.status !== "active" && connection.status !== "cleanupPending")
              ) {
                return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
              }
              if (connection.status === "active") {
                yield* collections.providerConnections
                  .put(new ProviderConnectionRecord({ ...connection, status: "cleanupPending", updatedAt: now() }))
                  .pipe(Effect.mapError(toUnexpectedError))
              }
            })
          )
          const operations = gatekeeperClient.byConnection
          if (operations === undefined) return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
          yield* operations.disconnect(locator)
          yield* transaction(
            Effect.gen(function* () {
              const raw = yield* collections.providerConnections.get(locator.providerConnectionId).pipe(Effect.mapError(toUnexpectedError))
              if (raw === undefined) return
              const connection = raw as ProviderConnectionRecord
              yield* collections.providerConnections
                .put(new ProviderConnectionRecord({ ...connection, status: "detached", updatedAt: now() }))
                .pipe(Effect.mapError(toUnexpectedError))
              yield* collections.bindingConnections.delete(bindingId).pipe(Effect.mapError(toUnexpectedError))
              yield* collections.gatekeeperBindings.delete(bindingId).pipe(Effect.mapError(toUnexpectedError))
            })
          )
          return true
        })

      /** Builds the workspace's current `attendee email -> unique Person nodeId` map once, by
       * scanning `FactsRepository` for `"email"` predicates and revalidating each candidate's
       * workspace and Person membership. Ambiguous or stale facts are retained as an explicit
       * `null` entry so a sync cannot silently attach a new attendee to the wrong identity. */
      const loadEmailIndex = (workspaceId: EntityId): Effect.Effect<Map<string, EntityId | null>, DomainError> =>
        factsRepository.list(workspaceId).pipe(
          Effect.flatMap((facts) => {
            const candidates = new Map<string, Set<EntityId>>()
            for (const fact of facts) {
              if (fact.predicateId !== attendeeEmailPredicate || typeof fact.value !== "string") continue
              const email = normalizeEmail(fact.value)
              const ids = candidates.get(email) ?? new Set<EntityId>()
              ids.add(fact.nodeId)
              candidates.set(email, ids)
            }
            return Effect.forEach(candidates, ([email, ids]) =>
                Effect.forEach([...ids], (nodeId) => graph.hasTag(workspaceId, nodeId, BaseTagIds.Person).pipe(Effect.either)).pipe(
                Effect.map((results) => {
                  const verified = [...ids].filter((_, index) => {
                    const result = results[index]
                    return result?._tag === "Right" && result.right
                  })
                  return [email, verified.length === 1 ? verified[0]! : verified.length > 1 ? null : null] as const
                })
              )
            ).pipe(Effect.map((entries) => new Map(entries)))
          })
        )

      /** Upserts one remote event into `calendarEvents`, resolving master/occurrence identity per
       *  this file's header comment, and recording known Person links without creating graph
       *  entities. `masterCache` tracks
       *  `seriesId -> masterRecordId` synthesized so far THIS sync call, so a series with many
       *  occurrences on one page only synthesizes its master row once. */
      const upsertRemoteEvent = (
        workspaceId: EntityId,
        remote: RemoteCalendarEvent,
        emailIndex: Map<string, EntityId | null>,
        masterCache: Map<string, EntityId>,
        expectedCalendarEventId?: EntityId
      ): Effect.Effect<CalendarEvent, DomainError> =>
        Effect.gen(function* () {
          const attendeeEntities: Array<CalendarEventAttendee> = []
          // A cancellation is a tombstone for the event, not evidence that its attendee list is
          // current. In particular, a first-seen cancelled snapshot must never mint Person nodes
          // or email facts from historical provider data.
          for (const attendee of remote.status === "cancelled" ? [] : remote.attendees ?? []) {
            // Best-effort: an attendee with a malformed email (rare, but Google does not itself
            // validate every historical row) is skipped rather than failing the whole sync.
            const emailExit = yield* Effect.either(decodeEmail(normalizeEmail(attendee.email)))
            if (emailExit._tag === "Left") continue
            // Person resolution/creation belongs to the ledgered concierge. Existing facts may
            // still provide a stable link immediately; an unknown attendee remains unlinked until
            // that employee job commits the deterministic Person and relationship.
            const personNodeId = emailIndex.get(normalizeEmail(attendee.email)) ?? undefined
            attendeeEntities.push(new CalendarEventAttendee({
              email: emailExit.right,
              ...(attendee.displayName ? { displayName: attendee.displayName } : {}),
              ...(personNodeId === undefined ? {} : { personNodeId })
            }))
          }

          let seriesId: string | undefined
          let occurrenceId: string | undefined
          let masterRecordId: EntityId | undefined

          if (remote.recurringEventId !== undefined) {
            seriesId = remote.recurringEventId
            occurrenceId =
              remote.start.kind === "date" ? remote.start.date : remote.start.dateTime
            const cached = masterCache.get(seriesId)
            if (cached !== undefined) {
              masterRecordId = cached
            } else {
              const existingRaw = yield* collections.calendarEvents.byProviderEventId
                .get(seriesId)
                .pipe(Effect.mapError(toUnexpectedError))
              const existingMaster = yield* Effect.forEach(existingRaw, reviveCalendarEvent).pipe(
                Effect.map((rows) => rows.find((r) => r.workspaceId === workspaceId && r.seriesId === seriesId && r.masterRecordId === undefined))
              )
              if (existingMaster !== undefined) {
                masterRecordId = existingMaster.id
              } else {
                // Synthesize a minimal master row — see this file's header comment.
                const master = new CalendarEvent({
                  id: crypto.randomUUID() as EntityId,
                  workspaceId,
                  providerEventId: seriesId,
                  seriesId,
                  title: remote.title,
                  start: remoteTimeToCalendarEventTime(remote.start),
                  end: remoteTimeToCalendarEventTime(remote.end),
                  attendees: attendeeEntities,
                  status: "confirmed",
                  syncedAt: now()
                })
                yield* collections.calendarEvents.put(master).pipe(Effect.mapError(toUnexpectedError))
                yield* syncFeed.append("calendarEvent", master.id, "put", master)
                masterRecordId = master.id
              }
              masterCache.set(seriesId, masterRecordId)
            }
          }

          const existingRowsRaw = yield* collections.calendarEvents.byProviderEventId
            .get(remote.id)
            .pipe(Effect.mapError(toUnexpectedError))
          const existingRows = yield* Effect.forEach(existingRowsRaw, reviveCalendarEvent)
          const existing = existingRows.find((r) => r.workspaceId === workspaceId)
          if (expectedCalendarEventId !== undefined && existing !== undefined && existing.id !== expectedCalendarEventId) {
            return yield* Effect.fail(new UnexpectedError({ message: "calendar projection target changed; retry the provider event" }))
          }

          const event = new CalendarEvent({
            id: existing?.id ?? expectedCalendarEventId ?? (crypto.randomUUID() as EntityId),
            workspaceId,
            providerEventId: remote.id,
            ...(seriesId !== undefined ? { seriesId } : {}),
            ...(occurrenceId !== undefined ? { occurrenceId } : {}),
            ...(masterRecordId !== undefined ? { masterRecordId } : {}),
            title: remote.title,
            start: remoteTimeToCalendarEventTime(remote.start),
            end: remoteTimeToCalendarEventTime(remote.end),
            attendees: attendeeEntities,
            status: remote.status,
            // "Provider apply... never writes or deletes" the linked node (calendar-event.ts's
            // own header comment) — preserved verbatim across every re-sync.
            ...(existing?.linkedNodeId !== undefined ? { linkedNodeId: existing.linkedNodeId } : {}),
            syncedAt: now()
          })
          yield* collections.calendarEvents.put(event).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("calendarEvent", event.id, "put", event)
          return event
        })

      /** Read-only target allocation before entering the ledger transaction. The projection
       * closure rechecks it and fails closed on a concurrent create so a retry never records
       * custody against a different event than the one it actually wrote. */
      const existingCalendarEventId = (workspaceId: EntityId, providerEventId: string): Effect.Effect<EntityId | undefined, DomainError> =>
        collections.calendarEvents.byProviderEventId.get(providerEventId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveCalendarEvent)),
          Effect.map((rows) => rows.find((row) => row.workspaceId === workspaceId)?.id)
        )

      /** Google includes a monotonic `updated` cursor on every Event resource. Keep that cursor
       * in the private revision rows and reject an older snapshot before it can touch the public
       * event/person projection. Legacy/scripted providers may omit it; once a timestamped row
       * exists, an unversioned snapshot is treated as stale rather than allowed to clobber known
       * newer state. Equal timestamps are also rejected: a same-cursor/different-payload response
       * is not strong enough evidence to replace the already-applied revision. */
      const isOlderProviderRevision = (
        incomingUpdatedAt: string | undefined,
        existing: ReadonlyArray<CalendarSourceRevisionRecord>
      ): boolean => {
        const timestamped = existing
          .map((row) => row.sourceUpdatedAt === undefined ? undefined : Date.parse(row.sourceUpdatedAt))
          .filter((value): value is number => value !== undefined && Number.isFinite(value))
        if (timestamped.length === 0) return false
        if (incomingUpdatedAt === undefined) return true
        const incoming = Date.parse(incomingUpdatedAt)
        if (!Number.isFinite(incoming)) return true
        return incoming <= Math.max(...timestamped)
      }

      const sync: CalendarServiceApi["sync"] = (workspaceId, bindingId, attribution, principal) =>
        Effect.gen(function* () {
          if (principal.trim().length === 0) {
            return yield* Effect.fail(new ValidationError({ message: "Calendar sync requires a nonblank authenticated principal." }))
          }
          if (attribution.kind === "system") {
            return yield* Effect.fail(new ValidationError({ message: "Calendar sync requires an authenticated user or employee attribution." }))
          }
          const binding = yield* findBinding(workspaceId, bindingId)
          if (binding.config.kind !== "google-calendar") {
            return yield* Effect.fail(new GatekeeperNotConnected({ workspaceId, gatekeeperKind: "google-calendar" }))
          }
          const { calendarId } = binding.config
          // Strategy C wiring (task item 3: "re-verification triggers correctly when a new
          // foreign calendar is touched") — a no-op for a `"selected"`-mode binding, see
          // `touchCalendar`'s own doc comment. Deliberately BEFORE the events loop below, mirroring
          // `onDatasetTouched`'s documented contract ("call... BEFORE returning that data to the
          // caller"). For an `"allVisible"` binding, ALSO discover and touch every OTHER calendar
          // the bound account can see (`listCalendars` — already built, previously unused by this
          // service) — an `allVisible` availability binding's whole reason to exist is watching
          // more than the one primary `calendarId`, so the dataset log this binding's re-
          // verification runs against must grow to cover those too, the first time each is seen.
          // Documented simplification: `listCalendars` itself only returns writer/owner-role
          // calendars (Strategy B's own filter) — a calendar the bound account can see only via
          // `freeBusyReader` sharing is not discovered this way; a full implementation would use a
          // dedicated "every calendar this account has ANY visibility into" listing instead.
          yield* touchCalendar(workspaceId, binding, calendarId)
          if (binding.config.mode === "allVisible") {
            const otherCalendarsExit = yield* listCalendarsForBinding(binding).pipe(Effect.either)
            if (otherCalendarsExit._tag === "Right") {
              yield* Effect.forEach(
                otherCalendarsExit.right.filter((cal) => cal.id !== calendarId),
                (cal) => touchCalendar(workspaceId, binding, cal.id),
                { discard: true }
              )
            }
          }
          const emailIndex = yield* loadEmailIndex(workspaceId)
          const masterCache = new Map<string, EntityId>()

          const nowDate = new Date()
          const timeMin = new Date(nowDate.valueOf() - 30 * 24 * 60 * 60 * 1000).toISOString()
          const timeMax = new Date(nowDate.valueOf() + 180 * 24 * 60 * 60 * 1000).toISOString()

          let pageToken: string | undefined
          let pages = 0
          do {
            const page = yield* eventsPageForBinding(binding, calendarId, {
              mode: "window",
              timeMin,
              timeMax,
              singleEvents: true,
              showDeleted: true,
              ...(pageToken !== undefined ? { pageToken } : {})
            })
            for (const remote of page.items) {
              // Fetch/parse is provider I/O. The deterministic plan holds only the opaque
              // revision/observation identities that cross into the durable ledger/outbox.
              const planned = yield* Effect.tryPromise({
                try: () => planCalendarRemoteEventWithSecret(
                  workspaceId,
                  bindingId,
                  remote,
                  config.attendeeDigestSecret ?? config.stateSecret
                ),
                catch: (cause) => new UnexpectedError({
                  message: `calendar attendee identity planning failed: ${cause instanceof Error ? cause.message : String(cause)}`
                })
              })
              const requestIdentity = `calendar-projection:${planned.sourceRevisionDigest}`
              const calendarEventId = (yield* existingCalendarEventId(workspaceId, remote.id)) ?? (crypto.randomUUID() as EntityId)
              // A failed gateway transaction rolls its storage back, not JavaScript maps. Keep
              // local identity/master caches isolated until the atomic projection has committed.
              const eventEmailIndex = new Map(emailIndex)
              const eventMasterCache = new Map(masterCache)
              const receipt = yield* Effect.tryPromise({
                try: () => projectionGateway.apply({
                  workspaceId,
                  bindingId,
                  // This is an internal entity id, not the provider id. The closure rechecks the
                  // allocation before write, so custody always names the projected event.
                  calendarEventId,
                  requestIdentity,
                  requestId: requestIdentity,
                  principal,
                  sourceRevisionDigest: planned.sourceRevisionDigest,
                  sourceEventKeyDigest: planned.sourceEventKeyDigest,
                  attendeeObservationDigests: planned.attendeeObservationDigests,
                  commitMessage: "Project this calendar revision into the second brain.",
                  attribution,
                  applyProjection: () => {
                    const existingRevisions = Effect.runSync(
                      collections.calendarSourceRevisions.byBindingAndProviderEvent
                        .get(`${bindingId}:${remote.id}`)
                        .pipe(Effect.mapError(toUnexpectedError))
                    )
                    if (isOlderProviderRevision(planned.sourceUpdatedAt, existingRevisions)) return []
                    const event = Effect.runSync(upsertRemoteEvent(workspaceId, remote, eventEmailIndex, eventMasterCache, calendarEventId))
                    // Both records are backend-private: provider ids and addresses stay here,
                    // while the public ledger/event/outbox sees only their digests.
                    Effect.runSync(collections.calendarSourceRevisions.put({
                      id: sha256HexSync(canonicalJsonBytes({ bindingId, providerEventId: remote.id, sourceRevisionDigest: planned.sourceRevisionDigest })),
                      workspaceId,
                      bindingId,
                      providerEventId: remote.id,
                      sourceRevisionDigest: planned.sourceRevisionDigest,
                      ...(planned.sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt: planned.sourceUpdatedAt }),
                      calendarEventId: event.id,
                      status: remote.status === "cancelled" ? "cancelled" : "confirmed",
                      appliedAt: now()
                    }).pipe(Effect.mapError(toUnexpectedError)))
                    const byEmail = new Map(event.attendees.map((attendee) => [normalizeEmail(attendee.email), attendee] as const))
                    const firstObserved: string[] = []
                    for (const attendee of remote.status === "cancelled" ? [] : remote.attendees ?? []) {
                      const email = normalizeEmail(attendee.email)
                      const decoded = Effect.runSyncExit(decodeEmail(email))
                      if (decoded._tag === "Failure") continue
                      const emailDigest = planned.attendeeObservationDigests[
                        [...new Set((remote.attendees ?? []).map((candidate) => normalizeEmail(candidate.email)).filter(Boolean))]
                          .sort()
                          .indexOf(email)
                      ]
                      if (emailDigest === undefined) continue
                      const observationId = sha256HexSync(canonicalJsonBytes({ sourceEventKeyDigest: planned.sourceEventKeyDigest, emailDigest }))
                      const existingObservation = Effect.runSync(
                        collections.calendarAttendeeObservations.get(observationId).pipe(Effect.mapError(toUnexpectedError))
                      )
                      const record: CalendarAttendeeObservationRecord = {
                        id: observationId,
                        workspaceId,
                        bindingId,
                        calendarEventId: event.id,
                        sourceRevisionDigest: planned.sourceRevisionDigest,
                        emailDigest,
                        ...(byEmail.get(email)?.personNodeId === undefined ? {} : { personNodeId: byEmail.get(email)!.personNodeId }),
                        observedAt: now()
                      }
                      Effect.runSync(collections.calendarAttendeeObservations.put(record).pipe(Effect.mapError(toUnexpectedError)))
                      if (existingObservation === undefined && remote.status !== "cancelled") firstObserved.push(emailDigest)
                    }
                    return firstObserved
                  }
                }),
                catch: (cause) => new UnexpectedError({
                  message: `calendar projection failed: ${cause instanceof Error ? cause.message : String(cause)}`
                })
              })
              // Merge only after gateway.apply returns: a failure leaves both maps exactly as
              // they were before this provider event and cannot point a later event at rolled-back data.
              for (const [email, personId] of eventEmailIndex) emailIndex.set(email, personId)
              for (const [seriesId, masterId] of eventMasterCache) masterCache.set(seriesId, masterId)
            }
            pageToken = page.nextPageToken
            pages++
          } while (pageToken !== undefined && pages < MAX_PAGES_PER_SYNC)

          return { triggered: true }
        })

      const listEvents: CalendarServiceApi["listEvents"] = (workspaceId, from, to, callerEmail) =>
        Effect.gen(function* () {
          // The real read-side enforcement (this file's header comment): every row in
          // `calendarEvents` is calendar-sourced, so a non-qualifying viewer gets `[]`, not a
          // partially-filtered list — there is no non-calendar subset of this collection to keep
          // visible.
          const visible = yield* isCalendarContentVisible(workspaceId, callerEmail)
          if (!visible) return []

          const rows = yield* collections.calendarEvents.byWorkspaceId.get(workspaceId).pipe(Effect.mapError(toUnexpectedError))
          const events = yield* Effect.forEach(rows, reviveCalendarEvent)
          return events.filter((event) => {
            if (from !== undefined && eventTimeValue(event.end) < from) return false
            if (to !== undefined && eventTimeValue(event.start) >= to) return false
            return true
          })
        })

      const getTodayBrief: CalendarServiceApi["getTodayBrief"] = (input, callerEmail) => {
        const { timeZone, from, to } = resolveTodayBriefWindow(input.localDate, input.timeZone)
        return listEvents(input.workspaceId, from, to, callerEmail).pipe(
          Effect.flatMap((events) => Effect.gen(function* () {
            const emailIndex = yield* loadEmailIndex(input.workspaceId)
            const projected = projectTodayBriefEvents(
              events,
              from,
              to,
              timeZone,
              callerEmail,
              (attendee) => emailIndex.get(normalizeEmail(attendee.email)) === attendee.personNodeId
            )
            return yield* Effect.forEach(projected, (event) =>
              Effect.forEach(event.people, (person) => {
                if (person.personNodeId === undefined) return Effect.succeed(person)
                return graph.hasTag(input.workspaceId, person.personNodeId, BaseTagIds.Person).pipe(
                  Effect.either,
                  Effect.map((result) => result._tag === "Right" && result.right
                    ? person
                    : new TodayBriefPerson({ ...(person.displayName === undefined ? {} : { displayName: person.displayName }) }))
                )
              }).pipe(Effect.map((people) => new TodayBriefEvent({ ...event, people })))
            )
          })),
          Effect.map((projected) => {
            return new GetTodayBriefOutput({
              localDate: input.localDate,
              timeZone,
              from,
              to,
              calendarHistory: new TodayBriefCalendarHistory({
                // This only describes what was present in Athenaeum's already-retained local
                // projection. It is deliberately not a claim about the external calendar.
                status: projected.length > 0 ? "found" : "noneInRetainedData"
              }),
              events: projected
            })
          }),
          // A projection-storage failure must not turn a read into a calendar-oracle. The bounded
          // response says only that Athenaeum could not read its own retained projection.
          Effect.catchAll(() =>
            Effect.succeed(
              new GetTodayBriefOutput({
                localDate: input.localDate,
                timeZone,
                from,
                to,
                calendarHistory: new TodayBriefCalendarHistory({ status: "unavailable" }),
                events: []
              })
            )
          )
        )
      }

      const findTodayBriefEvent: CalendarServiceApi["findTodayBriefEvent"] = (workspaceId, localDate, requestedTimeZone, occurrenceKey, callerEmail) =>
        Effect.gen(function* () {
          const visible = yield* isCalendarContentVisible(workspaceId, callerEmail)
          if (!visible) return undefined
          const { timeZone, from, to } = resolveTodayBriefWindow(localDate, requestedTimeZone)
          const rows = yield* collections.calendarEvents.byWorkspaceId.get(workspaceId).pipe(Effect.mapError(toUnexpectedError))
          const events = yield* Effect.forEach(rows, reviveCalendarEvent)
          const emailIndex = yield* loadEmailIndex(workspaceId)
          const projected = projectTodayBriefEvents(
            events,
            from,
            to,
            timeZone,
            callerEmail,
            (attendee) => emailIndex.get(normalizeEmail(attendee.email)) === attendee.personNodeId
          )
          return projected.find((event) => event.occurrenceKey === occurrenceKey)
        })

      const linkEventToNode: CalendarServiceApi["linkEventToNode"] = (workspaceId, calendarEventId, nodeId) =>
        Effect.gen(function* () {
          const node = yield* nodesRepository.get(nodeId)
          if (node.workspaceId !== workspaceId) {
            return yield* Effect.fail(new ValidationError({ message: `Node ${nodeId} does not belong to workspace ${workspaceId}.` }))
          }
          if (node.pending !== undefined) {
            return yield* Effect.fail(new ValidationError({ message: `Node ${nodeId} is pending and cannot be linked to a calendar event.` }))
          }
          const raw = yield* collections.calendarEvents.get(calendarEventId).pipe(Effect.mapError(toUnexpectedError))
          if (raw === undefined) {
            return yield* Effect.fail(new ValidationError({ message: `No calendar event ${calendarEventId}.` }))
          }
          const existing = yield* reviveCalendarEvent(raw)
          if (existing.workspaceId !== workspaceId) {
            return yield* Effect.fail(new ValidationError({ message: `Calendar event ${calendarEventId} does not belong to workspace ${workspaceId}.` }))
          }
          const updated = new CalendarEvent({ ...existing, linkedNodeId: nodeId })
          yield* collections.calendarEvents.put(updated).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("calendarEvent", updated.id, "put", updated)
          return updated
        })

      const createBookmark: CalendarServiceApi["createBookmark"] = (workspaceId, url, title) =>
        Effect.gen(function* () {
          const bookmark = new Bookmark({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            url,
            ...(title !== undefined ? { title } : {}),
            capturedAt: now()
          })
          yield* collections.bookmarks.put(bookmark).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("bookmark", bookmark.id, "put", bookmark)
          return bookmark
        })

      const listBookmarks: CalendarServiceApi["listBookmarks"] = (workspaceId) =>
        collections.bookmarks.byWorkspaceId.get(workspaceId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((rows) => Effect.forEach(rows, reviveBookmark))
        )

      const linkBookmarkToNode: CalendarServiceApi["linkBookmarkToNode"] = (workspaceId, bookmarkId, nodeId) =>
        Effect.gen(function* () {
          yield* nodesRepository.get(nodeId)
          const raw = yield* collections.bookmarks.get(bookmarkId).pipe(Effect.mapError(toUnexpectedError))
          if (raw === undefined) {
            return yield* Effect.fail(new ValidationError({ message: `No bookmark ${bookmarkId}.` }))
          }
          const existing = yield* reviveBookmark(raw)
          if (existing.workspaceId !== workspaceId) {
            return yield* Effect.fail(new ValidationError({ message: `Bookmark ${bookmarkId} does not belong to workspace ${workspaceId}.` }))
          }
          const updated = new Bookmark({ ...existing, linkedNodeId: nodeId })
          yield* collections.bookmarks.put(updated).pipe(Effect.mapError(toUnexpectedError))
          yield* syncFeed.append("bookmark", updated.id, "put", updated)
          return updated
        })

      return {
        connect,
        completeOAuthCallback,
        disconnect,
        sync,
        listBindings,
        listEvents,
        getTodayBrief,
        findTodayBriefEvent,
        linkEventToNode,
        createBookmark,
        listBookmarks,
        linkBookmarkToNode,
        verifyObserver,
        isCalendarContentVisible,
        hiddenCalendarDerivedNodeIds
      } satisfies CalendarServiceApi
    })
  )

const eventTimeValue = (value: CalendarEventTime): string => (value.kind === "date" ? `${value.date}T00:00:00.000Z` : value.dateTime)

/** Resolve midnight through the server's ICU data. The small fixed-point loop is important: a
 * local day is not always 24 hours, and the offset at UTC midnight can differ from the offset at
 * the local midnight being resolved. */
const localMidnightToInstant = (localDate: string, timeZone: string): IsoDateTimeString => {
  const [year, month, day] = localDate.split("-").map(Number)
  const nominalUtc = Date.UTC(year!, month! - 1, day!)
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })
  let candidate = nominalUtc
  let converged = false
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
    const renderedAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
    const next = nominalUtc - (renderedAsUtc - candidate)
    if (next === candidate) {
      converged = true
      break
    }
    candidate = next
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]))
  const renderedDate = `${parts.year}-${parts.month}-${parts.day}`
  if (!converged || renderedDate !== localDate || parts.hour !== "00" || parts.minute !== "00" || parts.second !== "00") {
    throw new RangeError(`Local midnight does not exist for ${localDate} in ${timeZone}`)
  }
  return IsoDateTimeString.make(new Date(candidate).toISOString())
}

const nextLocalDate = (localDate: string): string => {
  const [year, month, day] = localDate.split("-").map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, day! + 1))
  return next.toISOString().slice(0, 10)
}

export const resolveTodayBriefWindow = (localDate: string, requestedTimeZone: string) => {
  const timeZone = Intl.DateTimeFormat("en-GB", { timeZone: requestedTimeZone }).resolvedOptions().timeZone
  return {
    timeZone: timeZone as GetTodayBriefOutput["timeZone"],
    from: localMidnightToInstant(localDate, timeZone),
    to: localMidnightToInstant(nextLocalDate(localDate), timeZone)
  }
}

const normalizeEmail = (value: string): string => value.trim().toLowerCase()

const calendarEventInstant = (value: CalendarEventTime, timeZone: string): number =>
  Date.parse(value.kind === "date" ? localMidnightToInstant(value.date, timeZone) : value.dateTime)

const compareStableStrings = (left: string, right: string): number => (left === right ? 0 : left > right ? 1 : -1)

/**
 * Orders duplicate retained rows from older to newer canonical state. Equal sync instants use the
 * documented status order tentative < confirmed < cancelled so cancellation tombstones win, then
 * the immutable local row id as the stable final tie-breaker. This makes selection independent of
 * storage or input iteration order.
 */
const compareCanonicalCalendarEvents = (left: CalendarEvent, right: CalendarEvent): number => {
  const bySyncedAt = compareStableStrings(left.syncedAt, right.syncedAt)
  if (bySyncedAt !== 0) return bySyncedAt

  const statusOrder = { tentative: 0, confirmed: 1, cancelled: 2 } as const
  const byStatus = statusOrder[left.status] - statusOrder[right.status]
  return byStatus !== 0 ? byStatus : compareStableStrings(left.id, right.id)
}

const calendarEventOccurrenceKey = (event: CalendarEvent): string => sha256HexSync(canonicalJsonBytes({
  version: 1,
  providerEventId: event.providerEventId,
  seriesId: event.seriesId ?? null,
  occurrenceId: event.occurrenceId ?? null
}))

/** The projection is deliberately narrower than `CalendarEvent`: no provider id, recurrence
 * metadata, linked node, attendee email, or sync timestamp is exposed. */
export const projectTodayBriefEvents = (
  events: ReadonlyArray<CalendarEvent>,
  from: IsoDateTimeString,
  to: IsoDateTimeString,
  timeZone: string,
  callerEmail: string | undefined,
  personNodeIdValidator?: (attendee: CalendarEventAttendee) => boolean
): ReadonlyArray<TodayBriefEvent> => {
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  const self = callerEmail === undefined ? undefined : normalizeEmail(callerEmail)
  const canonical = new Map<string, CalendarEvent>()
  for (const event of events) {
    // A recurring master is a definition, not an occurrence in a person's day.
    if (event.seriesId !== undefined && event.occurrenceId === undefined) continue
    // A provider row is canonical for standalone events; a series + original occurrence identity
    // is canonical for recurring instances even if a sync retry duplicated the materialized row.
    // Resolve this before filtering cancelled rows: a newer cancellation tombstone must suppress
    // the older confirmed row regardless of input order.
    const key = event.occurrenceId === undefined ? event.providerEventId : `${event.seriesId ?? ""}:${event.occurrenceId}`
    const existing = canonical.get(key)
    if (existing === undefined || compareCanonicalCalendarEvents(event, existing) > 0) {
      canonical.set(key, event)
    }
  }

  return [...canonical.values()]
    .filter((event) => {
      if (event.status === "cancelled") return false
      const startMs = calendarEventInstant(event.start, timeZone)
      const endMs = calendarEventInstant(event.end, timeZone)
      return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs && endMs > fromMs && startMs < toMs
    })
    .sort((left, right) => {
      const byStart = calendarEventInstant(left.start, timeZone) - calendarEventInstant(right.start, timeZone)
      return byStart !== 0 ? byStart : left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    })
    .map((event) => {
      const seenPeople = new Set<string>()
      const people: TodayBriefPerson[] = []
      for (const attendee of event.attendees) {
        const email = normalizeEmail(attendee.email)
        if (email === self || seenPeople.has(email)) continue
        seenPeople.add(email)
        const displayName = attendee.displayName?.trim()
        const personNodeId = attendee.personNodeId !== undefined &&
          (personNodeIdValidator === undefined || personNodeIdValidator(attendee))
          ? attendee.personNodeId
          : undefined
        people.push(new TodayBriefPerson({
          ...(displayName === undefined || displayName.length === 0 ? {} : { displayName }),
          ...(personNodeId === undefined ? {} : { personNodeId })
        }))
      }
      return new TodayBriefEvent({
        id: event.id,
        occurrenceKey: calendarEventOccurrenceKey(event),
        title: event.title,
        start: IsoDateTimeString.make(new Date(calendarEventInstant(event.start, timeZone)).toISOString()),
        end: IsoDateTimeString.make(new Date(calendarEventInstant(event.end, timeZone)).toISOString()),
        people
      })
    })
}

const describeError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "object" && cause !== null && "message" in cause ? String((cause as { message: unknown }).message) : String(cause)

const decodeEmail = (value: string): Effect.Effect<Email, ValidationError> =>
  Schema.decodeUnknown(Email)(value).pipe(
    Effect.mapError(() => new ValidationError({ message: `Invalid email: ${value}` }))
  )
