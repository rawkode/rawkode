import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  CreateTagInput,
  GetTagInput,
  HumanUiMutationAttribution,
  ListTagFieldsInput,
  ListTagsInput,
  type DomainError,
  type EntityId,
  type ResolvedTagField,
  type Tag,
  UpdateTagInput
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { AddTagFieldForm } from "./AddTagFieldForm.js"

// docs/supertag-centering-decisions.md §3, "New `/supertags` route — minimal, concrete shape".
// Tag schema administration — create and edit a tag, set its parents, and define its fields — as
// distinct from `/graph`'s read-only ViewSpec browsing (see that section's own "different mental
// modes" reasoning). Every read/write here is an RPC with a server-issued revision fence; the
// manager keeps the draft visible when a save conflicts so the user can reconcile deliberately.

const loadTags = (client: WorkspaceRpcClientService): Effect.Effect<ReadonlyArray<Tag>, DomainError> =>
  client.listTags(new ListTagsInput({ workspaceId })).pipe(Effect.map((output) => output.tags))

const loadFields = (
  client: WorkspaceRpcClientService,
  tagId: EntityId
): Effect.Effect<ReadonlyArray<ResolvedTagField>, DomainError> =>
  client.listTagFields(new ListTagFieldsInput({ workspaceId, tagId })).pipe(Effect.map((output) => output.fields))

interface SuccessfulFieldSnapshot {
  readonly tagId: EntityId
  readonly fields: ReadonlyArray<ResolvedTagField>
}

interface FieldQueryScope {
  readonly key: string
  readonly tagId: EntityId
}

export interface TagEditDraft {
  readonly revision: string
  readonly name: string
  readonly parentIds: ReadonlySet<EntityId>
}

export interface TagEditRequest {
  readonly id: string
  readonly signature: string
}

/** Must cover every client-supplied UpdateTag semantic field. Only this exact shape may reuse a
 * request id after an uncertain failure; any edit mints a new command identity. */
export const tagEditRequestSignature = (draft: TagEditDraft): string =>
  JSON.stringify({ expectedRevision: draft.revision, name: draft.name, parentIds: [...draft.parentIds] })

export const requestForTagEditDraft = (
  current: TagEditRequest | undefined,
  draft: TagEditDraft,
  mint: () => string = () => crypto.randomUUID()
): TagEditRequest => {
  const signature = tagEditRequestSignature(draft)
  return current?.signature === signature ? current : { id: mint(), signature }
}

/** A conflict reload refreshes only the server-issued revision. The user's unsaved values remain
 * explicit until they save or cancel, rather than being silently overwritten by the catalog. */
export const mergeTagEditBaseline = (draft: TagEditDraft, revision: string): TagEditDraft => ({ ...draft, revision })

const tagCreationFailureMessage =
  "We couldn’t confirm that this Supertag was created. The name and parents are still here. Review your tags before taking another action."

/** Create-tag form — name plus a multi-select of existing tags as parents (decisions doc §3:
 *  "Create tag form: name + a multi-select of existing tags as parents → `createTag`"). Editing
 *  is handled by TagDetail below with a server-issued revision fence. */
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
  const isCreatingRef = useRef(false)

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
    if (isCreatingRef.current) return
    isCreatingRef.current = true
    const requestId = crypto.randomUUID()
    setBusy(true)
    setError(null)
    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createTag(new CreateTagInput({
            workspaceId,
            name: trimmed,
            parentIds: [...parentIds],
            requestId,
            commitMessage: `Define the ${trimmed} Supertag and its inherited schema.`,
            attribution: new HumanUiMutationAttribution({
              version: "athenaeum.mutation-attribution.v1",
              kind: "humanUi",
              surface: "web-supertags-manager"
            })
          }))
        )
      )
    )
    fiber.addObserver((exit) => {
      isCreatingRef.current = false
      setBusy(false)
      if (Exit.isSuccess(exit)) {
        setName("")
        setParentIds(new Set())
        onCreated(exit.value.tag.id)
      } else if (!Exit.isInterrupted(exit)) {
        setError(tagCreationFailureMessage)
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
      {error !== null && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

const trimmedEmpty = (value: string) => value.trim().length === 0

/**
 * The schema browser should never open as an empty second column when tags already exist.
 * A valid explicit choice (whether from a row click or a freshly-created tag) wins; a missing
 * choice and a stale one both deterministically fall back to the first visible tag.
 */
export const resolveVisibleTag = (
  selectedTagId: EntityId | null,
  sortedTags: ReadonlyArray<Tag>,
  tagsById: ReadonlyMap<string, Tag>
): Tag | undefined => selectedTagId === null ? sortedTags[0] : tagsById.get(selectedTagId) ?? sortedTags[0]

function TagFieldsList({ tagId, tagsById }: { readonly tagId: EntityId; readonly tagsById: ReadonlyMap<string, Tag> }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ tagId: EntityId; sawLoading: boolean } | undefined>(undefined)
  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadFields(client, tagId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tagId, refreshKey]
  )
  const state = useEffectQuery(effect, [tagId, refreshKey])
  // `useEffectQuery` keeps its preceding result for the render in which a new tag or refresh
  // generation begins. It is useful as a same-tag cache, but must never be treated as a result
  // for a different tag's schema.
  const queryScopeKey = `${tagId}:${refreshKey}`
  const [activeQueryScope, setActiveQueryScope] = useState<FieldQueryScope>({ key: queryScopeKey, tagId })
  useEffect(() => {
    setActiveQueryScope((previous) => previous.key === queryScopeKey ? previous : { key: queryScopeKey, tagId })
  }, [queryScopeKey, tagId])
  const stateIsCurrent = activeQueryScope.key === queryScopeKey
  const stateCouldBelongToPreviousTag = !stateIsCurrent && activeQueryScope.tagId !== tagId
  const currentFields = stateIsCurrent && state.status === "success" ? state.value : undefined
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<SuccessfulFieldSnapshot | undefined>(() =>
    currentFields === undefined ? undefined : { tagId, fields: currentFields }
  )
  useEffect(() => {
    if (stateIsCurrent && state.status === "success") {
      setSuccessfulSnapshot((previous) =>
        previous?.tagId === tagId && previous.fields === state.value
          ? previous
          : { tagId, fields: state.value }
      )
    }
  }, [tagId, refreshKey, state.status, stateIsCurrent])
  const cachedFields = successfulSnapshot?.tagId === tagId ? successfulSnapshot.fields : undefined
  const visibleFields = currentFields ?? cachedFields
  const isLoadingFields = !stateIsCurrent || state.status === "loading"
  const isFailureFields = state.status === "failure" && !stateCouldBelongToPreviousTag
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (claim.tagId !== tagId) {
      retryClaim.current = undefined
      setRetryClaimed(false)
      return
    }
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // The refresh-key render still contains the prior field-read failure. Keep the presentation
    // claim until this tag's retry visibly loads and then reaches its terminal state.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [tagId, state.status])
  const retryFields = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { tagId, sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [tagId, state.status])
  const isRetryingFields = retryClaimed || state.status === "loading"

  return (
    <div className="supertags-fields">
      <h4>Fields</h4>
      {isLoadingFields && (
        <p className="supertags-fields-loading" role="status" aria-live="polite" aria-atomic="true">
          {cachedFields === undefined ? "Loading fields…" : "Refreshing fields…"}
        </p>
      )}
      {isFailureFields && (
        <section className="supertags-fields-load-state" role="alert" aria-label="Supertag fields are unavailable">
          <p>
            {cachedFields === undefined
              ? "We couldn’t load this Supertag’s fields. Try again before making schema changes."
              : "We couldn’t refresh this Supertag’s fields. Your previously loaded fields remain available. Retry before making schema changes."}
          </p>
          <button type="button" onClick={retryFields} disabled={isRetryingFields}>
            {isRetryingFields ? "Retrying…" : "Retry"}
          </button>
        </section>
      )}
      {currentFields !== undefined && currentFields.length === 0 && (
        <p className="supertags-fields-empty">No fields yet — every node tagged #{tagsById.get(tagId)?.name} is a bare label for now.</p>
      )}
      {visibleFields !== undefined && visibleFields.length > 0 && (
        <ul className="supertags-fields-list">
          {visibleFields.map((resolved) => {
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
      {currentFields !== undefined && (
        <>
          <AddTagFieldForm
            tagId={tagId}
            nextSortOrder={currentFields.filter((f) => !f.inherited).length}
            surface="web-supertags-manager"
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
  tagsById,
  onUpdated
}: {
  readonly tag: Tag
  readonly tags: ReadonlyArray<Tag>
  readonly tagsById: ReadonlyMap<string, Tag>
  readonly onUpdated: (tagId: EntityId) => void
}) {
  const [draft, setDraft] = useState<TagEditDraft | undefined>()
  const [editError, setEditError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const request = useRef<TagEditRequest | undefined>(undefined)
  // TagFieldsList deliberately keeps its own retry/cache state across selection. Reset only the
  // schema-editor lifecycle so a failed draft, request id, error, or revision can never become
  // actionable for the newly selected tag.
  useEffect(() => {
    request.current = undefined
    setDraft(undefined)
    setEditError(null)
    setLoading(false)
    setBusy(false)
  }, [tag.id])
  const parents = tag.parentIds.flatMap((id) => {
    const parent = tagsById.get(id)
    return parent === undefined ? [] : [parent]
  })
  const children = tags.filter((candidate) => candidate.parentIds.includes(tag.id))
  const loadBaseline = (preserveDraft: boolean) => {
    if (busy || loading || tag.builtin) return
    if (!preserveDraft) request.current = undefined
    setLoading(true)
    setEditError(null)
    runtime.runFork(WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getTag(new GetTagInput({ workspaceId, tagId: tag.id })))))
      .addObserver((exit) => {
        setLoading(false)
        if (Exit.isSuccess(exit)) {
          request.current = undefined
          setDraft((current) => preserveDraft && current !== undefined
            ? mergeTagEditBaseline(current, exit.value.tag.revision)
            : { revision: exit.value.tag.revision, name: exit.value.tag.tag.name, parentIds: new Set(exit.value.tag.tag.parentIds) })
        }
        else if (!Exit.isInterrupted(exit)) setEditError("We couldn’t load the latest schema. Retry before editing.")
      })
  }
  const startEdit = () => loadBaseline(false)
  const reloadLatest = () => loadBaseline(true)
  const toggleParent = (id: EntityId) => setDraft((current) => {
    if (current === undefined) return current
    const parentIds = new Set(current.parentIds)
    if (parentIds.has(id)) parentIds.delete(id); else parentIds.add(id)
    return { ...current, parentIds }
  })
  const save = () => {
    if (draft === undefined || busy || loading) return
    const currentRequest = requestForTagEditDraft(request.current, draft)
    request.current = currentRequest
    setBusy(true); setEditError(null)
    runtime.runFork(WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.updateTag(new UpdateTagInput({
      workspaceId, tagId: tag.id, expectedRevision: draft.revision, name: draft.name, parentIds: [...draft.parentIds], requestId: currentRequest.id,
      commitMessage: `Update the ${draft.name.trim() || tag.name} Supertag schema.`,
      attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-supertags-manager" })
    })))))
      .addObserver((exit) => {
        setBusy(false)
        if (Exit.isSuccess(exit)) { request.current = undefined; setDraft(undefined); onUpdated(tag.id) }
        else if (!Exit.isInterrupted(exit)) {
          const message = exit.cause.toString().includes("changed elsewhere")
            ? "This Supertag changed elsewhere. Your draft is still here; reload the latest version or retry after reconciling it."
            : "We couldn’t save this schema. Your draft is still here; retry or reload the latest version."
          setEditError(message)
        }
      })
  }

  return (
    <div className="supertags-detail">
      <header className="supertags-detail-header">
        <span className="supertag-chip">#{tag.name}</span>
        {tag.builtin && <span className="supertags-detail-badge">Base Tag</span>}
        {!tag.builtin && draft === undefined && <button type="button" onClick={startEdit} disabled={loading}>{loading ? "Loading…" : "Edit"}</button>}
      </header>

      {draft === undefined && editError !== null && (
        <div className="error" role="alert">
          <p>{editError}</p>
          <button type="button" onClick={startEdit} disabled={loading}>Retry load</button>
        </div>
      )}

      {draft !== undefined && (
        <section className="supertags-edit-form" aria-label={`Edit ${tag.name} Supertag`}>
          <label>Name <input value={draft.name} disabled={busy || loading} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <fieldset disabled={busy || loading}><legend>Parents</legend>
            {tags.filter((candidate) => candidate.id !== tag.id).map((candidate) => <label key={candidate.id}>
              <input type="checkbox" checked={draft.parentIds.has(candidate.id)} onChange={() => toggleParent(candidate.id)} /> #{candidate.name}
            </label>)}
          </fieldset>
          <button type="button" onClick={save} disabled={busy || loading || trimmedEmpty(draft.name)}>{busy ? "Saving…" : loading ? "Reloading…" : "Save"}</button>
          <button type="button" onClick={() => { request.current = undefined; setDraft(undefined); setEditError(null) }} disabled={busy || loading}>Cancel</button>
          {editError !== null && <div className="error" role="alert"><p>{editError}</p><button type="button" onClick={save} disabled={busy || loading}>Retry save</button><button type="button" onClick={reloadLatest} disabled={busy || loading}>Reload latest</button></div>}
        </section>
      )}

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
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const [selectedTagId, setSelectedTagId] = useState<EntityId | null>(null)

  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap(loadTags)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshKey]
  )
  const state = useEffectQuery(effect, [refreshKey])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A refresh-key render still has the preceding failure. Keep the presentation claim until
    // the requested catalog read visibly loads and then reaches its terminal result.
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [state.status])
  const retryCatalog = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { sawLoading: false }
    setRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [state.status])
  const isRetryingCatalog = retryClaimed || state.status === "loading"

  const tags = state.status === "success" ? state.value : []
  const sortedTags = useMemo(
    () => [...tags].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)),
    [tags]
  )
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id as string, tag])), [tags])
  const selectedTag = resolveVisibleTag(selectedTagId, sortedTags, tagsById)

  return (
    <section className="supertags-panel">
      <div className="supertags-list-column">
        <details className="supertags-create-disclosure">
          <summary>+ New Supertag</summary>
          <CreateTagForm
            tags={tags}
            onCreated={(tagId) => {
              setRefreshKey((k) => k + 1)
              setSelectedTagId(tagId)
            }}
          />
        </details>

        {state.status === "loading" && (
          <p role="status" aria-live="polite" aria-atomic="true">
            Loading tags…
          </p>
        )}
        {state.status === "failure" && (
          <section className="supertags-catalog-load-state" role="alert" aria-label="Supertags are unavailable">
            <p>Supertags couldn’t be loaded. You can still create a new root tag.</p>
            <button type="button" onClick={retryCatalog} disabled={isRetryingCatalog}>
              {isRetryingCatalog ? "Retrying…" : "Retry"}
            </button>
          </section>
        )}

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
                      selectedTag?.id === tag.id ? " supertags-list-item-button-selected" : ""
                    }`}
                    aria-current={selectedTag?.id === tag.id ? "true" : undefined}
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
            {sortedTags.length === 0 && (
              <li className="supertags-empty">
                No Supertags yet. <Link to="/notes">Open today’s note</Link> to apply or create one inline with <code>#</code>.
              </li>
            )}
          </ul>
        )}
      </div>

      {selectedTag !== undefined && <TagDetail tag={selectedTag} tags={tags} tagsById={tagsById} onUpdated={(tagId) => { setSelectedTagId(tagId); setRefreshKey((key) => key + 1) }} />}
    </section>
  )
}
