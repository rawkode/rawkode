import { useMemo } from "react"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EntityId, ListTagsInput, RunViewInput, ViewSpec, type DomainError } from "@athenaeum/domain"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { formatDomainError } from "./format-domain-error.js"

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
  readonly onSelectTag: (chip: NoteTagChip) => void
}) {
  const effect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadNoteTags(client, nodeId))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeId, refreshKey]
  )
  const state = useEffectQuery(effect, [nodeId, refreshKey])

  if (state.status === "loading") return null
  if (state.status === "failure") {
    return <p className="error note-tags-error">{formatDomainError(state.error)}</p>
  }

  return (
    <section className="note-tags" aria-label="Supertags on this note">
      {state.value.length === 0 ? (
        <p className="note-tags-empty">
          No Supertags yet — type <code>#</code> in the note to apply one.
        </p>
      ) : (
        <ul className="note-tags-list">
          {state.value.map((chip) => (
            <li key={chip.tagId}>
              <button type="button" className="supertag-chip note-tags-chip" onClick={() => onSelectTag(chip)}>
                #{chip.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
