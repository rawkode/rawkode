import { useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import {
  CreateEdgeInput,
  CreateNodeInput,
  GetNodeInput,
  ListBacklinksInput,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient, type WorkspaceRpcClientService } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { ensureMentionsRelationDefinition } from "./mentions-relation.js"
import { formatDomainError } from "./format-domain-error.js"

// Task item 2 ("Backlinks: on a note/node's detail view, show nodes/edges linking to it, via the
// backend's listBacklinks RPC") plus its own verification affordance ("seeing at least one
// backlink appear after creating a related node/edge via a quick script or a minimal UI
// affordance"). `listBacklinks(nodeId)` returns raw `Edge` rows (edge.ts: no stored inverse
// record, `GraphDataModel.md` Evolution Rule #3) — each is enriched with its source node's title
// via a follow-up `getNode` so the list reads as "X mentions this note", not a table of ids.

interface BacklinkRow {
  readonly edgeId: EntityId
  readonly sourceNodeId: EntityId
  readonly sourceTitle: string
}

const loadBacklinks = (
  client: WorkspaceRpcClientService,
  nodeId: EntityId
): Effect.Effect<ReadonlyArray<BacklinkRow>, DomainError> =>
  Effect.gen(function* () {
    const { edges } = yield* client.listBacklinks(new ListBacklinksInput({ workspaceId, nodeId }))
    return yield* Effect.forEach(edges, (edge) =>
      client
        .getNode(new GetNodeInput({ workspaceId, nodeId: edge.sourceNodeId }))
        .pipe(
          Effect.map(
            (output): BacklinkRow => ({
              edgeId: edge.id,
              sourceNodeId: edge.sourceNodeId,
              sourceTitle: output.node.title
            })
          )
        )
    )
  })

export function Backlinks({ nodeId }: { nodeId: EntityId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [title, setTitle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  const backlinksEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => loadBacklinks(client, nodeId))),
    [nodeId, refreshKey]
  )
  const state = useEffectQuery(backlinksEffect, [nodeId, refreshKey])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0) return

    setSubmitting(true)
    setLinkError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const relationDefinitionId = yield* ensureMentionsRelationDefinition(client, workspaceId)
            const { node } = yield* client.createNode(new CreateNodeInput({ workspaceId, title: trimmed }))
            yield* client.createEdge(
              new CreateEdgeInput({
                workspaceId,
                relationDefinitionId,
                sourceNodeId: node.id,
                targetNodeId: nodeId
              })
            )
          })
        )
      )
    )
    fiber.addObserver((exit) => {
      setSubmitting(false)
      if (Exit.isSuccess(exit)) {
        setTitle("")
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setLinkError(formatDomainError(failure))
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <section className="backlinks">
      <h3>Backlinks</h3>

      {state.status === "loading" && <p>Loading…</p>}
      {state.status === "failure" && <p className="error">{formatDomainError(state.error)}</p>}
      {state.status === "success" && state.value.length === 0 && <p>No backlinks yet.</p>}
      {state.status === "success" && state.value.length > 0 && (
        <ul>
          {/* Retrieval pass (design-review 2026-08-22 finding #1): backlink entries are real
              links to the source node's view — they were inert `<strong>` text before, one of the
              review's Flow-3 dead ends. */}
          {state.value.map((row) => (
            <li key={row.edgeId}>
              <Link className="backlink-source-link" to={`/node/${row.sourceNodeId}`}>
                {row.sourceTitle}
              </Link>{" "}
              <small>mentions this note</small>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="link-form">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="New node title — links here as a backlink"
          aria-label="New node title"
          disabled={submitting}
        />
        <button type="submit" disabled={submitting || title.trim().length === 0}>
          {submitting ? "Linking…" : "Create + link"}
        </button>
      </form>
      {linkError !== null && <p className="error">{linkError}</p>}
    </section>
  )
}
