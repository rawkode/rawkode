import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import {
  AddFactInput,
  EntityId,
  HumanUiMutationAttribution,
  ListNodesInput,
  ListTagFieldsInput,
  RunViewInput,
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
import { calculateFloatingPopoverPosition } from "./floating-popover-position.js"
import { AddTagFieldForm } from "./AddTagFieldForm.js"
import {
  FieldCommitCoordinator,
  fieldDraftValue,
  type FieldDraft
} from "./supertag-field-commit-coordinator.js"
import type { SupertagFieldPopoverTarget } from "./SupertagFieldPopover.js"

interface FactRow {
  readonly id: string
  readonly predicateId: string
  readonly value: string
}

interface ResolvedFact {
  readonly id: string
  readonly value: JsonValue
}

interface PopoverData {
  readonly fields: ReadonlyArray<ResolvedTagField>
  readonly factByPredicateId: ReadonlyMap<string, ResolvedFact>
}

const parseFactValue = (raw: string): JsonValue => {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return null
  }
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

const fieldSaveFailureMessage =
  "We couldn’t confirm that this field was saved. Your draft is still here. Retry to continue."

const tagRemovalFailureMessage =
  "We couldn’t confirm that this tag was removed. Review the note before trying again."

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
  const [retryClaimed, setRetryClaimed] = useState(false)
  const [coordinatorVersion, setCoordinatorVersion] = useState(0)
  const [loadedData, setLoadedData] = useState<PopoverData | undefined>(undefined)
  const [nodeTitles, setNodeTitles] = useState<ReadonlyArray<{ readonly id: string; readonly title: string }>>([])
  const [savedFieldId, setSavedFieldId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [position, setPosition] = useState<ReturnType<typeof calculateFloatingPopoverPosition> | undefined>(undefined)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const savedFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeCompletionAttached = useRef(false)
  const retryClaim = useRef<{ nodeId: EntityId; tagId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const onCloseRef = useRef(onClose)
  const onSavedRef = useRef(onSaved)
  onCloseRef.current = onClose
  onSavedRef.current = onSaved

  const coordinator = useMemo(
    () =>
      new FieldCommitCoordinator<AddFactInput>({
        makeRequest: ({ fieldId, valueKind, draft, factId, requestId }) =>
          new AddFactInput({
            workspaceId,
            nodeId,
            predicateId: fieldId,
            value: fieldDraftValue(valueKind, draft),
            requestId,
            commitMessage: "Update the " + fieldId + " field on the #" + tag.name + " note.",
            attribution: new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "web-supertag-field-editor"
            }),
            ...(factId === undefined ? {} : { id: factId })
          }),
        submit: async (request) => {
          const output = await runtime.runPromise(
            WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.addFact(request)))
          )
          return { factId: output.fact.id }
        },
        onAccepted: (fieldId) => {
          setSavedFieldId(fieldId)
          if (savedFlashTimer.current !== undefined) clearTimeout(savedFlashTimer.current)
          savedFlashTimer.current = setTimeout(() => {
            setSavedFieldId((current) => (current === fieldId ? null : current))
          }, 1600)
          onSavedRef.current()
        }
      }),
    [nodeId, tag.tagId]
  )

  useEffect(
    () => coordinator.subscribe(() => setCoordinatorVersion((version) => version + 1)),
    [coordinator]
  )

  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadPopoverData(client, nodeId, tag.tagId))),
    [nodeId, tag.tagId, refreshKey]
  )
  const state = useEffectQuery(effect, [nodeId, tag.tagId, refreshKey])

  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.nodeId !== nodeId || claim.tagId !== tag.tagId) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render initially retains the preceding failure. Keep the presentation
    // claim until this node/tag field read visibly loads and then reaches its terminal state.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [nodeId, state.status, tag.tagId])

  const retryFields = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { nodeId, tagId: tag.tagId, sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [nodeId, state.status, tag.tagId])

  const isRetryingFields = retryClaimed || state.status === "loading"

  useEffect(() => {
    if (state.status !== "success") return
    setLoadedData(state.value)
    coordinator.setFields(
      state.value.fields.map((resolved) => {
        const fact = state.value.factByPredicateId.get(resolved.field.id)
        return {
          fieldId: resolved.field.id,
          valueKind: resolved.field.valueKind,
          accepted: {
            raw: valueToInputString(fact?.value),
            checked: fact?.value === true
          },
          ...(fact === undefined ? {} : { factId: fact.id as EntityId })
        }
      })
    )
  }, [coordinator, state.status === "success" ? state.value : undefined])

  const data = state.status === "success" ? state.value : loadedData
  const controlsFrozen = coordinator.isFrozen()
  const removing = coordinator.isRemoving()
  const closing = coordinator.isClosing()

  useLayoutEffect(() => {
    const readAnchorRect = () => tag.anchorRectSource?.() ?? tag.anchorRect
    if (readAnchorRect() === undefined) {
      setPosition(undefined)
      return
    }

    const element = popoverRef.current
    if (element === null) return
    const updatePosition = () => {
      const anchorRect = readAnchorRect()
      if (anchorRect === undefined) {
        setPosition(undefined)
        return
      }
      const rect = element.getBoundingClientRect()
      setPosition(
        calculateFloatingPopoverPosition(
          anchorRect,
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updatePosition)
    observer?.observe(element)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
      observer?.disconnect()
    }
  }, [tag.anchorRect, tag.anchorRectSource, data?.fields.length, closing, removing])

  useEffect(() => {
    if (data === undefined || !data.fields.some((field) => field.field.valueKind === "entity-ref")) return
    let active = true
    void runtime.runPromise(WorkspaceRpcClient.pipe(Effect.flatMap(loadNodeTitles))).then(
      (output) => {
        if (active) setNodeTitles(output)
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [data])

  const snapshotsByField = useMemo(
    () => new Map(coordinator.snapshots().map((snapshot) => [snapshot.fieldId, snapshot])),
    [coordinator, coordinatorVersion]
  )

  const handleClose = () => {
    if (closeCompletionAttached.current) return
    closeCompletionAttached.current = true
    void coordinator.requestClose().then((closed) => {
      if (closed) {
        onCloseRef.current()
      } else {
        closeCompletionAttached.current = false
      }
    })
  }
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
      if (savedFlashTimer.current !== undefined) clearTimeout(savedFlashTimer.current)
    }
  }, [])

  const handleRemoveTag = () => {
    if (coordinator.isFrozen()) return
    setRemoveError(null)
    void coordinator
      .requestRemoval(async () => {
        await runtime.runPromise(
          WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.unassignTag(
                new UnassignTagInput({
                  workspaceId,
                  nodeId,
                  tagId: tag.tagId,
                  requestId: crypto.randomUUID(),
                  commitMessage: "Remove the #" + tag.name + " membership from this note.",
                  attribution: new HumanUiMutationAttribution({
                    version: "athenaeum.mutation-attribution.v1",
                    kind: "humanUi",
                    surface: "web-supertag-field-editor"
                  })
                })
              )
            )
          )
        )
      })
      .then((removed) => {
        if (removed) {
          onSavedRef.current()
          onCloseRef.current()
        } else {
          setRemoveError("A field save failed. Retry it before removing this tag.")
        }
      })
      .catch((error) => {
        setRemoveError(tagRemovalFailureMessage)
        console.error(error)
      })
  }

  return (
    <div
      ref={popoverRef}
      className="supertag-popover"
      data-placement={position?.placement}
      style={position === undefined ? undefined : {
        top: position.top,
        left: position.left,
        right: "auto",
        bottom: "auto"
      }}
      role="dialog"
      aria-label={"#" + tag.name + " fields"}
    >
      <header className="supertag-popover-header">
        <span className="supertag-chip">#{tag.name}</span>
        <button
          type="button"
          className="supertag-popover-remove"
          disabled={controlsFrozen}
          onClick={handleRemoveTag}
          title="Remove this Supertag from the note"
        >
          {removing ? "Removing…" : "Remove tag"}
        </button>
        <button
          type="button"
          className="supertag-popover-close"
          disabled={controlsFrozen}
          onClick={handleClose}
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      {removeError !== null && (
        <p className="error supertag-popover-remove-error" role="alert">
          {removeError}
        </p>
      )}
      {state.status === "failure" && (
        <section className="supertag-popover-load-state" role="alert" aria-label="Tag fields are unavailable">
          <p>
            {data === undefined
              ? "Fields couldn’t be loaded. Retry to continue editing this tag."
              : "Fields couldn’t be refreshed. Your existing fields and drafts remain available."}
          </p>
          <button type="button" onClick={retryFields} disabled={isRetryingFields}>
            {isRetryingFields ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {state.status === "loading" && data === undefined && (
        <p className="supertag-popover-loading" role="status" aria-live="polite" aria-atomic="true">
          Loading fields…
        </p>
      )}
      {state.status === "loading" && data !== undefined && (
        <p className="supertag-popover-loading" role="status" aria-live="polite" aria-atomic="true">
          Refreshing fields…
        </p>
      )}

      {data !== undefined && (
        <div className="supertag-popover-fields">
          {data.fields.length === 0 && <p className="supertag-popover-empty">No fields on this tag yet.</p>}
          {data.fields.map((resolved) => {
            const fieldId = resolved.field.id
            const fact = data.factByPredicateId.get(fieldId)
            const snapshot = snapshotsByField.get(fieldId)
            const fallbackDraft: FieldDraft = {
              raw: valueToInputString(fact?.value),
              checked: fact?.value === true
            }
            const draft = snapshot?.draft ?? fallbackDraft
            const fieldError = snapshot?.phase === "failed" ? snapshot.error : undefined
            return (
              <div className="supertag-field-row" key={fieldId}>
                <label className="supertag-field-label" htmlFor={"supertag-field-" + fieldId}>
                  {resolved.field.name}
                  {resolved.inherited && <span className="supertag-field-inherited"> · inherited</span>}
                </label>

                {resolved.field.valueKind === "checkbox" ? (
                  <input
                    id={"supertag-field-" + fieldId}
                    type="checkbox"
                    checked={draft.checked}
                    disabled={controlsFrozen}
                    onChange={(event) => {
                      coordinator.updateDraft(fieldId, { raw: draft.raw, checked: event.target.checked })
                      coordinator.commit(fieldId)
                    }}
                  />
                ) : (
                  <input
                    id={"supertag-field-" + fieldId}
                    type={
                      resolved.field.valueKind === "number"
                        ? "number"
                        : resolved.field.valueKind === "date"
                          ? "date"
                          : "text"
                    }
                    value={draft.raw}
                    disabled={controlsFrozen}
                    onChange={(event) =>
                      coordinator.updateDraft(fieldId, { raw: event.target.value, checked: draft.checked })
                    }
                    onBlur={() => coordinator.commit(fieldId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        coordinator.commit(fieldId)
                      }
                    }}
                    list={
                      resolved.field.valueKind === "entity-ref"
                        ? "supertag-field-" + fieldId + "-list"
                        : undefined
                    }
                    placeholder={resolved.field.valueKind === "entity-ref" ? "Pick or type a node id" : undefined}
                  />
                )}

                {resolved.field.valueKind === "entity-ref" && (
                  <datalist id={"supertag-field-" + fieldId + "-list"}>
                    {nodeTitles.map((node) => (
                      <option key={node.id} value={node.id} label={node.title} />
                    ))}
                  </datalist>
                )}

                <span className="supertag-field-status" role="status">
                  {snapshot?.phase === "frozen" && "Saving…"}
                  {snapshot?.phase === "failed" && (
                    <button
                      type="button"
                      className="supertag-field-retry"
                      disabled={removing}
                      onClick={() => coordinator.retry(fieldId)}
                    >
                      Retry
                    </button>
                  )}
                  {savedFieldId === fieldId && snapshot?.phase !== "failed" && "✓ Saved"}
                </span>
                {fieldError !== undefined && (
                  <p className="error supertag-field-error" role="alert">
                    {fieldSaveFailureMessage}
                  </p>
                )}
              </div>
            )
          })}

          <AddTagFieldForm
            tagId={tag.tagId}
            nextSortOrder={data.fields.filter((field) => !field.inherited).length}
            surface="web-supertag-field-editor"
            disabled={controlsFrozen}
            onAdded={() => setRefreshKey((key) => key + 1)}
          />
          {closing && <p className="supertag-popover-loading">Saving changes before closing…</p>}
        </div>
      )}
    </div>
  )
}
