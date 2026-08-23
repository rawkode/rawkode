import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  AcceptChatForkInput,
  ChatForkPreviewInput,
  CreateChatInput,
  GetChatInput,
  ListChatsInput,
  ListPendingChangesInput,
  MergeChangesInput,
  RevertChangesInput,
  RevertChatForkInput,
  SendChatMessageInput,
  type Chat,
  type ChatMessageRecord,
  type DomainError,
  type Edge,
  type EntityId,
  type Fact,
  type Node as NodeEntity
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { isModelUnavailable, setModelUnavailable, subscribeModelAvailability } from "./model-availability.js"

// Web-stage task ("Extend the web app... 1. A chat UI... 2. An accept/revert UI... 3. ...the chat
// UI must clearly and correctly handle/display a 'model not configured' state"). Talks to the
// real `AgentEditService` RPC surface added to `rpc-client.ts` (createChat/listChats/getChat/
// sendChatMessage/mergeChanges/revertChanges/listChatChanges/listPendingChanges).
// `listPendingChanges` is this stage's one backend addition (agent-edit-rpc.ts, backend/
// agent-edit-service-live.ts, workspace-durable-object.ts) — added after real browser verification
// (see this stage's report) showed `listChatChanges` is the wrong data source for an accept/
// revert UI: it's a permanent audit trail (every `ChangesMessage` batch a chat ever produced,
// forever), not "what's still pending right now" — see `ListPendingChangesOutput`'s own doc
// comment in agent-edit-rpc.ts for the full story. Everything else here is web-only, per the
// hard constraint to extend rather than restructure what the prior stages already built.
//
// Real-time mechanism (task's own call to make): polling via `useEffectQuery` + a `refreshKey`
// bump, the same pattern `Backlinks.tsx`/`GraphView.tsx` already use for post-mutation refresh —
// not a live `subscribeToNodes`-style subscription. A chat turn is a single request/response
// RPC call (`sendChatMessage` runs the whole tool-calling loop server-side and returns once,
// per its own doc comment in agent-edit-rpc.ts), so there's no server-push stream to subscribe
// to yet — refetching `getChat`/`listPendingChanges` after every mutation (send/merge/revert) is
// both simpler and a faithful match to what the RPC surface actually offers today. A live
// `subscribeToChat`-style push is a natural future addition, not something to fake here.

/**
 * Detects the one real state this environment is actually in (hard constraint: no
 * `ANTHROPIC_API_KEY` exists here) — a `sendChatMessage` failure whose `ModelClient.converse`
 * call failed with `ModelUnavailable`. `model-client.ts`'s own doc comment explains why this
 * isn't a distinct `DomainError` tag: "`ModelClient` is consumed server-side... deliberately not
 * done speculatively" — so the only signal available at this boundary is the `UnexpectedError`
 * message text `agent-edit-service-live.ts`'s `sendChatMessage` actually produces
 * (`` `ModelClient.converse failed: ${modelError._tag}: ${modelError.message}` ``, `_tag` is
 * always `"ModelUnavailable"` for both real causes: no API key configured, or — scripted-double
 * verification only — a script that ran out of turns). String-matching a message is fragile in
 * general, but this exact string is a stable contract of that one call site, not an incidental
 * log message, and is called out explicitly here rather than silently relied on.
 */
const isModelUnavailableError = (error: DomainError): boolean =>
  error._tag === "UnexpectedError" && error.message.includes("ModelClient.converse failed: ModelUnavailable")

const formatDomainError = (error: DomainError): string => {
  switch (error._tag) {
    case "ChatNotFound":
      return `Chat not found: ${error.chatId}`
    case "ChatBindingNotFound":
      return `No binding named "${error.name}" in this chat`
    case "PendingNameConflict":
      return `Name "${error.name}" is already pending in another chat`
    case "ToolNotImplemented":
      return error.message
    default:
      return error.message
  }
}

/** One dispatched tool call, decoded from a `"tool"`-role `ChatMessageRecord.content` (JSON
 *  stringified by `agent-edit-service-live.ts`'s `executeToolCall`: `{toolUseId, entityIds,
 *  result, isError}`) — see that file's `addChatMessage(chatId, "tool", JSON.stringify(...))`
 *  call. Decoded defensively (this is untrusted-shape JSON from the client's own point of view,
 *  even though the server always writes this exact shape) so a malformed row degrades to a
 *  fallback render instead of crashing the whole panel. */
interface ToolLogEntry {
  readonly toolUseId: string
  readonly entityIds: ReadonlyArray<string>
  readonly result: string
  readonly isError: boolean
}

const decodeToolLogEntry = (content: string): ToolLogEntry | undefined => {
  try {
    const raw: unknown = JSON.parse(content)
    if (
      typeof raw === "object" &&
      raw !== null &&
      "toolUseId" in raw &&
      "result" in raw &&
      typeof (raw as { toolUseId: unknown }).toolUseId === "string" &&
      typeof (raw as { result: unknown }).result === "string"
    ) {
      const r = raw as { toolUseId: string; result: string; entityIds?: unknown; isError?: unknown }
      return {
        toolUseId: r.toolUseId,
        result: r.result,
        entityIds: Array.isArray(r.entityIds) ? r.entityIds.filter((v): v is string => typeof v === "string") : [],
        isError: r.isError === true
      }
    }
  } catch {
    // fall through to undefined below
  }
  return undefined
}

/**
 * Extracts the `nodeId` an `editNote` tool call forked, from that call's already-decoded
 * `ToolLogEntry.result` (a JSON-stringified `EditNoteToolOutput`, per
 * `agent-edit-service-live.ts`'s `executeToolCall` — `resultText: JSON.stringify(output)`).
 * `EditNoteToolOutput.nodeId` is the adversarial-review fix that makes this discoverable at all —
 * see that schema's own doc comment in `agent-tools.ts` for why it isn't carried via
 * `ToolLogEntry.entityIds` instead. Defensive like `decodeToolLogEntry` itself: a malformed/older
 * log entry degrades to `undefined` rather than throwing.
 */
const decodeEditNoteNodeId = (entry: ToolLogEntry): EntityId | undefined => {
  try {
    const raw: unknown = JSON.parse(entry.result)
    if (typeof raw === "object" && raw !== null && "nodeId" in raw) {
      const nodeId = (raw as { nodeId: unknown }).nodeId
      return typeof nodeId === "string" ? (nodeId as EntityId) : undefined
    }
  } catch {
    // fall through to undefined below
  }
  return undefined
}

// --- Chat message log ---------------------------------------------------------------------------

function ChatMessageRow({
  message,
  toolNameByCallId
}: {
  readonly message: ChatMessageRecord
  readonly toolNameByCallId: ReadonlyMap<string, string>
}) {
  if (message.role === "tool") {
    const entry = decodeToolLogEntry(message.content)
    if (entry === undefined) {
      return (
        <li className="chat-message chat-message-tool">
          <span className="chat-message-role">tool</span>
          <span className="chat-message-content">{message.content}</span>
        </li>
      )
    }
    const toolName = toolNameByCallId.get(entry.toolUseId) ?? "tool"
    return (
      <li className={`chat-message chat-message-tool${entry.isError ? " chat-message-tool-error" : ""}`}>
        <span className="chat-message-role">{entry.isError ? "✗" : "✓"} {toolName}</span>
        <span className="chat-message-content">{entry.result}</span>
      </li>
    )
  }

  return (
    <li className={`chat-message chat-message-${message.role}`}>
      <span className="chat-message-role">{message.role === "user" ? "you" : "agent"}</span>
      {message.toolCalls !== undefined && message.toolCalls.length > 0 && (
        <ul className="chat-tool-calls">
          {message.toolCalls.map((call) => (
            <li key={call.id}>
              → calling <code>{call.name}</code>
              <code className="chat-tool-call-input">{JSON.stringify(call.input)}</code>
            </li>
          ))}
        </ul>
      )}
      {message.content.length > 0 && <span className="chat-message-content">{message.content}</span>}
    </li>
  )
}

// --- One selected chat: message log, send box, pending-changes accept/revert --------------------

function ActiveChatView({ chatId }: { readonly chatId: EntityId }) {
  const [refreshKey, setRefreshKey] = useState(0)
  const [messageText, setMessageText] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<DomainError | null>(null)
  // Interaction pass (finding #18 / flows F4.1): the no-model state is no longer per-send local
  // state here — it lives in `model-availability.ts`'s persistent store and renders as a standing
  // banner at the panel level (`ChatPanel` below), so it survives navigation, chat switches, and
  // reloads instead of evaporating with this component's state.
  const [mergeRevertBusy, setMergeRevertBusy] = useState<"merge" | "revert" | null>(null)
  const [mergeRevertError, setMergeRevertError] = useState<string | null>(null)
  // Adversarial-review fix: note-body (`editNote`) pending edits, reviewed/accepted/reverted via
  // `chatForkPreview`/`acceptChatFork`/`revertChatFork` — see this section's own comment further
  // down for why this is a second, separate mechanism from `mergeRevertBusy`/`mergeRevertError`
  // above. `noteForkBusyKey` is `` `${kind}:${nodeId}` `` (not just `kind`) since — unlike the
  // structured-pending accept/revert above, which always acts on the chat's whole pending set at
  // once — a chat can have more than one node forked at a time, and only the one button actually
  // clicked should show a busy state.
  const [noteForkBusyKey, setNoteForkBusyKey] = useState<string | null>(null)
  const [noteForkError, setNoteForkError] = useState<string | null>(null)

  const chatEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.getChat(new GetChatInput({ chatId })))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, refreshKey]
  )
  const chatState = useEffectQuery(chatEffect, [chatId, refreshKey])

  const pendingEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.listPendingChanges(new ListPendingChangesInput({ chatId })))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, refreshKey]
  )
  const pendingState = useEffectQuery(pendingEffect, [chatId, refreshKey])

  // Reset per-chat transient state when switching chats (deliberately keyed on `chatId`, not
  // `refreshKey` — a send/merge/revert on the *same* chat shouldn't clear the message the user is
  // currently typing or a still-relevant error).
  useEffect(() => {
    setMessageText("")
    setSending(false)
    setSendError(null)
    setMergeRevertError(null)
    setNoteForkError(null)
  }, [chatId])

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = messageText.trim()
    if (trimmed.length === 0) return

    setSending(true)
    setSendError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.sendChatMessage(new SendChatMessageInput({ chatId, text: trimmed })))
      )
    )
    fiber.addObserver((exit) => {
      setSending(false)
      if (Exit.isSuccess(exit)) {
        // A successful turn is the one real "a model IS configured" signal available at this
        // boundary (see model-availability.ts) — clear any standing no-model banner.
        setModelUnavailable(false)
        setMessageText("")
        setRefreshKey((k) => k + 1)
      } else {
        // Same `Cause.squash` recovery `use-effect-query.ts`/`use-effect-subscription.ts` use to
        // pull a typed failure out of a `Cause` — this is a one-shot mutation fiber (not a
        // hook-managed query), so it's done inline here rather than via those hooks.
        const failure = Cause.squash(exit.cause) as DomainError
        if (isModelUnavailableError(failure)) {
          // The user's message was still persisted server-side (`sendChatMessage` appends it
          // *before* calling `ModelClient.converse` — see agent-edit-service-live.ts) — refetch
          // so it shows up in the log even though this call itself failed, instead of the UI
          // silently swallowing something that really did happen. Clear the input too (unlike
          // the generic-error branch below, which deliberately leaves the draft in place for a
          // retry) — the text is already saved, so leaving it in the box would misleadingly
          // suggest it still needs sending. The flag itself goes to the persistent
          // model-availability store — rendered as the panel-level banner, cleared by the next
          // successful send.
          setModelUnavailable(true)
          setMessageText("")
          setRefreshKey((k) => k + 1)
        } else {
          setSendError(failure)
          console.error(exit.cause.toString())
        }
      }
    })
  }

  const runMergeOrRevert = (kind: "merge" | "revert", sequences: ReadonlyArray<number>) => {
    if (sequences.length === 0) return
    setMergeRevertBusy(kind)
    setMergeRevertError(null)

    // Both branches are narrowed to `void` (`Effect.asVoid`) purely so they type-unify into one
    // `program` — the two RPC calls' success payloads (`{chatId, mergeThrough}` vs.
    // `{chatId, revertFrom}`) are otherwise structurally different and neither is needed here;
    // `runMergeOrRevert` only cares whether the call succeeded, not its echoed-back input.
    const program =
      kind === "merge"
        ? WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.mergeChanges(new MergeChangesInput({ chatId, mergeThrough: Math.max(...sequences) }))
            ),
            Effect.asVoid
          )
        : WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.revertChanges(new RevertChangesInput({ chatId, revertFrom: Math.min(...sequences) }))
            ),
            Effect.asVoid
          )

    const fiber = runtime.runFork(program)
    fiber.addObserver((exit) => {
      setMergeRevertBusy(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setMergeRevertError(
          `Failed to ${kind === "merge" ? "accept" : "revert"} changes: ${formatDomainError(failure)}`
        )
        console.error(exit.cause.toString())
      }
    })
  }

  const messages = chatState.status === "success" ? chatState.value.messages : []
  const pendingNodes: ReadonlyArray<NodeEntity> = pendingState.status === "success" ? pendingState.value.nodes : []
  const pendingFacts: ReadonlyArray<Fact> = pendingState.status === "success" ? pendingState.value.facts : []
  const pendingEdges: ReadonlyArray<Edge> = pendingState.status === "success" ? pendingState.value.edges : []
  const pendingCount = pendingNodes.length + pendingFacts.length + pendingEdges.length
  // `mergeChanges(chatId, mergeThrough)`/`revertChanges(chatId, revertFrom)` both operate over a
  // `PendingMarker.sequence` range (§Q15) — every currently-pending item's stamped sequence,
  // pooled across nodes/facts/edges, is what "accept/revert everything shown below" needs.
  // `sequence` is only ever absent in the brief crash window before a turn's flush stamps it
  // (node.ts's own doc comment) — filtered out here since there's nothing yet for this UI to act
  // on for an unstamped record; it becomes actionable once reconciled.
  const pendingSequences = [...pendingNodes, ...pendingFacts, ...pendingEdges]
    .map((entity) => entity.pending?.sequence)
    .filter((sequence): sequence is number => sequence !== undefined)

  const toolNameByCallId = useMemo(() => {
    const map = new Map<string, string>()
    for (const message of messages) {
      if (message.toolCalls === undefined) continue
      for (const call of message.toolCalls) map.set(call.id, call.name)
    }
    return map
  }, [messages])

  // --- Note-body (`editNote`) pending edits — the chat-fork mechanism ------------------------
  //
  // Distinct node ids this chat has ever run `editNote` against, scanned out of the chat's own
  // "tool"-role log entries (`decodeEditNoteNodeId`'s own doc comment explains the mechanism —
  // `EditNoteToolOutput.nodeId`, an adversarial-review addition). This is a candidate set, not a
  // "currently pending" set: a chat's history includes edits already accepted/reverted in earlier
  // turns too, so every candidate is re-checked against the real, live `chatForkPreview` state
  // below rather than assumed still active.
  const forkNodeIds = useMemo(() => {
    const ids = new Set<EntityId>()
    for (const message of messages) {
      if (message.role !== "tool") continue
      const entry = decodeToolLogEntry(message.content)
      if (entry === undefined || toolNameByCallId.get(entry.toolUseId) !== "editNote") continue
      const nodeId = decodeEditNoteNodeId(entry)
      if (nodeId !== undefined) ids.add(nodeId)
    }
    return [...ids]
  }, [messages, toolNameByCallId])
  const forkNodeIdsKey = forkNodeIds.join(",")

  // The live, authoritative "is this still forked" answer per candidate — `chatForkPreview` never
  // falls back to mainline text (its own doc comment), so `forked: true` here means a real,
  // currently-open fork this UI can act on right now.
  const forksEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.forEach(forkNodeIds, (nodeId) =>
            client
              .chatForkPreview(new ChatForkPreviewInput({ workspaceId, chatId, nodeId }))
              .pipe(Effect.map((preview) => ({ nodeId, forked: preview.forked, text: preview.text })))
          )
        ),
        Effect.map((previews) => previews.filter((preview) => preview.forked))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, refreshKey, forkNodeIdsKey]
  )
  const forksState = useEffectQuery(forksEffect, [chatId, refreshKey, forkNodeIdsKey])
  const pendingForks = forksState.status === "success" ? forksState.value : []

  const runForkAction = (kind: "accept" | "revert", nodeId: EntityId) => {
    const key = `${kind}:${nodeId}`
    setNoteForkBusyKey(key)
    setNoteForkError(null)

    const program =
      kind === "accept"
        ? WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => client.acceptChatFork(new AcceptChatForkInput({ workspaceId, chatId, nodeId }))),
            Effect.asVoid
          )
        : WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => client.revertChatFork(new RevertChatForkInput({ workspaceId, chatId, nodeId }))),
            Effect.asVoid
          )

    const fiber = runtime.runFork(program)
    fiber.addObserver((exit) => {
      setNoteForkBusyKey(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setNoteForkError(
          `Failed to ${kind === "accept" ? "accept" : "revert"} note edit: ${formatDomainError(failure)}`
        )
        console.error(exit.cause.toString())
      }
    })
  }

  return (
    <div className="chat-active">
      <ul className="chat-messages">
        {chatState.status === "loading" && <li>Loading…</li>}
        {chatState.status === "failure" && <li className="error">{formatDomainError(chatState.error)}</li>}
        {messages
          .filter((m) => m.role !== "tool" || decodeToolLogEntry(m.content) !== undefined)
          .map((message) => (
            <ChatMessageRow key={message.id} message={message} toolNameByCallId={toolNameByCallId} />
          ))}
      </ul>

      <form onSubmit={handleSend} className="chat-send-form">
        <input
          value={messageText}
          onChange={(event) => setMessageText(event.target.value)}
          placeholder="Message the agent…"
          aria-label="Message the agent"
          disabled={sending}
        />
        <button type="submit" disabled={sending || messageText.trim().length === 0}>
          {sending ? "Sending…" : "Send"}
        </button>
      </form>
      {sendError !== null && <p className="error">{formatDomainError(sendError)}</p>}

      {/* Structured pending records only (nodes/facts/edges via `mergeChanges`/`revertChanges`).
          Note-body edits (`editNote`) are a deliberately separate mechanism — a per-chat
          Automerge fork, accepted/reverted via `acceptChatFork`/`revertChatFork`
          (chat-fork-rpc.ts), not this `pending`-flag/`changes`-sequence one (plan: "deliberately
          not folded into mergeChanges/revertChanges") — so they don't appear here; their own
          "Pending note edits" section below is the fork-preview UI this comment used to say was
          future work (adversarial-review fix). */}
      <section className="chat-pending">
        <h4>Pending changes {pendingCount > 0 && <span className="chat-pending-count">{pendingCount}</span>}</h4>
        {pendingState.status === "loading" && <p>Loading…</p>}
        {pendingState.status === "failure" && <p className="error">{formatDomainError(pendingState.error)}</p>}
        {pendingState.status === "success" && pendingCount === 0 && (
          <p className="chat-pending-empty">Nothing pending — accepted or reverted changes disappear from here.</p>
        )}
        {pendingCount > 0 && (
          <>
            <ul className="chat-pending-list">
              {pendingNodes.map((n) => (
                <li key={`node-${n.id}`}>
                  <span className="chat-pending-kind">node</span> {n.title}
                </li>
              ))}
              {pendingFacts.map((f) => (
                <li key={`fact-${f.id}`}>
                  <span className="chat-pending-kind">fact</span> {f.predicateId} on node {f.nodeId}
                </li>
              ))}
              {pendingEdges.map((e) => (
                <li key={`edge-${e.id}`}>
                  <span className="chat-pending-kind">edge</span> {e.sourceNodeId} → {e.targetNodeId}
                </li>
              ))}
            </ul>
            <div className="chat-pending-actions">
              <button
                type="button"
                onClick={() => runMergeOrRevert("merge", pendingSequences)}
                disabled={mergeRevertBusy !== null}
              >
                {mergeRevertBusy === "merge" ? "Accepting…" : "Accept"}
              </button>
              <button
                type="button"
                className="chat-pending-revert"
                onClick={() => runMergeOrRevert("revert", pendingSequences)}
                disabled={mergeRevertBusy !== null}
              >
                {mergeRevertBusy === "revert" ? "Reverting…" : "Revert"}
              </button>
            </div>
            {mergeRevertError !== null && <p className="error">{mergeRevertError}</p>}
          </>
        )}
      </section>

      {/* Note-body edits (`editNote`) — the Phase 3 Automerge-fork mechanism (chat-fork-rpc.ts /
          docs/automerge-fork-spike.md), deliberately separate from the structured-pending section
          above (see that section's own comment). Only rendered once there's at least one
          candidate to check, so an ordinary chat with no note edits shows nothing extra. */}
      {forkNodeIds.length > 0 && (
        <section className="chat-pending chat-note-forks">
          <h4>
            Pending note edits {pendingForks.length > 0 && <span className="chat-pending-count">{pendingForks.length}</span>}
          </h4>
          {forksState.status === "loading" && <p>Loading…</p>}
          {forksState.status === "failure" && <p className="error">{formatDomainError(forksState.error)}</p>}
          {forksState.status === "success" && pendingForks.length === 0 && (
            <p className="chat-pending-empty">No note edits pending — accepted or reverted edits disappear from here.</p>
          )}
          {pendingForks.map((fork) => {
            const acceptKey = `accept:${fork.nodeId}`
            const revertKey = `revert:${fork.nodeId}`
            const busy = noteForkBusyKey === acceptKey || noteForkBusyKey === revertKey
            return (
              <div key={fork.nodeId} className="chat-note-fork">
                <p className="chat-note-fork-node">
                  <span className="chat-pending-kind">note</span> node {fork.nodeId}
                </p>
                <pre className="chat-note-fork-preview">{fork.text}</pre>
                <div className="chat-pending-actions">
                  <button type="button" onClick={() => runForkAction("accept", fork.nodeId)} disabled={busy}>
                    {noteForkBusyKey === acceptKey ? "Accepting…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="chat-pending-revert"
                    onClick={() => runForkAction("revert", fork.nodeId)}
                    disabled={busy}
                  >
                    {noteForkBusyKey === revertKey ? "Reverting…" : "Revert"}
                  </button>
                </div>
              </div>
            )
          })}
          {noteForkError !== null && <p className="error">{noteForkError}</p>}
        </section>
      )}
    </div>
  )
}

// --- Chat list + create — the panel's outer shell ------------------------------------------------

export function ChatPanel() {
  const [refreshKey, setRefreshKey] = useState(0)
  // Interaction pass (finding #18 / flows F4.1): standing "no model" banner state — read from the
  // persistent store (localStorage-backed, updated by `ActiveChatView`'s send outcomes) so it
  // survives navigation and reloads instead of living in one send's transient reply.
  const modelUnavailable = useSyncExternalStore(subscribeModelAvailability, isModelUnavailable)
  const [activeChatId, setActiveChatId] = useState<EntityId | null>(null)
  const [newChatTitle, setNewChatTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const listChatsEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listChats(new ListChatsInput({ workspaceId })))),
    [refreshKey]
  )
  const chatsState = useEffectQuery(listChatsEffect, [refreshKey])

  useEffect(() => {
    if (activeChatId !== null || chatsState.status !== "success" || chatsState.value.chats.length === 0) return
    setActiveChatId(chatsState.value.chats[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatsState])

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = newChatTitle.trim()
    if (trimmed.length === 0) return

    setCreating(true)
    setCreateError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.createChat(new CreateChatInput({ workspaceId, title: trimmed }))))
    )
    fiber.addObserver((exit) => {
      setCreating(false)
      if (Exit.isSuccess(exit)) {
        setNewChatTitle("")
        setActiveChatId(exit.value.chat.id)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        const failure = Cause.squash(exit.cause) as DomainError
        setCreateError(`Failed to create chat: ${formatDomainError(failure)}`)
        console.error(exit.cause.toString())
      }
    })
  }

  const chats: ReadonlyArray<Chat> = chatsState.status === "success" ? chatsState.value.chats : []

  return (
    <section className="chat-panel">
      <h2>Agent chat</h2>

      {modelUnavailable && (
        <p className="chat-model-unavailable" role="status">
          <strong>No AI model configured.</strong> Messages are saved, but the agent can't reply —
          the backend has no <code>ANTHROPIC_API_KEY</code> configured (expected in this
          environment). Configure one with <code>wrangler secret put ANTHROPIC_API_KEY</code>{" "}
          against the <code>backend</code> Worker to enable real replies.
        </p>
      )}

      <div className="chat-panel-body">
        <div className="chat-list">
          {chatsState.status === "loading" && <p>Loading…</p>}
          {chatsState.status === "failure" && <p className="error">{formatDomainError(chatsState.error)}</p>}
          <ul>
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className={`chat-list-item${chat.id === activeChatId ? " chat-list-item-active" : ""}`}
                  onClick={() => setActiveChatId(chat.id)}
                >
                  {chat.title}
                </button>
              </li>
            ))}
            {chats.length === 0 && chatsState.status === "success" && <li className="chat-list-empty">No chats yet.</li>}
          </ul>

          <form onSubmit={handleCreate} className="chat-create-form">
            <input
              value={newChatTitle}
              onChange={(event) => setNewChatTitle(event.target.value)}
              placeholder="New chat title"
              aria-label="New chat title"
              disabled={creating}
            />
            <button type="submit" disabled={creating || newChatTitle.trim().length === 0}>
              {creating ? "Creating…" : "New chat"}
            </button>
          </form>
          {createError !== null && <p className="error">{createError}</p>}
        </div>

        {activeChatId !== null ? (
          <ActiveChatView key={activeChatId} chatId={activeChatId} />
        ) : (
          <p className="chat-active-empty">Create a chat to get started.</p>
        )}
      </div>
    </section>
  )
}
