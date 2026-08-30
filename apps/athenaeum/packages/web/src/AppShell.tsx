import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { NavLink, Outlet, useLocation } from "react-router"
import type { EntityId } from "@athenaeum/domain"
import type { DevSession } from "./dev-session.js"
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js"
import { CommandPalette } from "./CommandPalette.js"
import { parseDateStamp } from "./daily-note-id.js"
import { Drawer } from "./design-system/Drawer.js"
import { applyTheme, getInitialTheme, persistTheme, type AppTheme } from "./theme.js"

const CORE_NAV_ITEMS: ReadonlyArray<{ readonly to: string; readonly label: string; readonly icon: string }> = [
  { to: "/notes", label: "Today", icon: "☀" },
  { to: "/supertags", label: "Supertags", icon: "#" }
]

const BROWSE_NAV_ITEMS: ReadonlyArray<{ readonly to: string; readonly label: string }> = [
  { to: "/calendar", label: "Calendar" },
  { to: "/meetings", label: "Meetings" },
  { to: "/workouts", label: "Workouts" },
  { to: "/graph", label: "Graph" },
  { to: "/bookmarks", label: "Bookmarks" },
  { to: "/apps", label: "Apps" },
  { to: "/sharing", label: "Sharing" }
]

const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined
      const mediaQuery = window.matchMedia(query)
      const handleChange = () => onStoreChange()
      mediaQuery.addEventListener("change", handleChange)
      return () => mediaQuery.removeEventListener("change", handleChange)
    },
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    () => false
  )

const routeLabel = (pathname: string, search: string): string => {
  if (pathname.startsWith("/notes")) {
    // Match NotesRoute's valid-date fallback: a malformed date still resolves to Today, while a
    // valid date is a historical or explicitly selected daily note rather than the Today home.
    return parseDateStamp(new URLSearchParams(search).get("date") ?? "") === undefined ? "Today" : "Daily note"
  }
  if (pathname.startsWith("/supertags")) return "Supertags"
  if (pathname.startsWith("/node/")) return "Node"
  return BROWSE_NAV_ITEMS.find(({ to }) => pathname.startsWith(to))?.label ?? "Workspace"
}

const isEditableShortcutTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]') !== null

const isDailyNoteRecallShortcutTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-athenaeum-daily-note-editor="true"][contenteditable="true"]') !== null

const isMarkedDailyNoteEditorTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-athenaeum-daily-note-editor="true"]') !== null

const isBarePrimaryRecallShortcut = (event: globalThis.KeyboardEvent): boolean =>
  event.key.toLowerCase() === "k" &&
  event.metaKey !== event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey

type PaletteCloseReason = "dismiss" | "navigate"

type PaletteReturnTarget = {
  readonly element: HTMLElement
  readonly routeKey: string
}

const isLivePaletteReturnTarget = (
  target: PaletteReturnTarget | undefined,
  routeKey: string
): target is PaletteReturnTarget =>
  target !== undefined &&
  target.routeKey === routeKey &&
  target.element.isConnected &&
  target.element.getAttribute("contenteditable") === "true" &&
  target.element.matches('[data-athenaeum-daily-note-editor="true"]')

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
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [theme, setTheme] = useState<AppTheme>(() => getInitialTheme())
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browseDismissed, setBrowseDismissed] = useState(false)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const chatToggleRef = useRef<HTMLButtonElement>(null)
  const paletteToggleRef = useRef<HTMLButtonElement>(null)
  // The palette's restore target is mutable because the CommandPalette owns the close transition
  // and focuses it after React removes the dialog. It normally points at the global trigger, but
  // an editor-origin recall temporarily points at that exact live ProseMirror contenteditable.
  const paletteRestoreRef = useRef<HTMLElement | null>(null)
  const paletteReturnTargetRef = useRef<PaletteReturnTarget | undefined>(undefined)
  const mainContentRef = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const routeKey = `${location.pathname}${location.search}${location.hash}`
  const currentRouteLabel = routeLabel(location.pathname, location.search)
  const isDailyNoteRoute = location.pathname.startsWith("/notes")
  const announcedPathnameRef = useRef(location.pathname)
  const previousRouteKeyRef = useRef(routeKey)
  const [routeAnnouncement, setRouteAnnouncement] = useState("")
  const sidebarIsDrawer = useMediaQuery("(max-width: 58rem)")
  const chatIsDocked = useMediaQuery("(min-width: 78rem)")
  const activeBrowseRoute = BROWSE_NAV_ITEMS.some(({ to }) => location.pathname.startsWith(to))

  useEffect(() => {
    applyTheme(theme)
    persistTheme(theme)
  }, [theme])

  useEffect(() => {
    if (!activeBrowseRoute) {
      setBrowseDismissed(false)
      setBrowseOpen(false)
    } else if (!browseDismissed) {
      setBrowseOpen(true)
    }
  }, [activeBrowseRoute, browseDismissed])

  // The shell persists while only its outlet changes. Keep keyboard focus on the activating
  // control, but announce the completed destination once the new pathname has rendered.
  // Query-only changes (such as a selected daily-note date) intentionally remain silent.
  useEffect(() => {
    if (announcedPathnameRef.current === location.pathname) return
    announcedPathnameRef.current = location.pathname
    setRouteAnnouncement(`Opened ${currentRouteLabel}.`)
  }, [currentRouteLabel, location.pathname])

  const closeChat = () => setChatOpen(false)

  const closePalette = (reason: PaletteCloseReason = "dismiss") => {
    const returnTarget = paletteReturnTargetRef.current
    paletteRestoreRef.current = reason === "dismiss" && isLivePaletteReturnTarget(returnTarget, routeKey)
      ? returnTarget.element
      : paletteToggleRef.current
    paletteReturnTargetRef.current = undefined
    setPaletteOpen(false)
  }

  const closeSidebar = (restoreFocus = true) => {
    setSidebarOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => sidebarToggleRef.current?.focus())
  }

  const openChat = () => {
    setSidebarOpen(false)
    if (paletteOpen) closePalette("navigate")
    else paletteReturnTargetRef.current = undefined
    setChatOpen(true)
  }

  const openPalette = () => {
    setSidebarOpen(false)
    setChatOpen(false)
    paletteReturnTargetRef.current = undefined
    paletteRestoreRef.current = paletteToggleRef.current
    setPaletteOpen(true)
  }

  // Recall from active daily-note prose is intentionally non-disruptive: it must not close an
  // already-open agent/sidebar surface or discard the user's in-progress work behind the palette.
  const openPaletteFromDailyNote = (target: EventTarget | null) => {
    const editor = target instanceof Element
      ? target.closest<HTMLElement>('[data-athenaeum-daily-note-editor="true"][contenteditable="true"]')
      : null
    if (editor === null) return
    paletteReturnTargetRef.current = { element: editor, routeKey }
    paletteRestoreRef.current = editor
    setPaletteOpen(true)
  }

  // Keep the advertised Cmd/Ctrl+K behavior useful from either state. Opening the palette
  // still clears competing drawers; invoking the same shortcut again returns to the work
  // surface instead of leaving a no-op command behind a modal dialog.
  const togglePalette = () => {
    if (paletteOpen) closePalette("dismiss")
    else openPalette()
  }

  const toggleSidebar = () => {
    closeChat()
    setSidebarOpen((open) => !open)
  }

  const toggleChat = () => {
    if (chatOpen) closeChat()
    else openChat()
  }

  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return
    previousRouteKeyRef.current = routeKey
    // Query changes are meaningful here: a replaced daily-note editor must never receive focus
    // from a palette opened by the previous note, even when the shell itself remains mounted.
    paletteReturnTargetRef.current = undefined
    paletteRestoreRef.current = paletteToggleRef.current
  }, [routeKey])

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const shortcutKey = event.key.toLowerCase()
      const isModifierShortcut = event.metaKey || event.ctrlKey
      const isDailyNoteRecall = isBarePrimaryRecallShortcut(event) && isDailyNoteRecallShortcutTarget(event.target)
      // Daily-note and chat writing surfaces own their editing shortcuts. The palette keeps its
      // advertised Cmd/Ctrl+K toggle while its own search field is focused.
      if (
        isModifierShortcut &&
        (isMarkedDailyNoteEditorTarget(event.target) || isEditableShortcutTarget(event.target)) &&
        !isDailyNoteRecall &&
        !(paletteOpen && shortcutKey === "k")
      ) return

      if (isModifierShortcut && shortcutKey === "j") {
        event.preventDefault()
        toggleChat()
      } else if (isDailyNoteRecall) {
        event.preventDefault()
        openPaletteFromDailyNote(event.target)
      } else if (isBarePrimaryRecallShortcut(event)) {
        event.preventDefault()
        togglePalette()
      } else if (event.key === "Escape" && paletteOpen) {
        event.preventDefault()
        closePalette()
      } else if (event.key === "Escape" && sidebarIsDrawer && sidebarOpen) {
        event.preventDefault()
        closeSidebar()
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [chatOpen, paletteOpen, routeKey, sidebarIsDrawer, sidebarOpen])

  return (
    <div className="shell-container">
      <a
        className="shell-skip-link"
        href="#athenaeum-main-content"
        onClick={() => mainContentRef.current?.focus()}
      >
        Skip to workspace content
      </a>
      <div className={`shell${chatOpen ? " shell-chat-visible" : ""}`}>
        <Drawer
          open={sidebarIsDrawer ? sidebarOpen : true}
          mode={sidebarIsDrawer ? "overlay" : "docked"}
          id="athenaeum-workspace-navigation"
          label="Workspace navigation"
          closeLabel={sidebarIsDrawer ? "Close navigation" : undefined}
          dismissible={sidebarIsDrawer}
          restoreFocusRef={sidebarToggleRef}
          restoreFocusOnClose={false}
          onClose={closeSidebar}
          className="shell-sidebar"
        >
          <div className="shell-brand">
            <span className="shell-brand-mark" aria-hidden="true">
              ⌗
            </span>
            <span className="shell-brand-name">Athenaeum</span>
          </div>

          <div className="shell-workspace-control">
            <WorkspaceSwitcher
              session={session}
              activeWorkspaceId={activeWorkspaceId}
              onSwitch={onSwitchWorkspace}
              variant="sidebar-compact"
            />
          </div>

          <nav className="shell-nav-core" aria-label="Core">
            {CORE_NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `shell-nav-core-item${isActive ? " shell-nav-core-item-active" : ""}`}
                onClick={() => closeSidebar(false)}
              >
                <span className="shell-nav-core-icon" aria-hidden="true">
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <details
            className="ds-disclosure shell-nav-disclosure"
            open={browseOpen}
            onToggle={(event) => {
              const open = event.currentTarget.open
              setBrowseOpen(open)
              if (!open && activeBrowseRoute) setBrowseDismissed(true)
            }}
          >
            <summary>
              <span>Browse</span>
              <span className="shell-nav-disclosure-meta">{BROWSE_NAV_ITEMS.length} tools</span>
            </summary>
            <nav className="shell-nav-more" aria-label="Browse sections">
              {BROWSE_NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `shell-nav-item${isActive ? " shell-nav-item-active" : ""}`}
                  onClick={() => closeSidebar(false)}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </details>

          <details className="ds-disclosure shell-account-menu">
            <summary className="shell-account">
              <span className="shell-account-avatar" aria-hidden="true">
                {session.email.slice(0, 1).toUpperCase()}
              </span>
              <span className="shell-account-email" title={session.email}>
                {session.email}
              </span>
              <span className="shell-account-badge">dev</span>
            </summary>
            <div className="shell-account-actions">
              <button
                type="button"
                className="ds-button ds-button--quiet shell-theme-toggle"
                aria-pressed={theme === "paper"}
                aria-label={theme === "paper" ? "Switch to dark command-center theme" : "Switch to paper writing theme"}
                onClick={() => setTheme((current) => (current === "paper" ? "dark" : "paper"))}
              >
                <span className="shell-theme-icon" aria-hidden="true">{theme === "paper" ? "◐" : "☼"}</span>
                <span>{theme === "paper" ? "Paper" : "Dark"}</span>
              </button>
              <button type="button" className="ds-button ds-button--quiet shell-sign-out" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </details>
        </Drawer>

        <main className="shell-main">
          <header className={`shell-mainbar${isDailyNoteRoute ? " shell-mainbar-daily-note" : ""}`}>
            <div className={`shell-mainbar-location${isDailyNoteRoute ? " sr-only" : ""}`}>
              <span className="shell-mainbar-kicker">Athenaeum</span>
              <span className="shell-mainbar-title">{currentRouteLabel}</span>
            </div>
            <div className="shell-mainbar-actions">
              <button
                ref={paletteToggleRef}
                type="button"
                className="ds-button shell-search-toggle"
                onClick={openPalette}
                aria-label="Open command palette"
                aria-haspopup="dialog"
                aria-expanded={paletteOpen}
              >
                <span aria-hidden="true">⌕</span>
                <span className="shell-search-toggle-label">Search</span>
                <kbd>⌘K / Ctrl K</kbd>
              </button>
              <button
                type="button"
                className="ds-button shell-sidebar-toggle"
                ref={sidebarToggleRef}
                onClick={toggleSidebar}
                aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
                aria-expanded={sidebarOpen}
                aria-controls="athenaeum-workspace-navigation"
              >
                {sidebarOpen ? "Close" : "Menu"}
              </button>
              <button
                ref={chatToggleRef}
                type="button"
                className="ds-button shell-chat-toggle"
                onClick={toggleChat}
                aria-label={chatOpen ? "Close agent chat" : "Open agent chat and review assistant activity"}
                aria-describedby="athenaeum-agent-chat-description"
                aria-expanded={chatOpen}
                aria-controls="athenaeum-agent-chat"
              >
                <span aria-hidden="true">✦</span>
                <span className="shell-chat-label">{chatOpen ? "Close agent" : "Open agent"}</span>
                <kbd>⌘J / Ctrl J</kbd>
                <span className="shell-chat-attention" aria-hidden="true">
                  ●
                </span>
                <span id="athenaeum-agent-chat-description" className="sr-only">
                  Review pending assistant changes and errors.
                </span>
              </button>
            </div>
          </header>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {routeAnnouncement}
          </p>
          <div id="athenaeum-main-content" ref={mainContentRef} tabIndex={-1} className="shell-main-content">
            <Outlet />
          </div>
        </main>

        <Drawer
          open={chatOpen}
          mode={chatIsDocked ? "docked" : "overlay"}
          id="athenaeum-agent-chat"
          label="Agent chat"
          closeLabel="Close agent chat"
          restoreFocusRef={chatToggleRef}
          onClose={closeChat}
          className="shell-chat"
        >
          {chat}
        </Drawer>

        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          restoreFocusRef={paletteRestoreRef}
          onNavigated={() => closeSidebar(false)}
        />
      </div>
    </div>
  )
}
