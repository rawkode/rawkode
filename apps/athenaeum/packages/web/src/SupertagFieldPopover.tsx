import { useEffect, useMemo, useRef, useState } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  AddFactInput,
  EntityId,
  ListNodesInput,
  ListTagFieldsInput,
  RunViewInput,
  TagFieldValueKind,
  UnassignTagInput,
  ViewSpec,
  type DomainError,
  type JsonValue,
  type ResolvedTagField
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"
import { AddTagFieldForm } from "./AddTagFieldForm.js"

// docs/supertag-centering-decisions.md §2, "Field-editing popover" — shown after inserting a
// `#tag` chip (`RichNoteEditor.tsx`'s `onSupertagApplied`) or on clicking an existing one
// (`NoteTags.tsx`). Reads/writes exactly the RPCs the decisions doc names, zero new backend
// surface: `listTagFields` for the resolved own+inherited field list, `runView("graph_facts", ...)`
// for current values, `addFact` to save (upsert-by-id when a fact already exists for this
// `(nodeId, predicateId)` pair), `defineTagField` for the "+ Add field" row.

export interface SupertagFieldPopoverTarget {
  readonly tagId: EntityId
  readonly name: string
}

/** `graph_facts`'s real columns (`read-model.ts`: `graph_facts AS SELECT id, nodeId, predicateId,
 *  value FROM rm_facts`) — same narrowing-cast convention `GraphView.tsx`'s `GraphNodeRow`/
 *  `NoteTags.tsx`'s `NodeTagRow` already establish for a `runView` row shape. `value` comes back
 *  as the raw TEXT `rm_facts.value` stores — `upsertFact`'s own `JSON.stringify(fact.value)` — NOT
 *  re-decoded by `runView` (an established convention: `workouts.test.ts`'s own "a caller must
 *  `JSON.parse` each value itself to recover its original type" note). `parsedValue` below is
 *  this component's one decode point. */
interface FactRow {
  readonly id: string
  readonly predicateId: string
  readonly value: string
}

interface ResolvedFact {
  readonly id: string
  readonly value: JsonValue
}

/** Defensive `JSON.parse` — a fact's stored `value` is trusted application data (unlike an
 *  Automerge mark payload), but a malformed row should degrade to "field reads as empty" rather
 *  than crash the whole popover. */
const parseFactValue = (raw: string): JsonValue => {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return null
  }
}

interface PopoverData {
  readonly fields: ReadonlyArray<ResolvedTagField>
  readonly factByPredicateId: ReadonlyMap<string, ResolvedFact>
}

const loadPopoverData = (
  client: WorkspaceRpcClientService,
  nodeId: EntityId,
  tagId: EntityId
): Effect.Effect<PopoverData, DomainError> =>
  Effect.gen(function* () {
    const { fields } = yield* client.listTagFields(new ListTagFieldsInput({ workspaceId, tagId }))
    const spec = new ViewSpec({
      filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: nodeId },
      view: "table",
      visibleColumns: ["id", "predicateId", "value"],
      rowLimit: 500
    })
    const { rows } = yield* client.runView(
      new RunViewInput({ workspaceId, viewName: "graph_facts", viewSpec: spec })
    )
    const factByPredicateId = new Map(
      (rows as ReadonlyArray<FactRow>).map((row) => [
        row.predicateId,
        { id: row.id, value: parseFactValue(row.value) }
      ])
    )
    return { fields, factByPredicateId }
  })

/** The one entity-ref-typed field control's candidate source (decisions doc §2: "a plain text
 *  input with a `<datalist>` of candidate titles sourced from the same `listNodes` RPC the mention
 *  picker's `listCandidates` already calls" — deliberately not the full mention-picker UX inside a
 *  popover). Loaded lazily, once, only if the tag actually has an entity-ref field. */
const loadNodeTitles = (
  client: WorkspaceRpcClientService
): Effect.Effect<ReadonlyArray<{ readonly id: string; readonly title: string }>, DomainError> =>
  client
    .listNodes(new ListNodesInput({ workspaceId }))
    .pipe(Effect.map((output) => output.nodes.map((node) => ({ id: node.id, title: node.title }))))

const valueToInputString = (value: unknown): string => {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return ""
}

const parseByValueKind = (valueKind: TagFieldValueKind, raw: string, checked: boolean): JsonValue => {
  switch (valueKind) {
    case "checkbox":
      return checked
    case "number": {
      const parsed = raw.trim() === "" ? null : Number(raw)
      return parsed === null || Number.isNaN(parsed) ? null : parsed
    }
    default:
      return raw
  }
}

export function SupertagFieldPopover({
  nodeId,
  tag,
  onClose,
  onSaved
}: {
  readonly nodeId: EntityId
  readonly tag: SupertagFieldPopoverTarget
  readonly onClose: () => void
  readonly onSaved: () => void
}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [savingFieldId, setSavingFieldId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Interaction pass (design-review 2026-08-22 finding #2 / flows F1.4+F1.5 — "silent data loss
  // in supertag fields"): fields now commit optimistically, matching the editor's own "type
  // first, sync later" discipline — Enter commits, blur commits, a checkbox commits on toggle,
  // and closing the popover (✕ or Escape, which now works) flushes any still-dirty field instead
  // of silently discarding it. The per-field explicit Save button is gone (it was the only
  // commit path, and gave no feedback); its grid slot now shows the visible save feedback the
  // review asked for ("Saving…" → "✓ Saved" flash). `committedByFieldId` is the dirty-check
  // baseline: the last value actually sent to `addFact` (seeded from the loaded facts), so a
  // blur-commit followed immediately by a close-flush never double-fires the same value — which
  // matters because a second `addFact` without a fact id (a brand-new fact whose created id
  // hasn't been reloaded yet) would insert a duplicate row rather than upsert.
  const [savedFieldId, setSavedFieldId] = useState<string | null>(null)
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const committedByFieldId = useRef<Record<string, string>>({})
  // Adversarial-review fix (docs/supertag-centering-decisions.md's "Known risks" — the tag
  // *assignment* itself, unlike a field value, is never a pending/agent-revertible row: `assignTag`
  // (mainline RPC) and `applySupertagTool` (agent path, see agent-edit-service-live.ts's own doc
  // comment on `applySupertagTool`) both write it immediately. An agent-applied `#Person` tag
  // inserts no chip into the note's text, so `RichNoteEditor`'s chip-diffing sync never sees it and
  // can never remove it — this button is the ONLY undo path such a tag has anywhere in the UI, and
  // it's real for every tag regardless of how it was applied (inline chip or agent tool), not a
  // special case). Calls the same already-real, already-idempotent `unassignTag` RPC the inline
  // chip-removal diffing itself uses (`supertag-plugin.ts`/`RichNoteEditor.tsx`).
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [checkedDrafts, setCheckedDrafts] = useState<Record<string, boolean>>({})
  const [nodeTitles, setNodeTitles] = useState<ReadonlyArray<{ readonly id: string; readonly title: string }>>([])

  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadPopoverData(client, nodeId, tag.tagId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, tag.tagId, refreshKey]
  )
  const state = useEffectQuery(effect, [nodeId, tag.tagId, refreshKey])

  // Seed per-field draft inputs from the freshly loaded facts whenever the underlying data
  // changes (a save, or the popover being opened for a different tag) — but never clobber
  // in-progress typing on an unrelated re-render, since this only re-runs when `state` itself
  // (a new load) changes.
  useEffect(() => {
    if (state.status !== "success") return
    const nextDrafts: Record<string, string> = {}
    const nextChecked: Record<string, boolean> = {}
    // Commit-on-blur means a reload lands after every field commit — if the user has already
    // tabbed into the NEXT field and is typing, reseeding that field's draft from the (older)
    // loaded facts would clobber their in-progress input. The currently focused field keeps its
    // draft; everything else reseeds from server truth as before.
    const activeElementId = document.activeElement instanceof HTMLElement ? document.activeElement.id : ""
    for (const resolved of state.value.fields) {
      const fieldId = resolved.field.id
      const fact = state.value.factByPredicateId.get(fieldId)
      const loadedRaw = valueToInputString(fact?.value)
      const loadedChecked = fact?.value === true
      const isFocused = activeElementId === `supertag-field-${fieldId}`
      nextDrafts[fieldId] = isFocused && drafts[fieldId] !== undefined ? drafts[fieldId] : loadedRaw
      nextChecked[fieldId] =
        isFocused && checkedDrafts[fieldId] !== undefined ? checkedDrafts[fieldId] : loadedChecked
      // The dirty-check baseline tracks what's committed server-side — but never regress it for a
      // field whose commit is still in flight (the reload that raced it may predate the write).
      if (committedByFieldId.current[fieldId] === undefined || savingFieldId !== fieldId) {
        committedByFieldId.current[fieldId] =
          resolved.field.valueKind === "checkbox" ? String(loadedChecked) : loadedRaw
      }
    }
    setDrafts(nextDrafts)
    setCheckedDrafts(nextChecked)

    if (state.value.fields.some((f) => f.field.valueKind === "entity-ref") && nodeTitles.length === 0) {
      const fiber = runtime.runFork(WorkspaceRpcClient.pipe(Effect.flatMap(loadNodeTitles)))
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) setNodeTitles(exit.value)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status === "success" ? state.value : undefined])

  /** Commits one field's current draft if (and only if) it differs from what was last committed —
   *  the single write path behind Enter, blur, checkbox toggle, and the close-flush. `overrides`
   *  carries a just-changed value that hasn't landed in React state yet (the checkbox's
   *  commit-on-toggle fires from the same event that sets the draft). */
  const commitField = (
    resolved: ResolvedTagField,
    overrides?: { readonly raw?: string; readonly checked?: boolean }
  ) => {
    const fieldId = resolved.field.id
    const raw = overrides?.raw ?? drafts[fieldId] ?? ""
    const checked = overrides?.checked ?? checkedDrafts[fieldId] ?? false
    const committedKey = resolved.field.valueKind === "checkbox" ? String(checked) : raw
    if (committedByFieldId.current[fieldId] === committedKey) return
    committedByFieldId.current[fieldId] = committedKey

    setSavingFieldId(fieldId)
    setSaveError(null)
    const existingFact = state.status === "success" ? state.value.factByPredicateId.get(fieldId) : undefined
    const value = parseByValueKind(resolved.field.valueKind, raw, checked)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.addFact(
            new AddFactInput({
              workspaceId,
              nodeId,
              predicateId: fieldId,
              value,
              id: existingFact ? (existingFact.id as EntityId) : undefined
            })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      setSavingFieldId(null)
      if (Exit.isSuccess(exit)) {
        // Visible save feedback (finding #2's "Save gives zero feedback"): a brief "✓ Saved"
        // flash in the field's status slot — deliberately a quiet inline state change, not a
        // toast layer.
        setSavedFieldId(fieldId)
        if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current)
        savedFlashTimer.current = setTimeout(() => setSavedFieldId((current) => (current === fieldId ? null : current)), 1600)
        setRefreshKey((k) => k + 1)
        onSaved()
      } else if (!Exit.isInterrupted(exit)) {
        // Roll the baseline back so the value still reads as dirty — a retry (Enter/blur/close)
        // re-fires the commit instead of the failure being treated as committed.
        delete committedByFieldId.current[fieldId]
        const failure = Cause.squash(exit.cause) as DomainError
        setSaveError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  /** Close = flush, never discard (finding #2's core repro: "type email, Enter, close, reopen —
   *  value must persist"). Any field whose draft differs from its committed baseline is committed
   *  on the way out — optimistic, consistent with every other mutation in this app — then the
   *  popover closes immediately; the fires are idempotent upserts and `onSaved` refreshes the
   *  parent chip row when each lands. */
  const handleClose = () => {
    if (state.status === "success") {
      for (const resolved of state.value.fields) commitField(resolved)
    }
    onClose()
  }

  // Escape closes the popover (finding #2 / flows F1.5 — "keyboard flow dies at the popover").
  // Document-level, so it works whether focus sits in a field input, on a button, or back in the
  // editor. `defaultPrevented` skips Escapes already consumed by someone closer (ProseMirror
  // `preventDefault`s the keydown when a picker plugin handles its own dismiss), so dismissing an
  // open `#`/`@` picker never also closes this popover.
  const latestHandleClose = useRef(handleClose)
  latestHandleClose.current = handleClose
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      latestHandleClose.current()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      if (savedFlashTimer.current) clearTimeout(savedFlashTimer.current)
    }
  }, [])

  const handleRemoveTag = () => {
    setRemoving(true)
    setRemoveError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.unassignTag(new UnassignTagInput({ workspaceId, nodeId, tagId: tag.tagId }))
        )
      )
    )
    fiber.addObserver((exit) => {
      setRemoving(false)
      if (Exit.isSuccess(exit)) {
        onSaved()
        onClose()
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setRemoveError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="supertag-popover" role="dialog" aria-label={`#${tag.name} fields`}>
      <header className="supertag-popover-header">
        <span className="supertag-chip">#{tag.name}</span>
        <button
          type="button"
          className="supertag-popover-remove"
          disabled={removing}
          onClick={handleRemoveTag}
          title="Remove this Supertag from the note (undoes any way it was applied, including by the agent)"
        >
          {removing ? "Removing…" : "Remove tag"}
        </button>
        <button type="button" className="supertag-popover-close" onClick={handleClose} aria-label="Close">
          ✕
        </button>
      </header>
      {removeError !== null && <p className="error supertag-popover-remove-error">{removeError}</p>}

      {state.status === "loading" && <p className="supertag-popover-loading">Loading fields…</p>}
      {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}

      {state.status === "success" && (
        <div className="supertag-popover-fields">
          {state.value.fields.length === 0 && <p className="supertag-popover-empty">No fields on this tag yet.</p>}
          {state.value.fields.map((resolved) => {
            const fieldId = resolved.field.id
            return (
              <div className="supertag-field-row" key={fieldId}>
                <label className="supertag-field-label" htmlFor={`supertag-field-${fieldId}`}>
                  {resolved.field.name}
                  {resolved.inherited && (
                    <span className="supertag-field-inherited"> · inherited</span>
                  )}
                </label>

                {resolved.field.valueKind === "checkbox" ? (
                  <input
                    id={`supertag-field-${fieldId}`}
                    type="checkbox"
                    checked={checkedDrafts[fieldId] ?? false}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setCheckedDrafts((prev) => ({ ...prev, [fieldId]: checked }))
                      // A toggle IS the edit — commit it immediately (finding #2's optimistic
                      // convention), passing the just-changed value since React state hasn't
                      // applied yet.
                      commitField(resolved, { checked })
                    }}
                  />
                ) : (
                  <input
                    id={`supertag-field-${fieldId}`}
                    type={
                      resolved.field.valueKind === "number"
                        ? "number"
                        : resolved.field.valueKind === "date"
                          ? "date"
                          : "text"
                    }
                    value={drafts[fieldId] ?? ""}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [fieldId]: event.target.value }))}
                    onBlur={() => commitField(resolved)}
                    onKeyDown={(event) => {
                      // Enter commits (finding #2's headline repro: "Enter in a field input does
                      // not save"). Escape is handled by the document-level close listener above.
                      if (event.key === "Enter") {
                        event.preventDefault()
                        commitField(resolved)
                      }
                    }}
                    list={resolved.field.valueKind === "entity-ref" ? `supertag-field-${fieldId}-list` : undefined}
                    placeholder={resolved.field.valueKind === "entity-ref" ? "Pick or type a node id" : undefined}
                  />
                )}
                {resolved.field.valueKind === "entity-ref" && (
                  <datalist id={`supertag-field-${fieldId}-list`}>
                    {nodeTitles.map((node) => (
                      <option key={node.id} value={node.id} label={node.title} />
                    ))}
                  </datalist>
                )}

                {/* The old per-field Save button's slot — now the save-feedback surface (fields
                    commit on Enter/blur/toggle; see `commitField`). `role="status"` announces the
                    flash to screen readers without stealing focus. */}
                <span className="supertag-field-status" role="status">
                  {savingFieldId === fieldId ? "Saving…" : savedFieldId === fieldId ? "✓ Saved" : ""}
                </span>
              </div>
            )
          })}
          {saveError !== null && <p className="error">{saveError}</p>}

          <AddTagFieldForm
            tagId={tag.tagId}
            nextSortOrder={state.value.fields.filter((f) => !f.inherited).length}
            onAdded={() => setRefreshKey((k) => k + 1)}
          />
        </div>
      )}
    </div>
  )
}
