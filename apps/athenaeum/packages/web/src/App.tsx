import { lazy, Suspense, useEffect, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { Navigate, Route, Routes } from "react-router"
import type { EntityId } from "@athenaeum/domain"
import { runtime, switchWorkspaceConnection } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId, setActiveWorkspaceId } from "./workspace-id.js"
import { clearSession, loadSession, type DevSession } from "./dev-session.js"
import { SignIn } from "./SignIn.js"
import { AppShell } from "./AppShell.js"
import { ChatPanel } from "./ChatPanel.js"
import { CalendarOAuthCallback } from "./CalendarOAuthCallback.js"
import { catchUpSyncFeed, loadSyncFeedCursor, saveSyncFeedCursor } from "./sync-feed-client.js"

// Perf pass (audit finding "Zero code-splitting", src/App.tsx:15-21 + vite.config.ts): every route
// used to be a synchronous top-level import, so visiting any one of the seven routes downloaded
// all seven's code up front — worst offender is `NotesRoute`, whose `DailyNote` ->
// `RichNoteEditor` chain pulls in ProseMirror *and* the Automerge WASM bundle (`automerge-page.ts`)
// regardless of whether the user ever opens the notes view. `React.lazy` + a dynamic `import()`
// is enough on its own for Rollup/Vite to emit each route as its own chunk (no `manualChunks`
// needed: automerge/prosemirror aren't imported by anything outside the `DailyNote` chain, so they
// land in `NotesRoute`'s chunk and nowhere else) — verified by `vite build`'s own chunk listing.
// All seven routes are split, not just `NotesRoute`, since the mechanism is identical and free for
// the other six; each becomes reachable only via its own request the first time it's visited.
const NotesRoute = lazy(() => import("./routes/NotesRoute.js").then((m) => ({ default: m.NotesRoute })))
// Supertag-centering pass, IA recentering (docs/supertag-centering-decisions.md §3): new route,
// same lazy/code-split treatment as every other section — split for free by the same mechanism,
// not a special case.
const SupertagsRoute = lazy(() =>
  import("./routes/SupertagsRoute.js").then((m) => ({ default: m.SupertagsRoute }))
)
const GraphRoute = lazy(() => import("./routes/GraphRoute.js").then((m) => ({ default: m.GraphRoute })))
// Retrieval pass (design-review 2026-08-22 finding #1): the node view every retrieval surface
// (search, graph rows, backlinks, Cmd/Ctrl+clicked mentions) links into — same lazy/code-split
// treatment as every other route.
const NodeRoute = lazy(() => import("./routes/NodeRoute.js").then((m) => ({ default: m.NodeRoute })))
const CalendarRoute = lazy(() => import("./routes/CalendarRoute.js").then((m) => ({ default: m.CalendarRoute })))
const BookmarksRoute = lazy(() => import("./routes/BookmarksRoute.js").then((m) => ({ default: m.BookmarksRoute })))
const MeetingsRoute = lazy(() => import("./routes/MeetingsRoute.js").then((m) => ({ default: m.MeetingsRoute })))
const WorkoutsRoute = lazy(() => import("./routes/WorkoutsRoute.js").then((m) => ({ default: m.WorkoutsRoute })))
const SharingRoute = lazy(() => import("./routes/SharingRoute.js").then((m) => ({ default: m.SharingRoute })))
const AppsRoute = lazy(() => import("./routes/AppsRoute.js").then((m) => ({ default: m.AppsRoute })))

// Suspense fallback for the routes above — shown only on a route's first visit (subsequent visits
// hit the browser's module cache, no fallback flash). Deliberately not a bare "Loading..." string
// (audit's explicit ask): reuses the sidebar's own brand glyph (`AppShell.tsx`'s `shell-brand-mark`,
// "⌗") as a quietly pulsing mark in the one accent hue this app uses for state/activity, inside the
// same `.route-view` max-width column every route content renders in, so nothing shifts width when
// the real route mounts. The backing `<style>` tag (below, in `Workspace`) is rendered
// unconditionally rather than co-located inside this component, so it's inserted once and never
// remounts/flickers as Suspense fallbacks come and go.
function RouteLoadingFallback() {
  return (
    <div className="route-view">
      <div className="route-loading-fallback" role="status" aria-live="polite">
        <span className="route-loading-fallback-mark" aria-hidden="true">
          ⌗
        </span>
        <span>Loading…</span>
      </div>
    </div>
  )
}

// Shell/routing/visual-system pass (see this repo's `.impeccable.md` for the full design brief).
// Replaces the single flat `Workspace` page the prior phases built with a persistent `AppShell`
// (sidebar + routed main outlet + docked chat rail) — the Effect-based data layer
// (`runtime.ts`/`use-effect-query.ts`/`use-effect-subscription.ts`/`rpc-client.ts`) and every real
// RPC-backed component below are unchanged, only relocated/re-routed. The old "PHASE 0: NODES
// ROUND TRIP" test-harness section (a raw create-node form + a raw `subscribeToNodes` list) is
// removed for good here: `DailyNote` creates real nodes and `GraphView` lists them via a real
// `runView`, so that scaffolding's own round trip is now redundantly exercised by real UI, not
// uniquely provided by it.

/** Everything that depends on a live `WorkspaceRpcClient` connection — mounted only once
 *  `switchWorkspaceConnection` has run for the current (workspace, credential) pair, and remounted (fresh
 *  hook state, fresh subscriptions, a fresh `<Routes>` tree) whenever `App`'s `key` on this
 *  component's wrapper changes. See `runtime.ts`'s header comment for why this remount-via-`key`
 *  mechanism exists at all. */
function Workspace({
  session,
  activeWorkspaceId,
  onSwitchWorkspace,
  onSignOut
}: {
  readonly session: DevSession
  readonly activeWorkspaceId: EntityId
  readonly onSwitchWorkspace: (id: EntityId, title: string) => void
  readonly onSignOut: () => void
}) {
  // Adversarial-review fix (`sync-feed-client.ts`'s header comment has the full rationale): drives
  // the structured-record `syncFeed` protocol once per connection, fire-and-forget — a catch-up/
  // diagnostic pass, not something any render depends on. Unrelated to the removed Phase 0 section
  // above; kept verbatim.
  useEffect(() => {
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => catchUpSyncFeed(client, workspaceId, loadSyncFeedCursor(workspaceId)))
      )
    )
    fiber.addObserver((exit) => {
      if (Exit.isSuccess(exit)) {
        saveSyncFeedCursor(workspaceId, exit.value.cursor)
        console.info(
          `[syncFeed] caught up: epoch=${exit.value.epoch} entriesSeen=${exit.value.entriesSeen}`,
          exit.value.byEntityKind
        )
      } else {
        console.error("[syncFeed] catch-up failed:", exit.cause.toString())
      }
    })
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  return (
    <>
      {/* Handles its own `window.location.pathname` check and renders a full-screen overlay only
          on the OAuth callback path (see its own header comment) — deliberately not a `<Route>`,
          so it works identically regardless of which route is "underneath" it. */}
      <CalendarOAuthCallback />

      {/* Backs `RouteLoadingFallback` above — see that component's comment for why this lives here
          (rendered unconditionally, once) rather than inside the fallback component itself. */}
      <style>{`
        .route-loading-fallback {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-6) 0;
          color: var(--color-text-muted);
          font-family: var(--font-data);
          font-size: var(--text-sm);
        }
        .route-loading-fallback-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1.75rem;
          height: 1.75rem;
          flex-shrink: 0;
          border-radius: var(--radius-sm);
          background: var(--color-accent-tint);
          color: var(--color-accent);
          font-family: var(--font-display);
          animation: route-loading-fallback-pulse 1.1s ease-in-out infinite;
        }
        @keyframes route-loading-fallback-pulse {
          0%, 100% { opacity: 0.55; transform: scale(0.94); }
          50% { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .route-loading-fallback-mark { animation: none; }
        }
      `}</style>

      <Routes>
        <Route
          element={
            <AppShell
              session={session}
              activeWorkspaceId={activeWorkspaceId}
              onSwitchWorkspace={onSwitchWorkspace}
              onSignOut={onSignOut}
              chat={<ChatPanel />}
            />
          }
        >
          <Route index element={<Navigate to="/notes" replace />} />
          <Route
            path="notes"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <NotesRoute />
              </Suspense>
            }
          />
          <Route
            path="supertags"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <SupertagsRoute />
              </Suspense>
            }
          />
          <Route
            path="node/:nodeId"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <NodeRoute />
              </Suspense>
            }
          />
          <Route
            path="graph"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <GraphRoute />
              </Suspense>
            }
          />
          <Route
            path="calendar"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <CalendarRoute />
              </Suspense>
            }
          />
          <Route
            path="bookmarks"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <BookmarksRoute />
              </Suspense>
            }
          />
          <Route
            path="meetings"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <MeetingsRoute />
              </Suspense>
            }
          />
          <Route
            path="workouts"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <WorkoutsRoute />
              </Suspense>
            }
          />
          <Route
            path="sharing"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <SharingRoute />
              </Suspense>
            }
          />
          <Route
            path="apps"
            element={
              <Suspense fallback={<RouteLoadingFallback />}>
                <AppsRoute />
              </Suspense>
            }
          />
          {/* Explicit match so the catch-all below never redirects a user away from the OAuth
              callback path mid-flow — `CalendarOAuthCallback`'s overlay renders above whatever
              this route shows regardless. */}
          <Route path="oauth/google-calendar/callback" element={null} />
          <Route path="*" element={<Navigate to="/notes" replace />} />
        </Route>
      </Routes>
    </>
  )
}

export function App() {
  const [session, setSession] = useState<DevSession | undefined>(() => loadSession())
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<EntityId>(workspaceId)
  const [connectionReady, setConnectionReady] = useState(false)

  // Runs once per (session, active workspace) pair — see this file's header comment and
  // `runtime.ts`'s own doc comment for why this is the one place `switchWorkspaceConnection` is
  // called, and why `<Workspace>` below is only mounted once it's finished (gated on
  // `connectionReady`, cleared and re-set on every change, so a switch never briefly renders
  // `<Workspace>` against the connection it's about to replace).
  useEffect(() => {
    setConnectionReady(false)
    switchWorkspaceConnection(activeWorkspaceId, session?.credential)
    setConnectionReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.credential, activeWorkspaceId])

  if (session === undefined) {
    return <SignIn onSignedIn={setSession} />
  }

  const handleSwitchWorkspace = (id: EntityId) => {
    setActiveWorkspaceId(id) // workspace-id.ts's module setter — persists + updates the live binding
    setActiveWorkspaceIdState(id) // triggers the effect above + the key change below
  }

  const handleSignOut = () => {
    clearSession()
    switchWorkspaceConnection(activeWorkspaceId) // drop back to an anonymous connection
    setConnectionReady(false)
    setSession(undefined)
  }

  if (!connectionReady) return null

  return (
    <Workspace
      key={`${activeWorkspaceId}:${session.credential}`}
      session={session}
      activeWorkspaceId={activeWorkspaceId}
      onSwitchWorkspace={handleSwitchWorkspace}
      onSignOut={handleSignOut}
    />
  )
}
