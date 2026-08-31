import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import {
  AcceptChatForkInput,
  CreateChatInput,
  DecideChatReviewInput,
  GetChatReviewInput,
  ListChatsInput,
  RevertChatForkInput,
  SendChatMessageInput,
  type Chat,
  type ChatMessageRecord,
  type DomainError,
  type EntityId
} from "@athenaeum/domain"
import { runtime } from "./runtime.js"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { useEffectQuery } from "./use-effect-query.js"
import { workspaceId } from "./workspace-id.js"
import { isModelUnavailable, setModelUnavailable, subscribeModelAvailability } from "./model-availability.js"
import { chatTitleFromMessage } from "./chat-title.js"
import { decodeToolLogEntry } from "./chat-fork-routing.js"
import { chatReviewPresentationWitness, isNoteForkReviewItem, visibleReviewLabel } from "./chat-review-presentation.js"

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
// to yet — refetching `getChat`/`getChatReview` after every mutation (send/merge/revert) is
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

const namedChatCreationFailureMessage =
  "We couldn’t confirm that this chat was created. The title is still here. Review your chats before taking another action."

const firstMessageChatCreationFailureMessage =
  "We couldn’t confirm that a chat was started. Your message is still here. Review your chats before taking another action."

const firstMessageSendFailureMessage =
  "The chat is open, but we couldn’t confirm that the first message was sent. Review the chat before taking another action."

const activeChatSendFailureMessage =
  "We couldn’t confirm that your message was sent. Your draft is still here. Review the chat before taking another action."

const pendingChangesFailureMessage = (kind: "merge" | "revert"): string =>
  kind === "merge"
    ? "We couldn’t confirm that these changes were accepted. Review the pending changes before taking another action."
    : "We couldn’t confirm that these changes were reverted. Review the pending changes before taking another action."

const legacyForkDecisionFailureMessage = (kind: "accept" | "revert"): string =>
  kind === "accept"
    ? "We couldn’t confirm that this note edit was accepted. Review the pending note edit before taking another action."
    : "We couldn’t confirm that this note edit was reverted. Review the pending note edit before taking another action."

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
    const toolStatus = entry.isError === true ? "✗" : entry.isError === false ? "✓" : "?"
    return (
      <li className={`chat-message chat-message-tool${entry.isError === true ? " chat-message-tool-error" : ""}`}>
        <span className="chat-message-role">{toolStatus} {toolName}</span>
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
  const [sendError, setSendError] = useState<string | null>(null)
  const isSendingRef = useRef(false)
  // Interaction pass (finding #18 / flows F4.1): the no-model state is no longer per-send local
  // state here — it lives in `model-availability.ts`'s persistent store and renders as a standing
  // banner at the panel level (`ChatPanel` below), so it survives navigation, chat switches, and
  // reloads instead of evaporating with this component's state.
  const [mergeRevertBusy, setMergeRevertBusy] = useState<"merge" | "revert" | null>(null)
  const [mergeRevertError, setMergeRevertError] = useState<string | null>(null)
  const mergeRevertBusyRef = useRef<"merge" | "revert" | null>(null)
  // Adversarial-review fix: note-body (`editNote`) pending edits, reviewed/accepted/reverted via
  // `chatForkPreview`/`acceptChatFork`/`revertChatFork` — see this section's own comment further
  // down for why this is a second, separate mechanism from `mergeRevertBusy`/`mergeRevertError`
  // above. `noteForkBusyKey` is `` `${kind}:${nodeId}` `` (not just `kind`) since — unlike the
  // structured-pending accept/revert above, which always acts on the chat's whole pending set at
  // once — a chat can have more than one node forked at a time, and only the one button actually
  // clicked should show a busy state.
  const [noteForkBusyKey, setNoteForkBusyKey] = useState<string | null>(null)
  const [noteForkError, setNoteForkError] = useState<string | null>(null)
  const noteForkBusyNodeIdsRef = useRef(new Set<EntityId>())
  const reviewWitnessRef = useRef<string | undefined>(undefined)
  const rawReviewWitnessRef = useRef<string | undefined>(undefined)
  const reviewRequestKeyRef = useRef(`${chatId}:0`)
  const reviewAwaitingCurrentResultRef = useRef(false)

  // One authoritative review read per chat/refresh. It carries server-resolved, privacy-safe
  // labels and is intentionally not assembled from client-side `getNode` calls: pending rows can
  // themselves be hidden from normal node lists, and per-row resolution races on chat switches.
  const reviewEffect = useMemo(
    () =>
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.getChatReview(new GetChatReviewInput({ chatId })))
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatId, refreshKey]
  )
  const reviewState = useEffectQuery(reviewEffect, [chatId, refreshKey])
  const reviewRequestKey = `${chatId}:${refreshKey}`
  // Render-time invalidation is intentional: a click cannot observe a previous chat/refresh
  // witness in the passive-effect gap between props changing and the new RPC beginning.
  if (reviewRequestKeyRef.current !== reviewRequestKey) {
    reviewRequestKeyRef.current = reviewRequestKey
    reviewAwaitingCurrentResultRef.current = true
    reviewWitnessRef.current = undefined
    rawReviewWitnessRef.current = undefined
  }
  if (reviewState.status === "loading") reviewAwaitingCurrentResultRef.current = false

  const reviewHasUnavailableItems = reviewState.status === "success" &&
    !reviewAwaitingCurrentResultRef.current &&
    reviewState.value.chat?.id === chatId &&
    reviewState.value.items
      .filter((item) => !isNoteForkReviewItem(item))
      .some((item) => !item.stamped || !item.targetAvailable || !item.actionable)

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
    if (isSendingRef.current) return
    isSendingRef.current = true

    setSending(true)
    setSendError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) => client.sendChatMessage(new SendChatMessageInput({ chatId, text: trimmed })))
      )
    )
    fiber.addObserver((exit) => {
      isSendingRef.current = false
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
          setSendError(activeChatSendFailureMessage)
        }
      }
    })
  }

  const runMergeOrRevert = (
    kind: "merge" | "revert",
    sequences: ReadonlyArray<number>,
    witness: string | undefined
  ) => {
    // Do not decide a change from an incomplete or invalidated review snapshot.
    if (
      sequences.length === 0 ||
      witness === undefined ||
      rawReviewWitnessRef.current !== witness ||
      (kind === "merge" && reviewHasUnavailableItems) ||
      mergeRevertBusyRef.current !== null
    ) return
    mergeRevertBusyRef.current = kind
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
              client.decideChatReview(new DecideChatReviewInput({ chatId, operation: "accept", sequenceBoundary: Math.max(...sequences), expectedWitness: witness, requestId: crypto.randomUUID(), message: "Accepted reviewed agent changes.", provenance: "chat-review-web" }))
            ),
            Effect.asVoid
          )
        : WorkspaceRpcClient.pipe(
            Effect.flatMap((client) =>
              client.decideChatReview(new DecideChatReviewInput({ chatId, operation: "revert", sequenceBoundary: Math.min(...sequences), expectedWitness: witness, requestId: crypto.randomUUID(), message: "Reverted reviewed agent changes.", provenance: "chat-review-web" }))
            ),
            Effect.asVoid
          )

    const fiber = runtime.runFork(program)
    fiber.addObserver((exit) => {
      mergeRevertBusyRef.current = null
      setMergeRevertBusy(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setMergeRevertError(pendingChangesFailureMessage(kind))
      }
    })
  }

  // The response's `chat` and stable SHA-256 witnesses fence a cancelled/stale query before it
  // reaches the UI. `useEffectQuery` interrupts old fibers; this additional check is needed for
  // a response that completes at the same time as a chat switch.
  const review = reviewState.status === "success" && !reviewAwaitingCurrentResultRef.current && reviewState.value.chat?.id === chatId
    ? reviewState.value
    : undefined
  const messages = review?.messages ?? []
  const reviewPresentationWitness = review === undefined
    ? undefined
    : chatReviewPresentationWitness({
        chatId: review.chat.id,
        witness: review.witness,
        noteForkWitness: review.noteForkWitness,
        items: review.items
      })
  // Private control state only. A chat switch or mutation refresh synchronously invalidates the
  // previous witness before the next review response can enable a decision.
  reviewWitnessRef.current = reviewPresentationWitness
  rawReviewWitnessRef.current = review?.witness
  const pendingItems = review?.items.filter((item) => !isNoteForkReviewItem(item)) ?? []
  // Only complete legacy previews become action rows. The lane discriminator still keeps hidden
  // or unavailable legacy rows out of the structured lane while `legacyReviewHasGap` exposes the
  // missing work without manufacturing an action target.
  const pendingForks = review?.items.filter((item) => isNoteForkReviewItem(item) && item.forkPreviewLines !== undefined) ?? []
  const legacyReviewHasGap = review?.legacyForks.truncated === true || (review?.legacyForks.unavailable ?? 0) > 0
  const pendingCount = pendingItems.length
  // `mergeChanges(chatId, mergeThrough)`/`revertChanges(chatId, revertFrom)` both operate over a
  // `PendingMarker.sequence` range (§Q15) — every currently-pending item's stamped sequence,
  // pooled across nodes/facts/edges, is what "accept/revert everything shown below" needs.
  // `sequence` is only ever absent in the brief crash window before a turn's flush stamps it
  // (node.ts's own doc comment) — filtered out here since there's nothing yet for this UI to act
  // on for an unstamped record; it becomes actionable once reconciled.
  const pendingSequences = pendingItems.map((item) => item.sequence)

  const toolNameByCallId = useMemo(() => {
    const map = new Map<string, string>()
    for (const message of messages) {
      if (message.toolCalls === undefined) continue
      for (const call of message.toolCalls) map.set(call.id, call.name)
    }
    return map
  }, [messages])

  const runForkAction = (kind: "accept" | "revert", nodeId: EntityId, expectedPreviewDigest?: string) => {
    if (noteForkBusyNodeIdsRef.current.has(nodeId)) return
    noteForkBusyNodeIdsRef.current.add(nodeId)
    const key = `${kind}:${nodeId}`
    setNoteForkBusyKey(key)
    setNoteForkError(null)

    const program =
      kind === "accept"
        ? WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => client.acceptChatFork(new AcceptChatForkInput({ workspaceId, chatId, nodeId, expectedPreviewDigest }))),
            Effect.asVoid
          )
        : WorkspaceRpcClient.pipe(
            Effect.flatMap((client) => client.revertChatFork(new RevertChatForkInput({ workspaceId, chatId, nodeId }))),
            Effect.asVoid
          )

    const fiber = runtime.runFork(program)
    fiber.addObserver((exit) => {
      noteForkBusyNodeIdsRef.current.delete(nodeId)
      setNoteForkBusyKey(null)
      if (Exit.isSuccess(exit)) {
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setNoteForkError(legacyForkDecisionFailureMessage(kind))
      }
    })
  }

  return (
    <div className="chat-active">
      <ul className="chat-messages">
        {reviewState.status === "loading" && <li>Loading…</li>}
        {reviewState.status === "failure" && (
          <li className="chat-active-load-state" role="alert">
            <p>This chat couldn’t be loaded. Your message composer remains available. Retry to check it again.</p>
            <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>
              Retry
            </button>
          </li>
        )}
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
      {sendError !== null && (
        <p className="error chat-send-error" role="alert">
          {sendError}
        </p>
      )}

      {/* Structured pending records only (nodes/facts/edges via `mergeChanges`/`revertChanges`).
          Explicit legacy note-body edits (`editNote` on an automerge-v1 page) are a deliberately
          separate mechanism — a per-chat Automerge fork, accepted/reverted via
          `acceptChatFork`/`revertChatFork`
          (chat-fork-rpc.ts), not this `pending`-flag/`changes`-sequence one (plan: "deliberately
          not folded into mergeChanges/revertChanges") — so they don't appear here; their own
          "Pending note edits" section below is the fork-preview UI this comment used to say was
          future work (adversarial-review fix). */}
      {(reviewState.status !== "success" || pendingCount > 0) && (
        <section className="chat-pending">
          <h4>Pending changes {pendingCount > 0 && <span className="chat-pending-count">{pendingCount}</span>}</h4>
          {reviewState.status === "loading" && (
            <p role="status" aria-live="polite" aria-atomic="true">
              Loading pending changes…
            </p>
          )}
          {reviewState.status === "failure" && (
            <div className="error chat-pending-load-state" role="alert">
              <p>Pending changes couldn&rsquo;t be loaded. Nothing has been changed. Retry to review them.</p>
              <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Retry</button>
            </div>
          )}
          {pendingCount > 0 && (
            <>
              <ul className="chat-pending-list">
                {pendingItems.map((item, index) => (
                  <li key={`${item.kind}-${item.sequence}-${index}`}>
                    <span className="chat-pending-kind">{item.kind}</span> {visibleReviewLabel(item)}
                  </li>
                ))}
              </ul>
              <div className="chat-pending-actions">
                <button
                  type="button"
                  onClick={() => runMergeOrRevert("merge", pendingSequences, review?.witness)}
                  disabled={mergeRevertBusy !== null || reviewPresentationWitness === undefined || reviewHasUnavailableItems}
                >
                  {mergeRevertBusy === "merge" ? "Accepting…" : "Accept"}
                </button>
                <button
                  type="button"
                  className="chat-pending-revert"
                  onClick={() => runMergeOrRevert("revert", pendingSequences, review?.witness)}
                  disabled={mergeRevertBusy !== null || reviewPresentationWitness === undefined || reviewHasUnavailableItems}
                >
                  {mergeRevertBusy === "revert" ? "Reverting…" : "Revert"}
                </button>
              </div>
              {mergeRevertError !== null && (
                <p className="error chat-pending-action-error" role="alert">{mergeRevertError}</p>
              )}
            </>
          )}
        </section>
      )}

      {/* Explicit legacy note-body forks (`editNote` on an automerge-v1 page) — deliberately
          separate from the structured-pending section above. Loro edits are already ledgered and
          never appear in this compatibility review card. Only rendered once there's at least one
          candidate to check, so an ordinary chat with no note edits shows nothing extra. */}
      {(reviewState.status !== "success" || pendingForks.length > 0 || legacyReviewHasGap) && (
        <section className="chat-pending chat-note-forks">
          <h4>
            Pending note edits {pendingForks.length > 0 && <span className="chat-pending-count">{pendingForks.length}</span>}
          </h4>
          {reviewState.status === "loading" && (
            <p role="status" aria-live="polite" aria-atomic="true">
              Checking pending note edits…
            </p>
          )}
          {reviewState.status === "failure" && (
            <div className="error chat-note-forks-load-state" role="alert">
              <p>Pending note edits couldn&rsquo;t be checked. Nothing has been changed. Retry to review them.</p>
              <button type="button" onClick={() => setRefreshKey((key) => key + 1)}>Retry</button>
            </div>
          )}
          {reviewState.status === "success" && pendingForks.length === 0 && (
            <p className="chat-pending-empty">{review?.legacyForks.truncated === true || (review?.legacyForks.unavailable ?? 0) > 0 ? "Some pending note edits couldn’t be safely shown. Refresh to review available edits." : "No note edits pending — accepted or reverted edits disappear from here."}</p>
          )}
          {review?.legacyForks.truncated === true && <p className="chat-pending-empty">Only {review.legacyForks.shown} of {review.legacyForks.total} pending note edits are shown.</p>}
          {pendingForks.map((fork, index) => {
            const nodeId = fork.nodeId
            const acceptKey = `accept:${nodeId ?? fork.sequence}`
            const revertKey = `revert:${nodeId ?? fork.sequence}`
            const busy = noteForkBusyKey === acceptKey || noteForkBusyKey === revertKey
            return (
              <div key={fork.nodeId ?? `${fork.kind}-${fork.sequence}-${index}`} className="chat-note-fork">
                <p className="chat-note-fork-node">
                  <span className="chat-pending-kind">note</span> {visibleReviewLabel(fork)}
                </p>
                <pre className="chat-note-fork-preview">{fork.forkPreviewLines?.join("\n")}</pre>
                <div className="chat-pending-actions">
                  <button
                    type="button"
                    onClick={() => nodeId !== undefined && fork.previewDigest !== undefined && runForkAction("accept", nodeId, fork.previewDigest)}
                    disabled={busy || nodeId === undefined || fork.previewDigest === undefined || fork.forkPreviewTruncated === true || fork.targetAvailable === false || fork.actionable === false}
                  >
                    {noteForkBusyKey === acceptKey ? "Accepting…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    className="chat-pending-revert"
                    onClick={() => nodeId !== undefined && runForkAction("revert", nodeId)}
                    disabled={busy || nodeId === undefined || fork.previewDigest === undefined || fork.forkPreviewTruncated === true || fork.targetAvailable === false || fork.actionable === false}
                  >
                    {noteForkBusyKey === revertKey ? "Reverting…" : "Revert"}
                  </button>
                </div>
              </div>
            )
          })}
          {noteForkError !== null && (
            <p className="error chat-note-fork-action-error" role="alert">{noteForkError}</p>
          )}
        </section>
      )}
    </div>
  )
}

// --- Chat list + create — the panel's outer shell ------------------------------------------------

export function ChatPanel() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [listRetryClaimed, setListRetryClaimed] = useState(false)
  const listRetryClaim = useRef<{ sawLoading: boolean } | undefined>(undefined)
  // Interaction pass (finding #18 / flows F4.1): standing "no model" banner state — read from the
  // persistent store (localStorage-backed, updated by `ActiveChatView`'s send outcomes) so it
  // survives navigation and reloads instead of living in one send's transient reply.
  const modelUnavailable = useSyncExternalStore(subscribeModelAvailability, isModelUnavailable)
  const [activeChatId, setActiveChatId] = useState<EntityId | null>(null)
  const [newChatTitle, setNewChatTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const isCreatingNamedChatRef = useRef(false)
  const [firstMessageText, setFirstMessageText] = useState("")
  const [startingChat, setStartingChat] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const isStartingFirstChatRef = useRef(false)

  const listChatsEffect = useMemo(
    () => WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listChats(new ListChatsInput({ workspaceId })))),
    [refreshKey]
  )
  const chatsState = useEffectQuery(listChatsEffect, [refreshKey])
  useEffect(() => {
    const claim = listRetryClaim.current
    if (claim === undefined) return
    if (chatsState.status === "loading") {
      claim.sawLoading = true
      return
    }
    // A retry-key render still contains the preceding failure result. Keep the claim until the
    // chat catalog visibly enters loading, then release it only after that request settles.
    if (!claim.sawLoading) return
    listRetryClaim.current = undefined
    setListRetryClaimed(false)
  }, [chatsState.status])
  const retryChats = useCallback(() => {
    if (listRetryClaim.current !== undefined || chatsState.status === "loading") return
    listRetryClaim.current = { sawLoading: false }
    setListRetryClaimed(true)
    setRefreshKey((key) => key + 1)
  }, [chatsState.status])
  const isRetryingChats = listRetryClaimed || chatsState.status === "loading"

  useEffect(() => {
    if (activeChatId !== null || chatsState.status !== "success" || chatsState.value.chats.length === 0) return
    setActiveChatId(chatsState.value.chats[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatsState])

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = newChatTitle.trim()
    if (trimmed.length === 0) return
    if (isCreatingNamedChatRef.current) return
    isCreatingNamedChatRef.current = true

    setCreating(true)
    setCreateError(null)

    const fiber = runtime.runFork(
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.createChat(new CreateChatInput({ workspaceId, title: trimmed }))))
    )
    fiber.addObserver((exit) => {
      isCreatingNamedChatRef.current = false
      setCreating(false)
      if (Exit.isSuccess(exit)) {
        setNewChatTitle("")
        setStartError(null)
        setActiveChatId(exit.value.chat.id)
        setRefreshKey((k) => k + 1)
      } else if (!Exit.isInterrupted(exit)) {
        setCreateError(namedChatCreationFailureMessage)
        console.error(exit.cause.toString())
      }
    })
  }

  const handleStartFromComposer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = firstMessageText.trim()
    if (trimmed.length === 0) return
    if (isStartingFirstChatRef.current) return
    isStartingFirstChatRef.current = true

    setStartingChat(true)
    setStartError(null)
    const createFiber = runtime.runFork(
      WorkspaceRpcClient.pipe(
        Effect.flatMap((client) =>
          client.createChat(new CreateChatInput({ workspaceId, title: chatTitleFromMessage(trimmed) }))
        )
      )
    )
    createFiber.addObserver((createExit) => {
      if (Exit.isInterrupted(createExit)) {
        isStartingFirstChatRef.current = false
        return
      }
      if (!Exit.isSuccess(createExit)) {
        isStartingFirstChatRef.current = false
        setStartingChat(false)
        setStartError(firstMessageChatCreationFailureMessage)
        console.error(createExit.cause.toString())
        return
      }

      // Make the newly-created chat visible before sending. If the model is unavailable or the
      // turn fails, the user still has the durable chat and its persisted user message to retry.
      const chatId = createExit.value.chat.id
      setActiveChatId(chatId)
      setRefreshKey((k) => k + 1)
      const sendFiber = runtime.runFork(
        WorkspaceRpcClient.pipe(
          Effect.flatMap((client) => client.sendChatMessage(new SendChatMessageInput({ chatId, text: trimmed })))
        )
      )
      sendFiber.addObserver((sendExit) => {
        isStartingFirstChatRef.current = false
        setStartingChat(false)
        if (Exit.isSuccess(sendExit)) {
          setModelUnavailable(false)
          setFirstMessageText("")
        } else if (!Exit.isInterrupted(sendExit)) {
          const failure = Cause.squash(sendExit.cause) as DomainError
          if (isModelUnavailableError(failure)) {
            setModelUnavailable(true)
            setFirstMessageText("")
          } else {
            setStartError(firstMessageSendFailureMessage)
            console.error(sendExit.cause.toString())
          }
        }
        setRefreshKey((k) => k + 1)
      })
    })
  }

  const chats: ReadonlyArray<Chat> = chatsState.status === "success" ? chatsState.value.chats : []
  const isKnownEmptyCatalog = chatsState.status === "success" && chats.length === 0

  return (
    <section className="chat-panel">
      <h2>Agent chat</h2>

      {modelUnavailable && (
        <p className="chat-model-unavailable" role="status">
          <strong>Agent replies are unavailable for this workspace.</strong>
          <span>Your message is saved. You can keep reviewing this conversation and try again later.</span>
        </p>
      )}

      <div className="chat-panel-body">
        <div className="chat-list">
          {chatsState.status === "loading" && (
            <p role="status" aria-live="polite" aria-atomic="true">
              Loading chats…
            </p>
          )}
          {chatsState.status === "failure" && (
            <div className="chat-list-load-state" role="alert">
              <p>Chats couldn&rsquo;t be loaded. Try again to continue where you left off.</p>
              <button type="button" onClick={retryChats} disabled={isRetryingChats}>
                {isRetryingChats ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          <ul hidden={isKnownEmptyCatalog}>
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  className={`chat-list-item${chat.id === activeChatId ? " chat-list-item-active" : ""}`}
                  aria-current={chat.id === activeChatId ? "true" : undefined}
                  onClick={() => {
                    setStartError(null)
                    setActiveChatId(chat.id)
                  }}
                >
                  {chat.title}
                </button>
              </li>
            ))}
            {chats.length === 0 && chatsState.status === "success" && <li className="chat-list-empty">No chats yet.</li>}
          </ul>

          <details className="chat-create-disclosure" hidden={isKnownEmptyCatalog}>
            <summary>Start a named chat</summary>
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
            {createError !== null && <p className="error" role="alert">{createError}</p>}
          </details>
        </div>

        {startError !== null && <p className="error chat-start-error" role="alert">{startError}</p>}
        {activeChatId !== null ? (
          <ActiveChatView key={activeChatId} chatId={activeChatId} />
        ) : (
          <section className="chat-active-empty" aria-labelledby="chat-first-message-title">
            <div className="chat-first-message">
              <span className="chat-first-message-eyebrow">Agent workspace</span>
              <h3 id="chat-first-message-title">Start with the work</h3>
              <p>
                Send a request and Athenaeum will create and name the chat for you. You can rename or
                organize it later.
              </p>
              <form onSubmit={handleStartFromComposer} className="chat-first-message-form">
                <textarea
                  value={firstMessageText}
                  onChange={(event) => setFirstMessageText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      event.currentTarget.form?.requestSubmit()
                    }
                  }}
                  placeholder="What should Athenaeum help move forward?"
                  aria-label="First message"
                  rows={3}
                  disabled={startingChat}
                />
                <div className="chat-first-message-actions">
                  <span className="chat-first-message-hint">⌘↵ to begin</span>
                  <button type="submit" disabled={startingChat || firstMessageText.trim().length === 0}>
                    {startingChat ? "Starting…" : "Start working"}
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}
      </div>
    </section>
  )
}
