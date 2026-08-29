import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { useNavigate } from "react-router"
import type { SearchResultEntry } from "@athenaeum/domain"
import { searchResultDestination, useNodeSearch } from "./SearchBox.js"

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

export type PaletteCommand = {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly to: string
  readonly icon: string
}

export const PALETTE_COMMANDS: ReadonlyArray<PaletteCommand> = [
  { id: "today", label: "Today", hint: "Open your daily note", to: "/notes", icon: "☀" },
  { id: "supertags", label: "Supertags", hint: "Shape your typed schema", to: "/supertags", icon: "#" },
  { id: "calendar", label: "Calendar", hint: "Review connected events", to: "/calendar", icon: "◷" },
  { id: "meetings", label: "Meetings", hint: "Review transcripts and people", to: "/meetings", icon: "◌" },
  { id: "workouts", label: "Workouts", hint: "Review imported health data", to: "/workouts", icon: "⌁" },
  { id: "graph", label: "Graph", hint: "Inspect connected entities", to: "/graph", icon: "⊙" },
  { id: "bookmarks", label: "Bookmarks", hint: "Return to captured references", to: "/bookmarks", icon: "⌑" },
  { id: "sharing", label: "Sharing", hint: "Manage workspace access", to: "/sharing", icon: "⇄" },
  { id: "apps", label: "Apps", hint: "Open your workspace gadgets", to: "/apps", icon: "✦" }
]

export type PaletteEntry =
  | { readonly kind: "command"; readonly command: PaletteCommand }
  | { readonly kind: "result"; readonly result: SearchResultEntry }

export const paletteEntriesFor = (
  query: string,
  results: ReadonlyArray<SearchResultEntry>
): ReadonlyArray<PaletteEntry> => {
  const normalized = query.trim().toLocaleLowerCase()
  const commands = PALETTE_COMMANDS
    .filter((command) => normalized.length === 0 || `${command.label} ${command.hint}`.toLocaleLowerCase().includes(normalized))
    .map((command) => ({ kind: "command" as const, command }))
  if (normalized.length === 0) return commands
  return [...commands, ...results.map((result) => ({ kind: "result" as const, result }))]
}

export function CommandPalette({
  open,
  onClose,
  restoreFocusRef,
  onNavigated
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly restoreFocusRef?: RefObject<HTMLElement | null>
  readonly onNavigated?: () => void
}) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const wasOpenRef = useRef(open)
  const [query, setQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { isCurrent, state, retry, isRetrying } = useNodeSearch(query, open)
  // `useNodeSearch` retains the previous state during its debounce. Do not let Arrow/Enter select
  // those result rows for a newer visible query; commands remain immediately available.
  const results = isCurrent && state.status === "success" ? state.value.results : []
  const entries = useMemo(() => paletteEntriesFor(query, results), [query, results])
  const hasOptions = entries.length > 0
  const searchPending = query.trim().length > 0 && (!isCurrent || state.status === "loading")

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setQuery("")
      setSelectedIndex(0)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    } else if (!open && wasOpenRef.current) {
      restoreFocusRef?.current?.focus()
    }
    wasOpenRef.current = open
  }, [open, restoreFocusRef])

  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, Math.max(entries.length - 1, 0)))
  }, [entries.length])

  if (!open) return null

  const navigateEntry = (entry: PaletteEntry) => {
    navigate(entry.kind === "command" ? entry.command.to : searchResultDestination(entry.result.nodeId))
    onClose()
    onNavigated?.()
  }

  const selectCurrent = () => {
    const entry = entries[selectedIndex]
    if (entry !== undefined) navigateEntry(entry)
  }

  const activeId = hasOptions ? `command-palette-option-${selectedIndex}` : undefined

  const renderEntry = (entry: PaletteEntry, index: number) => {
    const label = entry.kind === "command" ? entry.command.label : entry.result.title
    const hint = entry.kind === "command" ? entry.command.hint : entry.result.snippet
    return (
      <button
        key={entry.kind === "command" ? entry.command.id : entry.result.nodeId}
        id={`command-palette-option-${index}`}
        type="button"
        role="option"
        aria-selected={selectedIndex === index}
        className={`command-palette-option${selectedIndex === index ? " command-palette-option-selected" : ""}`}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => navigateEntry(entry)}
      >
        <span className="command-palette-option-icon" aria-hidden="true">
          {entry.kind === "command" ? entry.command.icon : "⌕"}
        </span>
        <span className="command-palette-option-copy">
          <span className="command-palette-option-label">{label}</span>
          {hint.length > 0 && <span className="command-palette-option-hint">{hint}</span>}
        </span>
        {entry.kind === "result" && <span className="command-palette-option-kind">note</span>}
      </button>
    )
  }

  const commandEntries = entries.flatMap((entry, index) => entry.kind === "command" ? [{ entry, index }] : [])
  const noteEntries = entries.flatMap((entry, index) => entry.kind === "result" ? [{ entry, index }] : [])

  const focusableControls = (): HTMLElement[] =>
    Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== "Tab") return

    const controls = focusableControls()
    const first = controls.at(0)
    const last = controls.at(-1)
    if (first === undefined || last === undefined) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="command-palette-heading">
          <div>
            <span className="section-kicker">Navigate</span>
            <h2 id="command-palette-title">Command palette</h2>
          </div>
          <kbd>Esc</kbd>
        </div>
        <input
          ref={inputRef}
          className="ds-field command-palette-input"
          type="search"
          value={query}
          placeholder="Search notes, people, projects…"
          aria-label="Search notes, people, and projects"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={hasOptions}
          aria-controls="command-palette-options"
          aria-activedescendant={activeId}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setSelectedIndex((index) => entries.length === 0 ? 0 : (index + 1) % entries.length)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              setSelectedIndex((index) => entries.length === 0 ? 0 : (index - 1 + entries.length) % entries.length)
            } else if (event.key === "Enter") {
              event.preventDefault()
              selectCurrent()
            }
          }}
        />

        {searchPending && (
          <p className="command-palette-state" role="status" aria-live="polite" aria-atomic="true">
            Searching…
          </p>
        )}
        {isCurrent && state.status === "failure" && (
          <div className="command-palette-state command-palette-error command-palette-search-failure" role="alert">
            <span>Search couldn’t be completed.</span>
            <button type="button" onClick={retry} disabled={isRetrying}>{isRetrying ? "Retrying…" : "Retry"}</button>
          </div>
        )}
        {isCurrent && state.status === "success" && entries.length === 0 && (
          <p className="command-palette-state" role="status" aria-live="polite" aria-atomic="true">
            No matching notes or destinations.
          </p>
        )}
        {hasOptions && (
          <div
            id="command-palette-options"
            className="command-palette-options"
            role="listbox"
            aria-label="Destinations and notes"
          >
            {commandEntries.length > 0 && (
              <div className="command-palette-group" role="group" aria-label="Destinations">
                <div className="command-palette-group-label" aria-hidden="true">Destinations</div>
                {commandEntries.map(({ entry, index }) => renderEntry(entry, index))}
              </div>
            )}
            {noteEntries.length > 0 && (
              <div className="command-palette-group" role="group" aria-label="Notes">
                <div className="command-palette-group-label" aria-hidden="true">Notes</div>
                {noteEntries.map(({ entry, index }) => renderEntry(entry, index))}
              </div>
            )}
          </div>
        )}
        <div className="command-palette-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>⌘K / Ctrl K</kbd> toggle</span>
        </div>
      </section>
    </div>
  )
}
