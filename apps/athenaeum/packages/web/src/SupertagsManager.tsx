import { useMemo, useState } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  CreateTagInput,
  ListTagFieldsInput,
  ListTagsInput,
  type DomainError,
  type EntityId,
  type ResolvedTagField,
  type Tag
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"
import { AddTagFieldForm } from "./AddTagFieldForm.js"

// docs/supertag-centering-decisions.md §3, "New `/supertags` route — minimal, concrete shape".
// Tag schema administration — create a tag, set its parents at creation time, define its fields —
// as distinct from `/graph`'s read-only ViewSpec browsing (see that section's own "different
// mental modes" reasoning). Every read/write here is an RPC that already exists and is already
// tested server-side (`listTags`, `createTag`, `listTagFields`, and — via the shared
// `AddTagFieldForm` — `defineTagField`); this component adds no new backend surface, only the
// admin-shaped UI for what already exists.

const loadTags = (client: WorkspaceRpcClientService): Effect.Effect<ReadonlyArray<Tag>, DomainError> =>
  client.listTags(new ListTagsInput({ workspaceId })).pipe(Effect.map((output) => output.tags))

const loadFields = (
  client: WorkspaceRpcClientService,
  tagId: EntityId
): Effect.Effect<ReadonlyArray<ResolvedTagField>, DomainError> =>
  client.listTagFields(new ListTagFieldsInput({ workspaceId, tagId })).pipe(Effect.map((output) => output.fields))

/** Create-tag form — name plus a multi-select of existing tags as parents (decisions doc §3:
 *  "Create tag form: name + a multi-select of existing tags as parents → `createTag`"). Editing
 *  parents after creation is the doc's own named, explicitly-deferred gap (no `updateTagParents`
 *  RPC exists) — this form is create-only, matching what the backend actually supports today. */
function CreateTagForm({
  tags,
  onCreated
}: {
  readonly tags: ReadonlyArray<Tag>
  readonly onCreated: (tagId: EntityId) => void
}) {
  const [name, setName] = useState("")
  const [parentIds, setParentIds] = useState<ReadonlySet<EntityId>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleParent = (id: EntityId) => {
    setParentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCreate = () => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createTag(new CreateTagInput({ workspaceId, name: trimmed, parentIds: [...parentIds] }))
        )
      )
    )
    fiber.addObserver((exit) => {
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setName("")
        setParentIds(new Set())
        onCreated(exit.value.tag.id)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="supertags-create-form">
      <div className="supertags-create-form-row">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New Supertag name"
          aria-label="New Supertag name"
          disabled={busy}
        />
        <button type="button" onClick={handleCreate} disabled={busy || trimmedEmpty(name)}>
          {busy ? "Creating…" : "+ Create tag"}
        </button>
      </div>
      {tags.length > 0 && (
        <fieldset className="supertags-create-form-parents">
          <legend>Parents (optional — inherits their fields)</legend>
          <div className="supertags-create-form-parent-list">
            {tags.map((tag) => (
              <label key={tag.id} className="supertags-create-form-parent">
                <input
                  type="checkbox"
                  checked={parentIds.has(tag.id)}
                  onChange={() => toggleParent(tag.id)}
                  disabled={busy}
                />
                #{tag.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error !== null && <p className="error">{error}</p>}
    </div>
  )
}

const trimmedEmpty = (value: string) => value.trim().length === 0

function TagFieldsList({ tagId, tagsById }: { readonly tagId: EntityId; readonly tagsById: ReadonlyMap<string, Tag> }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadFields(client, tagId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tagId, refreshKey]
  )
  const state = useEffectQuery(effect, [tagId, refreshKey])

  return (
    <div className="supertags-fields">
      <h4>Fields</h4>
      {state.status === "loading" && <p className="supertags-fields-loading">Loading fields…</p>}
      {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}
      {state.status === "success" && (
        <>
          {state.value.length === 0 ? (
            <p className="supertags-fields-empty">No fields yet — every node tagged #{tagsById.get(tagId)?.name} is a bare label for now.</p>
          ) : (
            <ul className="supertags-fields-list">
              {state.value.map((resolved) => {
                const declaringTag = tagsById.get(resolved.field.tagId)
                return (
                  <li key={resolved.field.id} className="supertags-field-row">
                    <span className="supertags-field-name">{resolved.field.name}</span>
                    <span className="supertags-field-kind tabular-nums">{resolved.field.valueKind}</span>
                    {resolved.inherited && declaringTag !== undefined && (
                      <span className="supertag-field-inherited">
                        · inherited from #{declaringTag.name}
                      </span>
                    )}
                    {resolved.field.builtin && <span className="supertags-field-builtin">built-in</span>}
                  </li>
                )
              })}
            </ul>
          )}
          <AddTagFieldForm
            tagId={tagId}
            nextSortOrder={state.value.filter((f) => !f.inherited).length}
            onAdded={() => setRefreshKey((k) => k + 1)}
          />
        </>
      )}
    </div>
  )
}

function TagDetail({
  tag,
  tags,
  tagsById
}: {
  readonly tag: Tag
  readonly tags: ReadonlyArray<Tag>
  readonly tagsById: ReadonlyMap<string, Tag>
}) {
  const parents = tag.parentIds.flatMap((id) => {
    const parent = tagsById.get(id)
    return parent === undefined ? [] : [parent]
  })
  const children = tags.filter((candidate) => candidate.parentIds.includes(tag.id))

  return (
    <div className="supertags-detail">
      <header className="supertags-detail-header">
        <span className="supertag-chip">#{tag.name}</span>
        {tag.builtin && <span className="supertags-detail-badge">Base Tag</span>}
      </header>

      <dl className="supertags-detail-meta">
        <div>
          <dt>Parents</dt>
          <dd>
            {parents.length === 0
              ? "— (a root tag)"
              : parents.map((parent) => `#${parent.name}`).join(", ")}
          </dd>
        </div>
        <div>
          <dt>Children</dt>
          <dd>
            {children.length === 0 ? "—" : children.map((child) => `#${child.name}`).join(", ")}
          </dd>
        </div>
      </dl>

      <TagFieldsList tagId={tag.id} tagsById={tagsById} />
    </div>
  )
}

export function SupertagsManager() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedTagId, setSelectedTagId] = useState<EntityId | null>(null)

  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap(loadTags)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey]
  )
  const state = useEffectQuery(effect, [refreshKey])

  const tags = state.status === "success" ? state.value : []
  const sortedTags = useMemo(
    () => [...tags].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)),
    [tags]
  )
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id as string, tag])), [tags])
  const selectedTag = selectedTagId === null ? undefined : tagsById.get(selectedTagId)

  return (
    <section className="supertags-panel">
      <div className="supertags-list-column">
        <CreateTagForm
          tags={tags}
          onCreated={(tagId) => {
            setRefreshKey((k) => k + 1)
            setSelectedTagId(tagId)
          }}
        />

        {state.status === "loading" && <p>Loading tags…</p>}
        {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}

        {state.status === "success" && (
          <ul className="supertags-list">
            {sortedTags.map((tag) => {
              const parents = tag.parentIds.flatMap((id) => {
                const parent = tagsById.get(id)
                return parent === undefined ? [] : [parent.name]
              })
              return (
                <li key={tag.id}>
                  <button
                    type="button"
                    className={`supertags-list-item-button${
                      selectedTagId === tag.id ? " supertags-list-item-button-selected" : ""
                    }`}
                    onClick={() => setSelectedTagId(tag.id)}
                  >
                    <span className="supertags-list-item-name">#{tag.name}</span>
                    {tag.builtin && <span className="supertags-list-item-badge">Base</span>}
                    {parents.length > 0 && (
                      <span className="supertags-list-item-parents">{parents.map((p) => `#${p}`).join(", ")}</span>
                    )}
                  </button>
                </li>
              )
            })}
            {sortedTags.length === 0 && <li className="supertags-empty">No Supertags yet.</li>}
          </ul>
        )}
      </div>

      {selectedTag !== undefined && <TagDetail tag={selectedTag} tags={tags} tagsById={tagsById} />}
    </section>
  )
}
