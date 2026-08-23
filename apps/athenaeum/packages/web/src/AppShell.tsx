import { useState, type ReactNode } from "react"
import { NavLink, Outlet } from "react-router"
import type { EntityId } from "@athenaeum/domain"
import type { DevSession } from "./dev-session.js"
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js"
import { SearchBox } from "./SearchBox.js"

// The shell everything else builds on (task item 4): a persistent left sidebar (workspace switcher +
// sign-in status, then section nav), a main content outlet for the routed views (`<Outlet />` —
// react-router's own layout-route mechanism, not a hand-rolled `{children}` prop), and a docked
// right chat rail that's always reachable and never a modal. Structural/tonal inspiration is
// cloudflare-os's workshop-frontend `AppShell.tsx` (persistent rail + routed main column + a
// collapse affordance) — deliberately not its literal Tailwind/kumo styling, per this stage's own
// hard constraint.
//
// Narrow-viewport behavior for the chat rail is container-query-based (`@container shell`, see
// AppShell.css), not a media-query breakpoint that just hides it: below the threshold the rail
// becomes a slide-in drawer, toggled by a button that's only shown at that width — the agent chat
// and pending-changes UI stay reachable at any viewport width, just not permanently docked below
// the threshold. `chatOpen` state (not just CSS) drives this so the same markup works at both
// widths: wide viewports ignore `chatOpen` (the rail is always visible via CSS), narrow ones use
// it to toggle the drawer's `open` class.

// Supertag-centering pass, IA recentering (docs/supertag-centering-decisions.md §3, "Sidebar
// order — decided"): `/notes` keeps its URL (no churn to `App.tsx`'s existing default-route
// redirect) but relabels to "Today" — a one-word signal that the daily note is home, not one
// section among equals — and `/supertags` (new, `SupertagsRoute.tsx`) slots in second, ahead of
// `/graph`, since Supertags is the other half of "daily notes + Supertags as the CENTER of the
// product experience" per the task's own framing.
//
// Adversarial-review fix (post-review addendum, docs/supertag-centering-decisions.md §3's "Sidebar
// order — decided" note): list ORDER alone read as "just reordered," not "centered" — every item
// still shared the identical `shell-nav-item` class/weight/size, which is exactly the "sidebar of
// parallel co-equal sections" anti-pattern the framing rejects. `NAV_ITEMS` is now split into two
// real groups, rendered as two visually distinct `<nav>` blocks (`shell-nav-core` /
// `shell-nav-more`, AppShell.css): Today/Supertags get a larger, bolder, icon-chipped treatment —
// the same "icon-in-a-tinted-box" affordance `.shell-brand-mark` already uses for the app mark
// itself, deliberately reused so the core two sections read as being at the SAME visual tier as
// the brand, not the nav list — and a labeled "More" divider demotes the other seven to a smaller,
// muted list beneath it. This is a visual-hierarchy fix only: routes, labels, and relative order
// within each group are unchanged from the original decision.
const CORE_NAV_ITEMS: ReadonlyArray<{ readonly to: string; readonly label: string; readonly icon: string }> = [
  { to: "/notes", label: "Today", icon: "☀" },
  { to: "/supertags", label: "Supertags", icon: "#" }
]

const MORE_NAV_ITEMS: ReadonlyArray<{ readonly to: string; readonly label: string }> = [
  { to: "/graph", label: "Graph" },
  { to: "/calendar", label: "Calendar" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/meetings", label: "Meetings" },
  { to: "/workouts", label: "Workouts" },
  { to: "/sharing", label: "Sharing" },
  { to: "/apps", label: "Apps" }
]

export function AppShell({
  session,
  activeWorkspaceId,
  onSwitchWorkspace,
  onSignOut,
  chat
}: {
  readonly session: DevSession
  readonly activeWorkspaceId: EntityId
  readonly onSwitchWorkspace: (id: EntityId, title: string) => void
  readonly onSignOut: () => void
  readonly chat: ReactNode
}) {
  const [chatOpen, setChatOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Design-review 2026-08-22 finding #19 / layout lens O7 ("stacked drawers", confirmed in
  // source): at narrow widths both drawers are off-canvas overlays, and the two `useState`s above
  // were fully independent — opening the second drawer stacked it on top of the first (the
  // review's double-✕ capture, `nav-drawer-390.png`). The toggles now make them mutually
  // exclusive: opening either drawer closes the other. Closing one never opens anything, and at
  // wide widths the docked rail ignores `chatOpen` entirely (see the header comment), so this
  // changes nothing about the docked layout.
  const toggleSidebar = () => {
    setChatOpen(false)
    setSidebarOpen((open) => !open)
  }
  const toggleChat = () => {
    setSidebarOpen(false)
    setChatOpen((open) => !open)
  }

  return (
    <div className="shell-container">
      <div className="shell">
      <aside
        className={`shell-sidebar${sidebarOpen ? " shell-sidebar-open" : ""}`}
        aria-label="Workspace"
      >
        <div className="shell-brand">
          <span className="shell-brand-mark" aria-hidden="true">
            ⌗
          </span>
          <span className="shell-brand-name">Athenaeum</span>
        </div>

        <div className="shell-session">
          <WorkspaceSwitcher session={session} activeWorkspaceId={activeWorkspaceId} onSwitch={onSwitchWorkspace} />
          <div className="shell-account">
            <span className="shell-account-email" title={session.email}>
              {session.email}
            </span>
            <span className="shell-account-badge">dev</span>
          </div>
          <button type="button" className="shell-sign-out" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        {/* Retrieval pass (design-review 2026-08-22 finding #1, "Search"): the one persistent
            search input the review verified didn't exist anywhere in the shell — see
            `SearchBox.tsx`'s own header comment for the placement rationale. */}
        <SearchBox onNavigated={() => setSidebarOpen(false)} />

        <nav className="shell-nav-core" aria-label="Core">
          {CORE_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `shell-nav-core-item${isActive ? " shell-nav-core-item-active" : ""}`}
              onClick={() => setSidebarOpen(false)}
            >
              <span className="shell-nav-core-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="shell-nav-divider" role="presentation">
          <span>More</span>
        </div>

        <nav className="shell-nav-more" aria-label="More sections">
          {MORE_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `shell-nav-item${isActive ? " shell-nav-item-active" : ""}`}
              onClick={() => setSidebarOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <p className="shell-workspace-id">
          workspace <code>{activeWorkspaceId}</code>
        </p>
      </aside>

      <main className="shell-main">
        <Outlet />
      </main>

      <button
        type="button"
        className="shell-sidebar-toggle"
        onClick={toggleSidebar}
        aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={sidebarOpen}
      >
        {sidebarOpen ? "✕" : "Menu"}
      </button>

      {sidebarOpen && (
        <div className="shell-sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}

      <button
        type="button"
        className="shell-chat-toggle"
        onClick={toggleChat}
        aria-label={chatOpen ? "Close agent chat" : "Open agent chat"}
        aria-expanded={chatOpen}
      >
        {chatOpen ? "✕" : "Agent"}
      </button>

      {chatOpen && (
        <div className="shell-chat-scrim" onClick={() => setChatOpen(false)} aria-hidden="true" />
      )}

      <aside className={`shell-chat${chatOpen ? " shell-chat-open" : ""}`} aria-label="Agent chat">
        {chat}
      </aside>
      </div>
    </div>
  )
}
