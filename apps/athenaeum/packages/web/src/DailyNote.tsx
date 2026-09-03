import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import * as Effect from "effect/Effect"
import {
  CreateLoroPageInput,
  CreationIntent,
  GetLegacyPageProjectionInput,
  HumanUiMutationAttribution,
  LoroMutationIntentV1,
  MigrateLegacyPageInput,
  CreateNodeWithIntentInput,
  GetPageDocumentDescriptorInput,
  GetNodeInput,
  UnexpectedError,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { runtime } from "./runtime.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import {
  dailyNoteIdForDate,
  dailyNoteTitleForDate,
  localDateStamp,
  parseDateStamp,
  shiftDateStamp
} from "./daily-note-id.js"
import {
  inspectLoroPage,
  convergeLoroPageFromServer,
  type LoroPageDocument
} from "./loro-page.js"
import { LoroRichNoteEditor, type PrepareMeetingHandler } from "./LoroRichNoteEditor.js"
import { Backlinks } from "./Backlinks.js"
import { NoteTags } from "./NoteTags.js"
import { SupertagFieldPopover, type SupertagFieldPopoverTarget } from "./SupertagFieldPopover.js"
import { DAILY_STANDUP_ANCHOR_ID, DailyStandup } from "./LedgerActivityPanel.js"
import { useDailyStandup } from "./use-daily-standup.js"
import { focusWorkforceAttentionItem } from "./EmployeeUpdates.js"
import { WorkforceAttentionStrip } from "./WorkforceAttentionStrip.js"

// `resolveDailyNote` is the "resolve or create" half
// (deterministic id from `daily-note-id.ts`, so a reload resolves the *same* node/page rather than
// minting a new one every time). New pages are created directly in Loro; legacy pages are a
// server-projected, read-only migration lane and never initialize an Automerge client.

type DailyNoteResolved =
  | {
      readonly nodeId: EntityId
      readonly format: "automerge-v1"
      readonly projection: import("@athenaeum/domain").GetLegacyPageProjectionOutput
    }
  | {
      readonly nodeId: EntityId
      readonly format: "loro-v1"
      readonly page: LoroPageDocument
      readonly descriptor: Extract<import("@athenaeum/domain").PageDocumentDescriptor, { activeFormat: "loro-v1" }>
    }

export type DailyNotePageFormat = DailyNoteResolved["format"]

type LegacyProjectionContent = import("@athenaeum/domain").GetLegacyPageProjectionOutput["content"]

export const legacyMigrationAvailability = (content: LegacyProjectionContent):
  | { readonly available: true }
  | { readonly available: false; readonly message: string } => content.kind === "plainText"
  ? { available: true }
  : {
      available: false,
      message: content.kind === "tooLarge"
        ? "Migration is unavailable because this legacy note is too large to convert safely."
        : "Migration is unavailable because this legacy rich-text note cannot be converted losslessly."
    }

const legacyWitnessKey = (projection: import("@athenaeum/domain").GetLegacyPageProjectionOutput): string =>
  [
    projection.descriptor.nodeId,
    projection.descriptor.storageVersion,
    projection.descriptor.automerge.docId,
    projection.descriptor.automerge.headsHash,
    projection.descriptor.automerge.bytesSha256
  ].join(":")

export const legacyMigrationReconciliation = (
  attemptedWitness: string,
  resolved: DailyNoteResolved
): "adopted-loro" | "retry-same-witness" | "review-new-witness" => resolved.format === "loro-v1"
  ? "adopted-loro"
  : legacyWitnessKey(resolved.projection) === attemptedWitness
    ? "retry-same-witness"
    : "review-new-witness"

export type LegacyMigrationIntentState = {
  readonly witness: string
  readonly intent: LoroMutationIntentV1
}

export const legacyMigrationIntentForWitness = (
  current: LegacyMigrationIntentState | null,
  witness: string,
  create: () => LoroMutationIntentV1
): LegacyMigrationIntentState => current?.witness === witness
  ? current
  : { witness, intent: create() }

export type LegacyMigrationRouteClaim = {
  readonly stamp: string
  readonly generation: number
}

export const legacyMigrationRouteIsCurrent = (
  claim: LegacyMigrationRouteClaim,
  current: LegacyMigrationRouteClaim
): boolean => claim.stamp === current.stamp && claim.generation === current.generation

export type DailyNotePageFormatPresentation = {
  readonly label: string
  readonly description: string
  readonly tone: "authoritative" | "legacy"
}

/**
 * Keep the migration boundary legible at the point where a person is writing. Loro is the
 * product path; Automerge is shown only when the resolved descriptor explicitly selects the
 * compatibility lane. This is a presentation contract, not a routing decision.
 */
export const dailyNotePageFormatPresentation = (
  format: DailyNotePageFormat
): DailyNotePageFormatPresentation => format === "loro-v1"
  ? {
      label: "Loro",
      description: "Loro is authoritative for this page.",
      tone: "authoritative"
    }
  : {
      label: "Legacy Automerge",
      description: "This page is still using the legacy Automerge compatibility lane.",
      tone: "legacy"
    }

export const resolveDailyNote = (
  client: WorkspaceRpcClientService,
  creationIntent: CreationIntent,
  date: Date,
  nodeCreationIntent: CreationIntent = new CreationIntent({
    requestId: crypto.randomUUID(),
    commitMessage: "Create the daily note entity.",
    attribution: new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1",
      kind: "humanUi",
      surface: "rich-text-editor"
    })
  })
): Effect.Effect<DailyNoteResolved, DomainError> =>
  Effect.gen(function* () {
    const nodeId = dailyNoteIdForDate(date)

    // "Resolve or create": a `NodeNotFound` here means today's note has never been touched on
    // this workspace — create it with the deterministic id through the strict provenance route.
    // Any other failure
    // (e.g. a network error) propagates as-is, without masking it as "must not exist yet".
    yield* client.getNode(new GetNodeInput({ workspaceId, nodeId })).pipe(
      Effect.catchTag("NodeNotFound", () =>
        client.createNodeWithIntent(new CreateNodeWithIntentInput({
          workspaceId,
          id: nodeId,
          title: dailyNoteTitleForDate(date),
          requestId: nodeCreationIntent.requestId,
          commitMessage: nodeCreationIntent.commitMessage,
          attribution: nodeCreationIntent.attribution
        })).pipe(
          // Another tab may win the deterministic daily-note identity between get and create.
          // Accept that race only when the existing node is the intended note; never overwrite or
          // silently attach a page to an unrelated node.
          Effect.catchTag("NodeAlreadyExists", () =>
            client.getNode(new GetNodeInput({ workspaceId, nodeId })).pipe(
              Effect.flatMap((existing) => existing.node.title === dailyNoteTitleForDate(date)
                ? Effect.succeed(existing)
                : Effect.fail(new UnexpectedError({ message: `daily note id ${nodeId} already belongs to a different node` })))
            )
          )
        )
      )
    )

    // Resolve the document descriptor first. Unlike the legacy text RPC, this is valid for both
    // formats and lets an already-Loro page bypass the Automerge endpoint entirely.
    const descriptor = yield* client.getPageDocumentDescriptor(
      new GetPageDocumentDescriptorInput({ workspaceId, nodeId })
    ).pipe(
      Effect.catchTag("PageNotFound", () =>
        Effect.gen(function* () {
          const created = yield* client.createLoroPage(new CreateLoroPageInput({ workspaceId, nodeId, creationIntent }))
          return created
        })
      )
    )

    // Legacy authority is projected by the server and remains read-only in the shipped web
    // client. Rebind the projection to the descriptor we just resolved so a migration can never
    // be offered against a stale or substituted Automerge witness.
    if (descriptor.descriptor.activeFormat === "automerge-v1") {
      const projection = yield* client.getLegacyPageProjection(
        new GetLegacyPageProjectionInput({ workspaceId, nodeId })
      )
      if (
        projection.descriptor.nodeId !== descriptor.descriptor.nodeId ||
        projection.descriptor.storageVersion !== descriptor.descriptor.storageVersion ||
        projection.descriptor.automerge.docId !== descriptor.descriptor.automerge.docId ||
        projection.descriptor.automerge.headsHash !== descriptor.descriptor.automerge.headsHash ||
        projection.descriptor.automerge.bytesSha256 !== descriptor.descriptor.automerge.bytesSha256
      ) {
        return yield* Effect.fail(new UnexpectedError({ message: "Legacy page changed while its read-only projection was loading. Retry before migrating." }))
      }
      return { nodeId, format: "automerge-v1", projection }
    }

    const doc = yield* convergeLoroPageFromServer(client, workspaceId, nodeId)
    return { nodeId, format: "loro-v1", page: inspectLoroPage(doc), descriptor: descriptor.descriptor }
  })

// Retrieval pass (design-review 2026-08-22 finding #1, "Day navigation"): this component is now
// parameterized on the day it shows — `NotesRoute` owns the `?date=YYYY-MM-DD` query param,
// passes the resolved `Date` down, and keys this component by the date stamp so a day change is a
// full remount (fresh `useEffectQuery` state, fresh sync-session handle — `SyncSessionHandle`'s
// own contract is "one per resolved note per component lifetime", which the remount preserves
// without touching the sync protocol). Past days open in the SAME editor read-write: the daily
// note id scheme is deterministic per date, so this is literally the same resolve-or-create +
// format-aware sync mechanism, pointed at another day's node.
export function DailyNote({
  date,
  onNavigateDate,
  onPrepareMeetingReady,
  todayBriefTargetId,
  dailyContext
}: {
  readonly date: Date
  readonly onNavigateDate: (stamp: string) => void
  readonly onPrepareMeetingReady?: (prepare: PrepareMeetingHandler | undefined) => void
  /** Fragment target for the current day's secondary context, shown as a quiet mobile affordance. */
  readonly todayBriefTargetId?: string
  /** The single live context projection for this note. It stays beside the prose on wide layouts
   * and moves between the header and editor on constrained layouts without a second fetch. */
  readonly dailyContext?: ReactNode
}) {
  const navigate = useNavigate()
  // This is deliberately a ref, not a render-time value: an uncertain PageNotFound/create
  // response must be retried with identical provenance and fingerprint.
  const creationIntentRef = useRef<CreationIntent | null>(null)
  if (creationIntentRef.current === null) {
    creationIntentRef.current = new CreationIntent({
      requestId: crypto.randomUUID(), commitMessage: "Create daily note",
      attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
    })
  }
  const creationIntent = creationIntentRef.current
  // Node identity and Loro-page identity are separate ledger operations. Keep the node intent
  // stable for the whole resolve flow so a network-uncertain create can be replayed exactly.
  const nodeCreationIntentRef = useRef<CreationIntent | null>(null)
  if (nodeCreationIntentRef.current === null) {
    nodeCreationIntentRef.current = new CreationIntent({
      requestId: crypto.randomUUID(),
      commitMessage: "Create the daily note entity.",
      attribution: new HumanUiMutationAttribution({
        version: "athenaeum.mutation-attribution.v1",
        kind: "humanUi",
        surface: "rich-text-editor"
      })
    })
  }
  const nodeCreationIntent = nodeCreationIntentRef.current
  const migrationIntentRef = useRef<LegacyMigrationIntentState | null>(null)
  const intentForLegacyWitness = useCallback((witness: string): LoroMutationIntentV1 => {
    const state = legacyMigrationIntentForWitness(migrationIntentRef.current, witness, () =>
      new LoroMutationIntentV1({
        requestId: crypto.randomUUID(),
        commitMessage: "Migrate this legacy daily note to Loro.",
        attribution: new HumanUiMutationAttribution({
          version: "athenaeum.mutation-attribution.v1",
          kind: "humanUi",
          surface: "rich-text-editor"
        })
      })
    )
    migrationIntentRef.current = state
    return state.intent
  }, [])

  const dateStamp = localDateStamp(date)
  // A resolver retry deliberately retains the two intent refs above, so an uncertain create
  // resumes with its original provenance instead of minting a second daily note operation.
  const [resolveRetryKey, setResolveRetryKey] = useState(0)
  const [preparationNotice, setPreparationNotice] = useState<string | undefined>(undefined)
  const [resolveRetryClaimed, setResolveRetryClaimed] = useState(false)
  const resolveRetryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const resolveEffect = useMemo(
    () => WorkspaceRpcClient.pipe(
      Effect.flatMap((client) => resolveDailyNote(client, creationIntent, date, nodeCreationIntent))
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dateStamp, resolveRetryKey]
  )
  const state = useEffectQuery(resolveEffect, [dateStamp, resolveRetryKey])
  useEffect(() => {
    const claim = resolveRetryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The retry-key render still has the preceding failure state. Release only after the claimed
    // generation enters loading and reaches a terminal resolver result.
    if (!claim.sawLoading) return
    resolveRetryClaim.current = undefined
    setResolveRetryClaimed(false)
  }, [state.status])
  const retryResolve = useCallback(() => {
    if (resolveRetryClaim.current !== undefined || state.status === "loading") return
    resolveRetryClaim.current = { sawLoading: false }
    setResolveRetryClaimed(true)
    setResolveRetryKey((key) => key + 1)
  }, [state.status])
  const isRetryingResolution = resolveRetryClaimed || state.status === "loading"
  const [migrationState, setMigrationState] = useState<"idle" | "migrating" | "reconciling" | "failed">("idle")
  const migrationAttemptRef = useRef<{ readonly witness: string; readonly route: LegacyMigrationRouteClaim; sawLoading: boolean } | null>(null)
  const routeRef = useRef({ stamp: dateStamp, generation: 0 })
  if (routeRef.current.stamp !== dateStamp) routeRef.current = { stamp: dateStamp, generation: routeRef.current.generation + 1 }
  const migrateLegacyPage = useCallback(() => {
    if (state.status !== "success" || state.value.format !== "automerge-v1" || migrationState === "migrating") return
    const projection = state.value.projection
    if (!legacyMigrationAvailability(projection.content).available) return
    const witness = legacyWitnessKey(projection)
    const route = { ...routeRef.current }
    const migrationIntent = intentForLegacyWitness(witness)
    migrationAttemptRef.current = { witness, route, sawLoading: false }
    setMigrationState("migrating")
    runtime.runPromise(WorkspaceRpcClient.pipe(
      Effect.flatMap((client) => client.migrateLegacyPage(new MigrateLegacyPageInput({
        workspaceId,
        nodeId: state.value.nodeId,
        expectedStorageVersion: projection.descriptor.storageVersion,
        expectedAutomerge: projection.descriptor.automerge,
        intent: migrationIntent
      })))
    )).then(
      () => {
        if (!legacyMigrationRouteIsCurrent(route, routeRef.current)) return
        setMigrationState("idle")
        setResolveRetryKey((key) => key + 1)
      },
      () => {
        if (!legacyMigrationRouteIsCurrent(route, routeRef.current)) return
        // A rejected response is ambiguous: the server may have committed, or another client may
        // have migrated/changed the witness. Re-resolve authority before offering any retry.
        setMigrationState("reconciling")
        setResolveRetryKey((key) => key + 1)
      }
    )
  }, [dateStamp, intentForLegacyWitness, migrationState, state])
  useEffect(() => {
    const attempt = migrationAttemptRef.current
    if (migrationState !== "reconciling" || attempt === null) return
    if (!legacyMigrationRouteIsCurrent(attempt.route, routeRef.current)) return
    if (state.status === "loading") {
      attempt.sawLoading = true
      return
    }
    if (!attempt.sawLoading || state.status !== "success") return
    const reconciliation = legacyMigrationReconciliation(attempt.witness, state.value)
    migrationAttemptRef.current = null
    if (reconciliation === "retry-same-witness") {
      setMigrationState("failed")
    } else {
      if (reconciliation === "review-new-witness" && state.value.format === "automerge-v1") {
        intentForLegacyWitness(legacyWitnessKey(state.value.projection))
      }
      setMigrationState("idle")
    }
  }, [intentForLegacyWitness, migrationState, state])
  // Sync status now originates inside `RichNoteEditor` (its own debounced `syncPageWithServer`
  // calls). A calm editor intentionally has no status row: notices are reserved for active work
  // or an action a person may need to take.
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "error" | "conflict">("idle")
  const [retrySync, setRetrySync] = useState<(() => void) | undefined>(undefined)
  const [syncRetryClaimed, setSyncRetryClaimed] = useState(false)
  const syncRetryClaim = useRef<{ sawSyncing: boolean } | undefined>(undefined)
  const registerSyncRetry = useCallback((retry: (() => void) | undefined) => {
    setRetrySync(() => retry)
  }, [])
  useEffect(() => {
    const claim = syncRetryClaim.current
    if (claim === undefined) return
    if (syncStatus === "syncing") {
      claim.sawSyncing = true
      return
    }
    if (!claim.sawSyncing) {
      // Both editor lanes synchronously report `syncing` when a retry starts. If a stale callback
      // declines to start work, release this presentation-only claim rather than stranding Retry.
      syncRetryClaim.current = undefined
      setSyncRetryClaimed(false)
      return
    }
    // A retry that entered syncing has now settled, so a later explicit Retry may begin a new
    // attempt without changing either editor's transport contract.
    syncRetryClaim.current = undefined
    setSyncRetryClaimed(false)
  }, [syncStatus])
  const retryFailedSync = useCallback(() => {
    if (retrySync === undefined || syncRetryClaim.current !== undefined || syncStatus === "syncing") return
    syncRetryClaim.current = { sawSyncing: false }
    setSyncRetryClaimed(true)
    retrySync()
  }, [retrySync, syncStatus])
  const isRetryingSync = syncRetryClaimed || syncStatus === "syncing"

  // Supertag-centering pass (docs/supertag-centering-decisions.md §2/§3): "one data model, two
  // entry points" — `activeTag` drives the field-editing popover whether it was opened by typing
  // `#tag` inline (`RichNoteEditor`'s `onSupertagApplied`) or by clicking an existing chip in
  // `NoteTags` below. `tagsRefreshKey` re-runs `NoteTags`'s own `runView` read after a save, so a
  // field edited in the popover (or a brand-new tag applied inline) shows up in the chip row
  // without a full page reload.
  const [activeTag, setActiveTag] = useState<SupertagFieldPopoverTarget | null>(null)
  const [tagsRefreshKey, setTagsRefreshKey] = useState(0)

  useEffect(() => {
    if (state.status === "success") setSyncStatus("synced")
  }, [state.status === "success" ? state.value.nodeId : undefined])
  useEffect(() => {
    if (state.status === "success" && state.value.format === "automerge-v1") onPrepareMeetingReady?.(undefined)
  }, [onPrepareMeetingReady, state.status === "success" ? state.value.format : undefined])

  const fullDateLabel = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  })
  const todayStamp = localDateStamp(new Date())
  const isToday = dateStamp === todayStamp
  // One controller serves the compact Today cue and the detailed subdocument. Until resolve
  // succeeds it receives no note identity, which makes stale workforce data impossible to show.
  const standup = useDailyStandup({
    dailyNoteId: state.status === "success" ? state.value.nodeId : undefined,
    isToday
  })
  const currentDailyNoteId = state.status === "success" ? state.value.nodeId : undefined
  const [focusedWorkforcePublicationId, setFocusedWorkforcePublicationId] = useState<EntityId | undefined>(undefined)
  // A refresh, date transition, or resolve change invalidates this presentation-only witness
  // before a later DOM focus attempt could land in another daily note's standup.
  useEffect(() => {
    setFocusedWorkforcePublicationId(undefined)
  }, [dateStamp, currentDailyNoteId, standup.snapshot.generation, standup.employeeUpdates.status])
  const reviewWorkforceItem = useCallback((publicationId: EntityId) => {
    if (
      !isToday ||
      currentDailyNoteId === undefined ||
      standup.snapshot.dailyNoteId !== currentDailyNoteId ||
      standup.employeeUpdates.status !== "success" ||
      !standup.employeeUpdates.publications.some((publication) => publication.id === publicationId)
    ) return
    setFocusedWorkforcePublicationId(publicationId)
    focusWorkforceAttentionItem(publicationId)
  }, [currentDailyNoteId, isToday, standup.employeeUpdates, standup.snapshot.dailyNoteId])
  const pageFormat = state.status === "success"
    ? dailyNotePageFormatPresentation(state.value.format)
    : undefined
  const showSyncStatus = syncStatus === "syncing" || syncStatus === "error" || syncStatus === "conflict"

  return (
    <section className="daily-note">
      <div className="daily-note-workspace">
      <div className="daily-note-editor">
        <header className={`daily-note-header${isToday ? " daily-note-header-today" : ""}`}>
          <h1 aria-label={`Daily note for ${fullDateLabel}`}>
            {!isToday && <span className="daily-note-title">Daily note</span>}
            <time dateTime={dateStamp}>{fullDateLabel}</time>
          </h1>
          {pageFormat?.tone === "legacy" && (
            <span
              className={`daily-note-format daily-note-format-${pageFormat.tone}`}
              title={pageFormat.description}
              aria-label={pageFormat.description}
              data-page-format="automerge-v1"
            >
              <span className="daily-note-format-dot" aria-hidden="true" />
              {pageFormat.label}
            </span>
          )}

          {/* Retrieval pass (finding #1, "Day navigation"): prev/next-day chevrons + a real date
              input, driving `NotesRoute`'s `?date=` param via `onNavigateDate`. The header above
              stays honest for free — the full date renders the SELECTED day, not `new Date()`. */}
          <nav className="daily-note-day-nav" aria-label="Daily note day">
            <button
              type="button"
              className="daily-note-day-nav-step"
              onClick={() => onNavigateDate(shiftDateStamp(dateStamp, -1))}
              aria-label="Previous day"
              title="Previous day"
            >
              ‹
            </button>
            <input
              type="date"
              className="daily-note-day-nav-date"
              value={dateStamp}
              onChange={(event) => {
                // A partially-typed date fires `change` with an invalid/empty value — ignore
                // anything that isn't a real calendar date instead of navigating to garbage.
                if (parseDateStamp(event.target.value) !== undefined) onNavigateDate(event.target.value)
              }}
              aria-label="Jump to date"
            />
            <button
              type="button"
              className="daily-note-day-nav-step"
              onClick={() => onNavigateDate(shiftDateStamp(dateStamp, 1))}
              aria-label="Next day"
              title="Next day"
            >
              ›
            </button>
            {!isToday && (
              <button
                type="button"
                className="daily-note-day-nav-today"
                onClick={() => onNavigateDate(todayStamp)}
              >
                Today
              </button>
            )}
            {todayBriefTargetId !== undefined && (
              <a className="daily-note-brief-jump" href={`#${todayBriefTargetId}`}>
                Today’s brief
              </a>
            )}
            {isToday && state.status === "success" && standup.snapshot.dailyNoteId !== undefined && (
              <a className="daily-note-standup-jump" href={`#${DAILY_STANDUP_ANCHOR_ID}`}>
                Review standup
              </a>
            )}
          </nav>
        </header>

        {isToday && state.status === "success" && (
          <WorkforceAttentionStrip
            state={standup.employeeUpdates}
            onRetry={standup.refresh}
            onReviewItem={reviewWorkforceItem}
          />
        )}

        <div
          className={`daily-note-canvas daily-note-canvas-${state.status}`}
          aria-busy={state.status === "loading"}
          aria-live={state.status === "failure" ? "assertive" : state.status === "loading" ? "polite" : undefined}
          role={state.status === "failure" ? "alert" : undefined}
        >
          {state.status === "loading" && (
            <p className="daily-note-loading">
              {isToday ? "Resolving today’s note…" : `Resolving ${dateStamp}…`}
            </p>
          )}
          {state.status === "failure" && (
            <section className="daily-note-resolution-error">
              <div>
                <h2>Daily note is unavailable</h2>
                <p>We couldn&rsquo;t resolve this daily note. Retry to continue loading this date safely.</p>
              </div>
              <button type="button" onClick={retryResolve} disabled={isRetryingResolution}>
                {isRetryingResolution ? "Retrying…" : "Retry"}
              </button>
            </section>
          )}
          {state.status === "success" && (
            <>
              {state.value.format === "loro-v1" ? (
                <LoroRichNoteEditor
                  workspaceId={workspaceId}
                  nodeId={state.value.nodeId}
                  initialPage={state.value.page}
                  initialDescriptor={state.value.descriptor}
                  onSyncStatusChange={setSyncStatus}
                  onSyncRetryReady={registerSyncRetry}
                  autoFocus
                  onSupertagApplied={(candidate, anchorRect, anchorRectSource) => {
                    setActiveTag({ tagId: candidate.tagId as EntityId, name: candidate.name, anchorRect, anchorRectSource })
                    setTagsRefreshKey((k) => k + 1)
                  }}
                  onOpenEntityRef={(refNodeId) => navigate(`/node/${refNodeId}`)}
                  offerPlanToday={isToday && state.value.descriptor.storageVersion === 1}
                  onPrepareMeetingReady={onPrepareMeetingReady}
                  onPreparationCompleted={() => setPreparationNotice("Meeting prepared in this daily note.")}
                  onAcceptedHumanEdit={() => setPreparationNotice(undefined)}
                />
              ) : (
                <section className="legacy-daily-note-projection" aria-labelledby="legacy-daily-note-title">
                  <div>
                    <span className="section-kicker">Read-only legacy note</span>
                    <h2 id="legacy-daily-note-title">
                      {legacyMigrationAvailability(state.value.projection.content).available ? "Migrate to continue writing" : "Legacy note preview"}
                    </h2>
                    <p>
                      {legacyMigrationAvailability(state.value.projection.content).available
                        ? "This Automerge-era note is frozen in the web client. Review its safe projection, then migrate it to the authoritative Loro format."
                        : "This Automerge-era note is frozen in the web client. The projection is available for reference while a lossless migration path is unavailable."}
                    </p>
                  </div>
                  {state.value.projection.content.kind === "plainText" ? (
                    <pre className="legacy-daily-note-text">{state.value.projection.content.text}</pre>
                  ) : (
                    <p className="legacy-daily-note-unavailable">
                      {state.value.projection.content.kind === "tooLarge"
                        ? "Migration is unavailable because this legacy note is too large to convert safely."
                        : "Migration is unavailable because this legacy rich-text note cannot be converted losslessly."}
                    </p>
                  )}
                  <div className="legacy-daily-note-actions">
                    {legacyMigrationAvailability(state.value.projection.content).available && (
                      <button type="button" onClick={migrateLegacyPage} disabled={migrationState === "migrating" || migrationState === "reconciling"}>
                        {migrationState === "migrating" ? "Migrating…" : migrationState === "reconciling" ? "Checking latest version…" : migrationState === "failed" ? "Retry migration" : "Migrate to Loro"}
                      </button>
                    )}
                    {migrationState === "failed" && <p role="alert">Migration couldn&rsquo;t be completed. The legacy note remains unchanged.</p>}
                  </div>
                </section>
              )}
              {preparationNotice !== undefined && <p className="sync-status" role="status" aria-live="polite">{preparationNotice}</p>}
              {showSyncStatus && (
                <p
                  className={`sync-status sync-status-${syncStatus}`}
                  role={
                    syncStatus === "syncing"
                      ? "status"
                      : syncStatus === "error" || syncStatus === "conflict"
                        ? "alert"
                        : undefined
                  }
                  aria-live={syncStatus === "syncing" ? "polite" : undefined}
                  aria-atomic={syncStatus === "syncing" ? true : undefined}
                >
                  <span className="sync-status-dot" aria-hidden="true" />
                  {syncStatus === "syncing" && (
                    <>
                      <span>Syncing…</span>
                      {syncRetryClaimed && <button type="button" className="sync-status-retry" disabled>Retrying…</button>}
                    </>
                  )}
                  {syncStatus === "error" && (
                    <>
                      <span>Sync failed — your local changes are still here.</span>
                      {retrySync !== undefined && (
                        <button type="button" className="sync-status-retry" onClick={retryFailedSync} disabled={isRetryingSync}>
                          {isRetryingSync ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </>
                  )}
                  {syncStatus === "conflict" && "Conflict — your local draft is preserved."}
                </p>
              )}
              <NoteTags
                nodeId={state.value.nodeId}
                refreshKey={tagsRefreshKey}
                onSelectTag={(chip, anchorRect, anchorRectSource) => setActiveTag({ ...chip, anchorRect, anchorRectSource })}
              />
            </>
          )}
        </div>
      </div>
      {dailyContext !== undefined && (
        <div className="daily-note-context">
          {dailyContext}
        </div>
      )}
      </div>

      {state.status === "success" && (
        <DailyStandup standup={standup} focusedPublicationId={focusedWorkforcePublicationId} />
      )}

      {state.status === "success" && <Backlinks nodeId={state.value.nodeId} />}

      {state.status === "success" && activeTag !== null && (
        <SupertagFieldPopover
          key={state.value.nodeId + ":" + activeTag.tagId}
          nodeId={state.value.nodeId}
          tag={activeTag}
          onClose={() => setActiveTag(null)}
          onSaved={() => setTagsRefreshKey((k) => k + 1)}
        />
      )}
    </section>
  )
}
