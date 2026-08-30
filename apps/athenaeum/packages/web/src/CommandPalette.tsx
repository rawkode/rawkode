import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { useNavigate } from "react-router"
import type { SearchResultEntry } from "@athenaeum/domain"
import { searchResultDestination, useNodeSearch } from "./SearchBox.js"
import { dateStampFromDailyNoteId, localDateStamp, parseDateStamp, shiftDateStamp } from "./daily-note-id.js"

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

export type PaletteCommand = {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly to: string
  readonly icon: string
}

export type DailyNotePaletteCommand = PaletteCommand & {
  readonly dateStamp: string
}

export const PALETTE_COMMANDS: ReadonlyArray<PaletteCommand> = [
  { id: "today", label: "Today", hint: "Open or create your daily note", to: "/notes", icon: "☀" },
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
  | { readonly kind: "daily-note"; readonly command: DailyNotePaletteCommand }
  | { readonly kind: "command"; readonly command: PaletteCommand }
  | { readonly kind: "result"; readonly result: SearchResultEntry }

const formatDailyNoteDate = (stamp: string): string => {
  const date = parseDateStamp(stamp)
  if (date === undefined) return stamp
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(date)
}

const dailyNoteRoute = (dateStamp: string, referenceDate: Date): string =>
  dateStamp === localDateStamp(referenceDate) ? "/notes" : `/notes?date=${dateStamp}`

const dailyNoteCommand = (
  dateStamp: string,
  referenceDate: Date,
  label: string,
  icon: string
): DailyNotePaletteCommand => ({
  id: `daily-note-${dateStamp}`,
  label: `${label} · ${formatDailyNoteDate(dateStamp)}`,
  hint: "Open or create this daily note",
  to: dailyNoteRoute(dateStamp, referenceDate),
  icon,
  dateStamp
})

/** Resolves only exact, deliberate date commands; ordinary prose remains search input. */
export const dailyNoteCommandForQuery = (
  query: string,
  referenceDate: Date = new Date()
): DailyNotePaletteCommand | undefined => {
  const normalized = query.trim().toLowerCase()
  const todayStamp = localDateStamp(referenceDate)
  if (normalized === "today") return dailyNoteCommand(todayStamp, referenceDate, "Today", "☀")
  if (normalized === "yesterday") {
    return dailyNoteCommand(shiftDateStamp(todayStamp, -1), referenceDate, "Yesterday", "↶")
  }
  if (normalized === "tomorrow") {
    return dailyNoteCommand(shiftDateStamp(todayStamp, 1), referenceDate, "Tomorrow", "↷")
  }
  const date = parseDateStamp(normalized)
  if (date === undefined) return undefined
  const dateStamp = localDateStamp(date)
  return dailyNoteCommand(dateStamp, referenceDate, "Daily note", "◷")
}

export const paletteEntriesFor = (
  query: string,
  results: ReadonlyArray<SearchResultEntry>,
  referenceDate: Date = new Date()
): ReadonlyArray<PaletteEntry> => {
  const normalized = query.trim().toLowerCase()
  const dateCommand = dailyNoteCommandForQuery(query, referenceDate)
  const commands = PALETTE_COMMANDS
    .filter((command) => normalized.length === 0 || `${command.label} ${command.hint}`.toLowerCase().includes(normalized))
    .map((command) => ({ kind: "command" as const, command }))
  if (normalized.length === 0) return commands
  if (dateCommand !== undefined) {
    // The generated Today action replaces the static Today destination for an exact `today`
    // query, avoiding two indistinguishable routes while keeping ordinary recall intact.
    const destinations = commands.filter((entry) => !(normalized === "today" && entry.command.id === "today"))
    return [
      { kind: "daily-note" as const, command: dateCommand },
      ...results.map((result) => ({ kind: "result" as const, result })),
      ...destinations
    ]
  }
  // Retrieval is the primary purpose of the palette: show recalled records before navigation
  // destinations, while keeping matching destinations available as a deliberate fallback.
  return [...results.map((result) => ({ kind: "result" as const, result })), ...commands]
}

/** A result's kind is derived from its stable id, never guessed from an arbitrary title. */
export const paletteResultKind = (result: SearchResultEntry): string => {
  const dateStamp = dateStampFromDailyNoteId(result.nodeId)
  return dateStamp === undefined ? "Record" : `Daily note · ${formatDailyNoteDate(dateStamp)}`
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
    navigate(entry.kind === "result" ? searchResultDestination(entry.result.nodeId) : entry.command.to)
    onClose()
    onNavigated?.()
  }

  const selectCurrent = () => {
    const entry = entries[selectedIndex]
    if (entry !== undefined) navigateEntry(entry)
  }

  const activeId = hasOptions ? `command-palette-option-${selectedIndex}` : undefined

  const renderEntry = (entry: PaletteEntry, index: number) => {
    const label = entry.kind === "result" ? entry.result.title : entry.command.label
    const hint = entry.kind === "result" ? entry.result.snippet : entry.command.hint
    return (
      <button
        key={entry.kind === "result" ? entry.result.nodeId : entry.command.id}
        id={`command-palette-option-${index}`}
        type="button"
        role="option"
        aria-selected={selectedIndex === index}
        className={`command-palette-option${selectedIndex === index ? " command-palette-option-selected" : ""}`}
        onMouseEnter={() => setSelectedIndex(index)}
        onClick={() => navigateEntry(entry)}
      >
        <span className="command-palette-option-icon" aria-hidden="true">
          {entry.kind === "result" ? "⌕" : entry.command.icon}
        </span>
        <span className="command-palette-option-copy">
          <span className="command-palette-option-label">{label}</span>
          {hint.length > 0 && <span className="command-palette-option-hint">{hint}</span>}
        </span>
        {entry.kind === "result" && <span className="command-palette-option-kind">{paletteResultKind(entry.result)}</span>}
      </button>
    )
  }

  const dailyNoteEntries = entries.flatMap((entry, index) => entry.kind === "daily-note" ? [{ entry, index }] : [])
  const recallEntries = entries.flatMap((entry, index) => entry.kind === "result" ? [{ entry, index }] : [])
  const destinationEntries = entries.flatMap((entry, index) => entry.kind === "command" ? [{ entry, index }] : [])
  const listboxLabel = [
    dailyNoteEntries.length > 0 ? "Daily notes" : undefined,
    recallEntries.length > 0 ? "recall" : undefined,
    destinationEntries.length > 0 ? "destinations" : undefined
  ].filter((label): label is string => label !== undefined).join(", ")

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
            aria-label={listboxLabel}
          >
            {dailyNoteEntries.length > 0 && (
              <div className="command-palette-group" role="group" aria-label="Daily notes">
                <div className="command-palette-group-label" aria-hidden="true">Daily notes</div>
                {dailyNoteEntries.map(({ entry, index }) => renderEntry(entry, index))}
              </div>
            )}
            {recallEntries.length > 0 && (
              <div className="command-palette-group" role="group" aria-label="Recall">
                <div className="command-palette-group-label" aria-hidden="true">Recall</div>
                {recallEntries.map(({ entry, index }) => renderEntry(entry, index))}
              </div>
            )}
            {destinationEntries.length > 0 && (
              <div className="command-palette-group" role="group" aria-label="Destinations">
                <div className="command-palette-group-label" aria-hidden="true">Destinations</div>
                {destinationEntries.map(({ entry, index }) => renderEntry(entry, index))}
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
