import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  EntityId,
  ListTagFieldsInput,
  ListTagsInput,
  RunViewInput,
  ViewSpec,
  type DomainError,
  type JsonValue,
  type ResolvedTagField
} from "@athenaeum/domain"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import {
  floatingAnchorRect,
  type FloatingAnchorRect,
  type FloatingAnchorRectSource
} from "./floating-popover-position.js"

// docs/supertag-centering-decisions.md §3, "Daily note gets its tags surfaced prominently":
// "the note's own tag chips (`graph_node_tags` filtered by `nodeId`, via `runView` — same read
// the field popover uses) each opening the identical field-editing popover... One data model, two
// entry points" — a tag applied via typing `#Person` in the prose (`supertag-plugin.ts`) shows up
// here automatically, since both paths read/write the exact same `graph_node_tags`/`graph_facts`
// rows, nothing component-local.

export interface NoteTagChip {
  readonly tagId: EntityId
  readonly name: string
}

type SuccessfulTagSnapshot = {
  readonly nodeId: EntityId
  readonly tags: ReadonlyArray<NoteTagChip>
}

interface FactRow {
  readonly predicateId: string
  readonly value: string
}

/** Keep the chip row useful at a glance without turning it into a second editor. Empty values are
 * omitted; a malformed fact degrades to no summary rather than leaking raw JSON or breaking the
 * note surface. */
export const formatNoteTagFieldValue = (value: JsonValue | undefined, field: ResolvedTagField): string | undefined => {
  if (value === undefined || value === null) return undefined
  switch (field.field.valueKind) {
    case "text":
    case "date":
    case "entity-ref": {
      if (typeof value !== "string") return undefined
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined
    case "checkbox":
      return typeof value === "boolean" ? (value ? "yes" : "no") : undefined
    default:
      // Structured values are intentionally omitted from this compact context strip. The field
      // editor remains the place for structured data; never leak raw JSON into the note chrome.
      return undefined
  }
}

const parseFactValue = (raw: string): JsonValue | undefined => {
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return undefined
  }
}

/** `graph_node_tags`'s real columns (`read-model.ts`: `graph_node_tags AS SELECT nodeId, tagId
 *  FROM rm_node_tags`) — `runView`'s `RunViewOutput.rows` is `Schema.Array(Schema.Unknown)` since
 *  it's a general compiler over ten different views (`GraphView.tsx`'s own `GraphNodeRow` comment
 *  explains this narrowing-cast convention in full), applied here the same way. */
interface NodeTagRow {
  readonly tagId: string
}

const loadNoteTags = (
  client: WorkspaceRpcClientService,
  nodeId: EntityId
): Effect.Effect<ReadonlyArray<NoteTagChip>, DomainError> =>
  Effect.gen(function* () {
    const spec = new ViewSpec({
      filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: nodeId },
      view: "table",
      visibleColumns: ["tagId"],
      rowLimit: 200
    })
    const { rows } = yield* client.runView(
      new RunViewInput({ workspaceId, viewName: "graph_node_tags", viewSpec: spec })
    )
    const tagIds = (rows as ReadonlyArray<NodeTagRow>).map((row) => row.tagId)
    if (tagIds.length === 0) return []

    // Resolve names against the whole-workspace tag list (`listTags`, already real) — same
    // "small, flat, whole-workspace list, joined client-side" precedent `tag-field-definition.ts`
    // documents for `listTagClosure`/`listFieldDefinitions`.
    const { tags } = yield* client.listTags(new ListTagsInput({ workspaceId }))
    const nameById = new Map(tags.map((tag) => [tag.id as string, tag.name]))
    return tagIds.flatMap((rawTagId) => {
      const decoded = Schema.decodeUnknownOption(EntityId)(rawTagId)
      if (decoded._tag === "None") return []
      return [{ tagId: decoded.value, name: nameById.get(rawTagId) ?? rawTagId }]
    })
  })

export function NoteTags({
  nodeId,
  refreshKey,
  onSelectTag
}: {
  readonly nodeId: EntityId
  readonly refreshKey: number
  readonly onSelectTag: (
    chip: NoteTagChip,
    anchorRect: FloatingAnchorRect,
    anchorRectSource: FloatingAnchorRectSource
  ) => void
}) {
  // A retry belongs to this read-only presentation query. Keep the caller-owned refresh signal
  // intact: it is how an accepted tag mutation elsewhere in the note refreshes this same list.
  const [retryKey, setRetryKey] = useState(0)
  const [retryClaimed, setRetryClaimed] = useState(false)
  const retryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadNoteTags(client, nodeId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, refreshKey, retryKey]
  )
  const state = useEffectQuery(effect, [nodeId, refreshKey, retryKey])
  // `useEffectQuery` publishes loading from an effect, so a dependency change first renders its
  // previous store value. Do not attribute that old result to a new node or refresh generation.
  // The initial render owns its state; later scopes become current only after loading is visible.
  const queryScopeKey = `${nodeId}:${refreshKey}:${retryKey}`
  const queryScope = useRef<{ key: string; current: boolean } | undefined>(undefined)
  if (queryScope.current === undefined) {
    queryScope.current = { key: queryScopeKey, current: true }
  } else if (queryScope.current.key !== queryScopeKey) {
    queryScope.current = { key: queryScopeKey, current: false }
  }
  if (state.status === "loading") queryScope.current.current = true
  const stateIsCurrent = queryScope.current.current
  const [successfulSnapshot, setSuccessfulSnapshot] = useState<SuccessfulTagSnapshot | undefined>(() =>
    state.status === "success" ? { nodeId, tags: state.value } : undefined
  )
  useEffect(() => {
    if (!stateIsCurrent || state.status !== "success") return
    setSuccessfulSnapshot((current) =>
      current?.nodeId === nodeId && current.tags === state.value
        ? current
        : { nodeId, tags: state.value }
    )
  }, [nodeId, state.status === "success" ? state.value : undefined, stateIsCurrent])
  useEffect(() => {
    const claim = retryClaim.current
    if (claim === undefined) return
    if (state.status === "loading") {
      claim.sawLoading = true
      return
    }
    if (!claim.sawLoading) return
    retryClaim.current = undefined
    setRetryClaimed(false)
  }, [state.status])
  const retryTags = useCallback(() => {
    if (retryClaim.current !== undefined || state.status === "loading") return
    retryClaim.current = { sawLoading: false }
    setRetryClaimed(true)
    setRetryKey((key) => key + 1)
  }, [state.status])
  const cachedTags = successfulSnapshot?.nodeId === nodeId ? successfulSnapshot.tags : undefined
  const visibleTags = stateIsCurrent && state.status === "success" ? state.value : cachedTags
  const isLoading = !stateIsCurrent || state.status === "loading"
  const isFailure = stateIsCurrent && state.status === "failure"
  const isRetrying = retryClaimed || isLoading

  return (
    <section className="note-tags" aria-label="Supertags on this note" aria-busy={isLoading}>
      {isLoading && (
        <div className="note-tags-load-state" role="status">
          <p>{cachedTags === undefined ? "Loading Supertags…" : "Refreshing Supertags…"}</p>
        </div>
      )}
      {isFailure && (
        <div className="note-tags-load-state" role="alert" aria-label="Supertags are unavailable">
          <div>
            <p className="note-tags-load-title">Supertags are unavailable</p>
            <p>
              {cachedTags === undefined
                ? "Supertags could not be loaded. Nothing has been changed. Retry to check them again."
                : "Supertags could not be refreshed. Your existing Supertags remain available. Retry to check them again."}
            </p>
          </div>
          <button type="button" onClick={retryTags} disabled={isRetrying}>
            {isRetrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}
      {visibleTags !== undefined && (visibleTags.length === 0 ? (
        <p className="note-tags-empty">
          No Supertags yet — type <code>#</code> in the note to apply one.
        </p>
      ) : (
        <ul className="note-tags-list">
          {visibleTags.map((chip) => (
            <li key={chip.tagId}>
              <div className="note-tags-item">
                <button
                  type="button"
                  className="supertag-chip note-tags-chip"
                  onClick={(event) => {
                    const element = event.currentTarget
                    onSelectTag(
                      chip,
                      floatingAnchorRect(element.getBoundingClientRect()),
                      () => floatingAnchorRect(element.getBoundingClientRect())
                    )
                  }}
                >
                  #{chip.name}
                </button>
                <NoteTagFieldSummary
                  key={`${chip.tagId}:${refreshKey}`}
                  nodeId={nodeId}
                  tagId={chip.tagId}
                  tagName={chip.name}
                  refreshKey={refreshKey}
                />
              </div>
            </li>
          ))}
        </ul>
      ))}
    </section>
  )
}

function NoteTagFieldSummary({
  nodeId,
  tagId,
  tagName,
  refreshKey
}: {
  readonly nodeId: EntityId
  readonly tagId: EntityId
  readonly tagName: string
  readonly refreshKey: number
}) {
  const effect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const { fields } = yield* client.listTagFields(new ListTagFieldsInput({ workspaceId, tagId }))
            if (fields.length === 0) return [] as ReadonlyArray<string>

            const spec = new ViewSpec({
              filter: { op: "eq", field: { kind: "column", column: "nodeId" }, value: nodeId },
              view: "table",
              visibleColumns: ["predicateId", "value"],
              rowLimit: 500
            })
            const { rows } = yield* client.runView(
              new RunViewInput({ workspaceId, viewName: "graph_facts", viewSpec: spec })
            )
            const facts = new Map(
              (rows as ReadonlyArray<FactRow>).flatMap((row) => {
                const value = parseFactValue(row.value)
                return value === undefined ? [] : [[row.predicateId, value] as const]
              })
            )
            return fields.flatMap((resolved) => {
              const value = formatNoteTagFieldValue(facts.get(resolved.field.id), resolved)
              return value === undefined ? [] : [`${resolved.field.name}: ${value}`]
            })
          })
        )
      ),
    [nodeId, tagId, refreshKey]
  )
  const state = useEffectQuery(effect, [nodeId, tagId, refreshKey])

  if (state.status !== "success" || state.value.length === 0) return null
  return (
    <span className="note-tags-summary" aria-label={`Values for #${tagName}`}>
      {state.value.join(" · ")}
    </span>
  )
}
