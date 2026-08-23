import { useState } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { DefineTagFieldInput, type DomainError, type EntityId, type TagFieldValueKind } from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

// docs/supertag-centering-decisions.md §3, "Selected tag detail panel": "the same '+ Add field'
// affordance the inline popover uses (`createTagFieldDefinition`) — **the same component/form**,
// not a duplicate one, so 'add a field' behaves identically whether reached from a `#chip` popover
// mid-note or from the [Supertags admin] page." Extracted out of `SupertagFieldPopover.tsx` (its
// original, only caller) so `SupertagsManager.tsx` can render the identical form against a tag
// with no node/fact context at all — this component only ever calls `defineTagField`, never
// `addFact`, so it needs nothing node-shaped in its props.

export function AddTagFieldForm({
  tagId,
  nextSortOrder,
  onAdded
}: {
  readonly tagId: EntityId
  /** Where this field lands among the tag's own (non-inherited) fields — the caller computes
   *  this from whatever field list it already has loaded (own-fields count), since `sortOrder`
   *  is scoped to `tagId` (tag-field-definition.ts's own doc comment on `sortOrder`). */
  readonly nextSortOrder: number
  readonly onAdded: () => void
}) {
  const [name, setName] = useState("")
  const [valueKind, setValueKind] = useState<TagFieldValueKind>("text")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleAdd = () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    setError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.defineTagField(
            new DefineTagFieldInput({ workspaceId, tagId, name: trimmed, valueKind, sortOrder: nextSortOrder })
          )
        )
      )
    )
    fiber.addObserver((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setName("")
        setValueKind("text")
        onAdded()
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="supertag-popover-add-field">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="+ Add field"
        aria-label="New field name"
        disabled={busy}
      />
      <select
        value={valueKind}
        onChange={(event) => setValueKind(event.target.value as TagFieldValueKind)}
        aria-label="New field type"
        disabled={busy}
      >
        <option value="text">text</option>
        <option value="number">number</option>
        <option value="date">date</option>
        <option value="checkbox">checkbox</option>
        <option value="entity-ref">entity-ref</option>
      </select>
      <button type="button" onClick={handleAdd} disabled={busy || name.trim().length === 0}>
        {busy ? "Adding…" : "Add"}
      </button>
      {error !== null && <p className="error">{error}</p>}
    </div>
  )
}
