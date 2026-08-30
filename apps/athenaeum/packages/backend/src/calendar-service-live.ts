// `CalendarService` — the Effect Service behind all eight `gatekeeper-rpc.ts` methods
// (connect/callback/disconnect/sync/list/link + createBookmark/listBookmarks). Same
// `WorkspaceDurableObject`-composed-from-Effect-Services convention as `GraphService`/`NotesService`
// (plan §"Storage & domain model", God-object mitigation) — backend-internal orchestration, not a
// `@athenaeum/domain` `Context.Tag` (mirrors `GraphService`'s own placement rationale verbatim:
// this has real business logic — calendar-merge, attendee dedup — with no home in `domain`'s
// zero-CF/React repository interfaces).
//
// **Attendee-to-Person-node import (task item 4)**: for each synced event's attendees, find an
// existing Person node by scanning `FactsRepository` for an `"email"` predicate matching the
// attendee's address (task's own wording: "dedup by email — store the email as a Fact on the
// Person node, match on it"); create one (tagged `Person`, per `BaseTagIds.Person`) if none
// exists. A per-`sync()`-call in-memory cache (`emailToPersonNodeId`) avoids re-scanning
// `FactsRepository` for every attendee on every event within one sync pass — built once from the
// workspace's existing facts, then extended as new Person nodes are created, so a second attendee
// with the same email later in the SAME page (or a later page) reuses the same node without a
// second full scan. Known, documented simplification: this scan is O(existing facts) once per
// `sync()` call, not indexed by value — acceptable for this stage's scope (a personal workspace's
// fact count), flagged here rather than silently accepted as free.
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
  Fact,
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
  Node as NodeEntity,
  OAuthExchangeFailed,
  SystemMutationAttribution,
  UnexpectedError,
  ValidationError,
  TodayBriefCalendarHistory,
  TodayBriefEvent,
  TodayBriefPerson,
  canonicalJsonBytes,
  sha256HexSync,
  type DomainError
} from "@athenaeum/domain"
import {
  CalendarGatekeeperClient,
  type RemoteCalendarAttendee,
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
  type CalendarObserverRecord
} from "./calendar-collections.js"
import { CalendarProjectionGateway } from "./calendar-projection-gateway.js"
import { planCalendarRemoteEvent } from "./calendar-projection-plan.js"
import { mintCalendarOAuthState, verifyCalendarOAuthState } from "./calendar-oauth-state.js"
import { GraphService } from "./graph-service-live.js"
import { SharingService } from "./sharing-service-live.js"
import { SyncFeedService } from "./sync-feed-service-live.js"

const now = (): IsoDateTimeString => IsoDateTimeString.make(new Date().toISOString())

const attendeeEmailPredicate = "email"

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
    mode: "selected" | "allVisible"
  ) => Effect.Effect<GatekeeperBinding, DomainError>

  readonly disconnect: (workspaceId: EntityId, bindingId: EntityId) => Effect.Effect<boolean, DomainError>

  readonly sync: (workspaceId: EntityId, bindingId: EntityId) => Effect.Effect<{ readonly triggered: boolean }, DomainError>

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
   *  every node `calendarDerivedNodes` (calendar-collections.ts) has ever recorded for this workspace
   *  (attendee-imported Person nodes — see `findOrCreatePersonNode`'s own doc comment for exactly
   *  which nodes that is). */
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
  /** The Workspace DO-owned atomic write boundary. Calendar provider I/O remains in this
   * service; every resulting second-brain projection is committed through this gateway. */
  readonly projectionGateway: CalendarProjectionGateway
  /** Called only after a committed projection enqueues a durable run. Kept outside the storage
   * transaction because DO alarm APIs are async; a later alarm always re-checks the SQL due set. */
  readonly rearmWorkforce: () => Promise<void>
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
            .addObserver(binding.boundBy, binding.id, observerEmail, verifierExit.right.token, mode, calendarId)
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
          const ownerEmail = yield* sharing.getOwnerEmail
          // A disconnect removes credentials, not the already-synced private projection. In a
          // governed workspace retained calendar rows become owner-only until a new binding is
          // established; otherwise a disconnect would accidentally disclose old event metadata.
          if (bindings.length === 0) return ownerEmail === null || callerEmail === ownerEmail
          if (callerEmail !== undefined && callerEmail === ownerEmail) return true
          if (callerEmail !== undefined && bindings.some((b) => b.boundBy === callerEmail)) return true
          if (callerEmail === undefined) {
            // A governed workspace's `requireRoleForGovernedWorkspace` gate already rejects an anonymous
            // caller before this method is ever reached — reaching here with no email means the
            // workspace is ungoverned (`ownerEmail === null`), which stays fully open, same carve-out
            // every other governed-read gate in this codebase makes.
            return ownerEmail === null
          }

          for (const binding of bindings) {
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
          const result = yield* gatekeeperClient.notifyCalendarTouched(binding.boundBy, binding.id, calendarId).pipe(
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
          const state = yield* mintCalendarOAuthState(workspaceId, boundByEmail, config.stateSecret)
          const { url } = yield* gatekeeperClient.buildAuthorizationUrl(state, config.redirectUri)
          return { authorizationUrl: url, state }
        })

      const completeOAuthCallback: CalendarServiceApi["completeOAuthCallback"] = (
        workspaceId,
        code,
        state,
        calendarId,
        mode
      ) =>
        Effect.gen(function* () {
          yield* requireOAuthConfigured
          const verified = yield* verifyCalendarOAuthState(state, config.stateSecret).pipe(
            Effect.mapError((e) => new ValidationError({ message: e.message }))
          )
          if (verified.workspaceId !== workspaceId) {
            return yield* Effect.fail(new ValidationError({ message: "OAuth state does not match this workspace." }))
          }
          const boundByEmail = yield* decodeEmail(verified.boundByEmail)
          yield* gatekeeperClient.exchangeAndConnect(boundByEmail, code, config.redirectUri).pipe(
            Effect.mapError((cause) => new OAuthExchangeFailed({ message: describeError(cause) }))
          )
          const binding = new GatekeeperBinding({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            gatekeeperKind: "google-calendar",
            boundBy: boundByEmail,
            config: new GoogleCalendarBindingConfig({ kind: "google-calendar", calendarId, mode }),
            createdAt: now()
          })
          yield* collections.gatekeeperBindings.put(binding).pipe(Effect.mapError(toUnexpectedError))
          return binding
        })

      const disconnect: CalendarServiceApi["disconnect"] = (workspaceId, bindingId) =>
        Effect.gen(function* () {
          yield* findBinding(workspaceId, bindingId)
          yield* collections.gatekeeperBindings.delete(bindingId).pipe(Effect.mapError(toUnexpectedError))
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

      /** Find-or-create the Person node for `attendee.email`, extending `emailIndex` in place so
       *  a repeat attendee later in the SAME sync pass reuses it without a second lookup —
       *  "linking without duplicating on repeated syncs" (task item 4), proven across syncs by
       *  `loadEmailIndex` re-scanning real stored facts every call, and within one sync pass by
       *  this cache. */
      const findOrCreatePersonNode = (
        workspaceId: EntityId,
        attendee: RemoteCalendarAttendee,
        emailIndex: Map<string, EntityId | null>
      ): Effect.Effect<EntityId | undefined, DomainError> =>
        Effect.gen(function* () {
          const normalizedEmail = normalizeEmail(attendee.email)
          const existing = emailIndex.get(normalizedEmail)
          if (existing !== undefined) return existing ?? undefined

          const node = new NodeEntity({
            id: crypto.randomUUID() as EntityId,
            workspaceId,
            title: attendee.displayName ?? normalizedEmail,
            createdAt: now()
          })
          yield* nodesRepository.put(node)
          yield* syncFeed.append("node", node.id, "put", node)
          yield* graph.assignTag(workspaceId, node.id, BaseTagIds.Person)
          // Marks this node as calendar-derived — the real membership `hiddenCalendarDerivedNodeIds`
          // filters `listNodes`/`getNode` against for a non-qualifying observer (this file's header
          // comment). Written ONLY on the create branch (never on a cache hit / a node a user made
          // by hand), matching this method's own "find-or-create" semantics exactly.
          yield* collections.calendarDerivedNodes
            .put({ nodeId: node.id, workspaceId })
            .pipe(Effect.mapError(toUnexpectedError))

          const fact = new Fact({
            id: crypto.randomUUID() as EntityId,
            nodeId: node.id,
            predicateId: attendeeEmailPredicate,
            value: normalizedEmail
          })
          yield* factsRepository.put(fact)
          yield* syncFeed.append("fact", fact.id, "put", fact)

          emailIndex.set(normalizedEmail, node.id)
          return node.id
        })

      /** Upserts one remote event into `calendarEvents`, resolving master/occurrence identity per
       *  this file's header comment, and importing every attendee. `masterCache` tracks
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
            const personNodeId = yield* findOrCreatePersonNode(workspaceId, attendee, emailIndex)
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

      const sync: CalendarServiceApi["sync"] = (workspaceId, bindingId) =>
        Effect.gen(function* () {
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
            const otherCalendarsExit = yield* gatekeeperClient.listCalendars(binding.boundBy).pipe(Effect.either)
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
            const page = yield* gatekeeperClient.eventsPage(binding.boundBy, calendarId, {
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
              const planned = planCalendarRemoteEvent(workspaceId, bindingId, remote)
              const requestIdentity = `calendar-projection:${planned.sourceRevisionDigest}`
              const calendarEventId = (yield* existingCalendarEventId(workspaceId, remote.id)) ?? (crypto.randomUUID() as EntityId)
              // A failed gateway transaction rolls its storage back, not JavaScript maps. Keep
              // local identity/master caches isolated until the atomic projection has committed.
              const eventEmailIndex = new Map(emailIndex)
              const eventMasterCache = new Map(masterCache)
              const receipt = yield* Effect.try({
                try: () => projectionGateway.apply({
                  workspaceId,
                  bindingId,
                  // This is an internal entity id, not the provider id. The closure rechecks the
                  // allocation before write, so custody always names the projected event.
                  calendarEventId,
                  requestIdentity,
                  requestId: requestIdentity,
                  sourceRevisionDigest: planned.sourceRevisionDigest,
                  sourceEventKeyDigest: planned.sourceEventKeyDigest,
                  attendeeObservationDigests: planned.attendeeObservationDigests,
                  commitMessage: "Project this calendar revision into the second brain.",
                  attribution: new SystemMutationAttribution({
                    version: "athenaeum.mutation-attribution.v1",
                    kind: "system",
                    source: "calendar-sync"
                  }),
                  applyProjection: () => {
                    const event = Effect.runSync(upsertRemoteEvent(workspaceId, remote, eventEmailIndex, eventMasterCache, calendarEventId))
                    // Both records are backend-private: provider ids and addresses stay here,
                    // while the public ledger/event/outbox sees only their digests.
                    Effect.runSync(collections.calendarSourceRevisions.put({
                      id: sha256HexSync(canonicalJsonBytes({ bindingId, providerEventId: remote.id, sourceRevisionDigest: planned.sourceRevisionDigest })),
                      workspaceId,
                      bindingId,
                      providerEventId: remote.id,
                      sourceRevisionDigest: planned.sourceRevisionDigest,
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
                      const emailDigest = sha256HexSync(canonicalJsonBytes({ workspaceId, email }))
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
              if (receipt.enqueuedRunIds.length > 0) {
                yield* Effect.tryPromise({
                  try: () => config.rearmWorkforce(),
                  catch: (cause) => new UnexpectedError({
                    message: `calendar projection committed but workforce alarm could not rearm: ${cause instanceof Error ? cause.message : String(cause)}`
                  })
                })
              }
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
