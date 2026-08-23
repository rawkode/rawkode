import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import * as Automerge from "@automerge/automerge"
import * as Effect from "effect/Effect"
import {
  CreateNodeInput,
  CreatePageInput,
  GetNodeInput,
  GetPageTextInput,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
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
  emptyPageDoc,
  newSyncSessionHandle,
  syncPageWithServer,
  type PageDoc,
  type SyncSessionHandle
} from "./automerge-page.js"
import { ensureRichTextSchema } from "./rich-text/migration.js"
import { RichNoteEditor } from "./RichNoteEditor.js"
import { Backlinks } from "./Backlinks.js"
import { NoteTags } from "./NoteTags.js"
import { SupertagFieldPopover, type SupertagFieldPopoverTarget } from "./SupertagFieldPopover.js"

// Task item 1 ("Daily notes: a view that resolves/creates 'today's' note... and lets the user
// type into it; edits apply as real local Automerge changes and sync to the backend via the real
// Automerge sync-session protocol"). `resolveDailyNote` is the "resolve or create" half
// (deterministic id from `daily-note-id.ts`, so a reload resolves the *same* node/page rather than
// minting a new one every time). The rich-text-editor pass replaced the plain-textarea editing
// surface with `RichNoteEditor` (`docs/rich-text-editor-decisions.md`) — this component keeps
// owning resolve/migrate + the header/sync-status chrome around it, per that stage's own scope
// ("keep the existing header/sync-status UI... only replace the actual editing surface").

interface DailyNoteResolved {
  readonly nodeId: EntityId
  readonly doc: Automerge.Doc<PageDoc>
}

const resolveDailyNote = (
  client: WorkspaceRpcClientService,
  session: SyncSessionHandle,
  date: Date
): Effect.Effect<DailyNoteResolved, DomainError> =>
  Effect.gen(function* () {
    const nodeId = dailyNoteIdForDate(date)

    // "Resolve or create": a `NodeNotFound` here means today's note has never been touched on
    // this workspace — create it with the deterministic id (see `CreateNodeInput.id`'s doc comment in
    // domain's rpc.ts for why the server accepts a caller-supplied id at all). Any other failure
    // (e.g. a network error) propagates as-is, without masking it as "must not exist yet".
    yield* client.getNode(new GetNodeInput({ workspaceId, nodeId })).pipe(
      Effect.catchTag("NodeNotFound", () =>
        client.createNode(new CreateNodeInput({ workspaceId, id: nodeId, title: dailyNoteTitleForDate(date) }))
      )
    )

    // Same resolve-or-create shape for the page: a brand-new node has no page yet.
    yield* client.getPageText(new GetPageTextInput({ workspaceId, nodeId })).pipe(
      Effect.catchTag("PageNotFound", () => client.createPage(new CreatePageInput({ workspaceId, nodeId })))
    )

    // Pull the page's current content into a fresh local Automerge replica via the real sync
    // protocol (not a bytes-fetching RPC — there isn't one, by design; see `automerge-page.ts`).
    const synced = yield* syncPageWithServer(client, workspaceId, nodeId, emptyPageDoc(), session)

    // Migration (task item 3 / decisions doc §4): if this note predates the rich-text schema (flat
    // text, no block markers), wrap it in one paragraph block — a real Automerge change on the
    // *same* just-synced doc, never a fresh genesis (see `migration.ts`'s doc comment). `doc ===
    // synced` (reference equality) when no migration was needed, so the extra sync round trip below
    // is skipped for every already-rich or brand-new-empty note — only a genuine pre-rich-text note
    // pays for a second round trip, and only once, ever, for that note.
    const migrated = ensureRichTextSchema(synced)
    const doc = migrated === synced ? synced : yield* syncPageWithServer(client, workspaceId, nodeId, migrated, session)

    return { nodeId, doc }
  })

// Retrieval pass (design-review 2026-08-22 finding #1, "Day navigation"): this component is now
// parameterized on the day it shows — `NotesRoute` owns the `?date=YYYY-MM-DD` query param,
// passes the resolved `Date` down, and keys this component by the date stamp so a day change is a
// full remount (fresh `useEffectQuery` state, fresh sync-session handle — `SyncSessionHandle`'s
// own contract is "one per resolved note per component lifetime", which the remount preserves
// without touching the sync protocol). Past days open in the SAME editor read-write: the daily
// note id scheme is deterministic per date, so this is literally the same resolve-or-create +
// Automerge-sync mechanism, pointed at another day's node.
export function DailyNote({
  date,
  onNavigateDate
}: {
  readonly date: Date
  readonly onNavigateDate: (stamp: string) => void
}) {
  const navigate = useNavigate()
  // One stable session id for this component's whole mounted lifetime (adversarial-review fix —
  // see `SyncSessionHandle`'s doc comment): created once via the lazy-ref-init pattern (not
  // `useRef(newSyncSessionHandle())`, which would call `crypto.randomUUID()` on every render even
  // though only the first call's result is ever used), then reused by both the initial resolve
  // below and every subsequent debounced edit-sync in `scheduleSync`.
  const sessionRef = useRef<SyncSessionHandle | null>(null)
  if (sessionRef.current === null) sessionRef.current = newSyncSessionHandle()
  const session = sessionRef.current

  const dateStamp = localDateStamp(date)
  const resolveEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => resolveDailyNote(client, session, date))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dateStamp]
  )
  const state = useEffectQuery(resolveEffect, [dateStamp])

  // Sync status now originates inside `RichNoteEditor` (its own debounced `syncPageWithServer`
  // calls) — this component just renders whatever status it's told, exactly the same
  // `sync-status-*` markup/classes as before the rich-text-editor pass, unchanged.
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "synced" | "error">("idle")

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

  const weekdayLabel = date.toLocaleDateString(undefined, { weekday: "long" })
  const todayStamp = localDateStamp(new Date())
  const isToday = dateStamp === todayStamp

  return (
    <section className="daily-note">
      <div className="daily-note-editor">
        <header className="daily-note-header">
          <span className="daily-note-eyebrow">Daily note</span>
          <h2>{weekdayLabel}</h2>
          <p className="daily-note-date">{dateStamp}</p>

          {/* Retrieval pass (finding #1, "Day navigation"): prev/next-day chevrons + a real date
              input, driving `NotesRoute`'s `?date=` param via `onNavigateDate`. The header above
              stays honest for free — weekday + stamp render the SELECTED day, not `new Date()`. */}
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
          </nav>
        </header>

        {state.status === "loading" && (
          <p className="daily-note-loading">
            {isToday ? "Resolving today’s note…" : `Resolving ${dateStamp}…`}
          </p>
        )}
        {state.status === "failure" && <p className="error">{state.error.message}</p>}
        {state.status === "success" && (
          <>
            <RichNoteEditor
              workspaceId={workspaceId}
              nodeId={state.value.nodeId}
              initialDoc={state.value.doc}
              session={session}
              onSyncStatusChange={setSyncStatus}
              autoFocus
              onSupertagApplied={(candidate) => {
                setActiveTag({ tagId: candidate.tagId as EntityId, name: candidate.name })
                setTagsRefreshKey((k) => k + 1)
              }}
              onOpenEntityRef={(refNodeId) => navigate(`/node/${refNodeId}`)}
            />
            <p className={`sync-status sync-status-${syncStatus}`}>
              <span className="sync-status-dot" aria-hidden="true" />
              {syncStatus === "idle" && "Ready"}
              {syncStatus === "syncing" && "Syncing…"}
              {syncStatus === "synced" && "Synced"}
              {syncStatus === "error" && "Sync failed — check the console"}
            </p>
            <NoteTags nodeId={state.value.nodeId} refreshKey={tagsRefreshKey} onSelectTag={setActiveTag} />
          </>
        )}
      </div>

      {state.status === "success" && <Backlinks nodeId={state.value.nodeId} />}

      {state.status === "success" && activeTag !== null && (
        <SupertagFieldPopover
          nodeId={state.value.nodeId}
          tag={activeTag}
          onClose={() => setActiveTag(null)}
          onSaved={() => setTagsRefreshKey((k) => k + 1)}
        />
      )}
    </section>
  )
}
