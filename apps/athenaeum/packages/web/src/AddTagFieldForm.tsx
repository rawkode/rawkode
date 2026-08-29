import { useRef, useState } from "react"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  DefineTagFieldInput,
  HumanUiMutationAttribution,
  normalizeTagFieldName,
  type EntityId,
  type TagFieldValueKind
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"

// docs/supertag-centering-decisions.md §3: the same add-field affordance is shared by the
// inline field editor and the Supertags manager. The explicit provenance surface below keeps
// those two origins distinguishable in the workspace ledger.

type AddFieldSurface = "web-supertag-field-editor" | "web-supertags-manager"

interface PendingAddField {
  readonly requestId: string
  readonly name: string
  readonly valueKind: TagFieldValueKind
  readonly sortOrder: number
}

const addFieldFailureMessage =
  "Field couldn’t be added. Your field details are still here. Retry to continue."

export function AddTagFieldForm({
  tagId,
  nextSortOrder,
  surface,
  disabled = false,
  onAdded
}: {
  readonly tagId: EntityId
  readonly nextSortOrder: number
  /** The shared form has two real UI origins; retain the exact one as typed attribution. */
  readonly surface: AddFieldSurface
  readonly disabled?: boolean
  readonly onAdded: () => void
}) {
  const [name, setName] = useState("")
  const [valueKind, setValueKind] = useState<TagFieldValueKind>("text")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** One immutable operation identity survives an uncertain response and an explicit Retry. */
  const [pendingOperation, setPendingOperation] = useState<PendingAddField | null>(null)
  const isAddingRef = useRef(false)

  const handleAdd = () => {
    const normalizedName = normalizeTagFieldName(name)
    if (normalizedName.length === 0) return
    if (isAddingRef.current) return
    isAddingRef.current = true

    const operation = pendingOperation !== null
      && pendingOperation.name === normalizedName
      && pendingOperation.valueKind === valueKind
      ? pendingOperation
      : {
          requestId: crypto.randomUUID(),
          name: normalizedName,
          valueKind,
          sortOrder: nextSortOrder
        }
    setPendingOperation(operation)
    setBusy(true)
    setError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.defineTagField(
            new DefineTagFieldInput({
              workspaceId,
              tagId,
              name: operation.name,
              valueKind: operation.valueKind,
              sortOrder: operation.sortOrder,
              requestId: operation.requestId,
              commitMessage: `Add the ${operation.name} field to this Supertag.`,
              attribution: new HumanUiMutationAttribution({
                version: "athenaeum.mutation-attribution.v1",
                kind: "humanUi",
                surface
              })
            })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      isAddingRef.current = false
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setName("")
        setValueKind("text")
        setPendingOperation(null)
        onAdded()
      } else if (!Exit.isInterrupted(exit)) {
        setError(addFieldFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const normalizedName = normalizeTagFieldName(name)
  const retryingSameOperation = pendingOperation !== null
    && pendingOperation.name === normalizedName
    && pendingOperation.valueKind === valueKind

  return (
    <div className="supertag-popover-add-field">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="+ Add field"
        aria-label="New field name"
        disabled={busy || disabled}
      />
      <select
        value={valueKind}
        onChange={(event) => setValueKind(event.target.value as TagFieldValueKind)}
        aria-label="New field type"
        disabled={busy || disabled}
      >
        <option value="text">text</option>
        <option value="number">number</option>
        <option value="date">date</option>
        <option value="checkbox">checkbox</option>
        <option value="entity-ref">entity-ref</option>
      </select>
      <button type="button" onClick={handleAdd} disabled={busy || disabled || normalizedName.length === 0}>
        {busy ? "Adding…" : retryingSameOperation ? "Retry" : "Add"}
      </button>
      {error !== null && <p className="error" role="alert">{error}</p>}
    </div>
  )
}
