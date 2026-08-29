// `AgentEditService` — the plan's diagrammed Effect Service ("Pending records, changes stream,
// Loro semantic commits, legacy Automerge-fork prose branches, binding map" — plan §"Agent-native editing & gatekeeper
// integrations"). This is a REIMPLEMENTATION of `cloudflare-os/plans/multi-gadget.md` §Q15's
// exact provisional-creation/crash-safety algorithm, retargeted from gadget records to
// node/fact/edge records:
//
// - **Chat management** (createChat/listChats/getChat/addChatMessage): persisted via
//   `agent-edit-collections.ts`'s `chats`/`chatMessages` typed-storage collections.
// - **Pending records + changes stream, per §Q15's exact algorithm**: `createNodeTool`/
//   `addFactTool`/`addEdgeTool` write a node/fact/edge marked `pending: {chatId}` (unstamped —
//   `PendingMarker.sequence` absent), reusing `GraphService.addFact`/`GraphService.createEdge`'s
//   existing validation/id-minting/write logic (widened with an optional `pending` parameter —
//   see graph-service-live.ts's own doc comment on those two methods) rather than duplicating it;
//   node creation has no `GraphService` method to reuse (it lives inline in
//   `workspace-durable-object.ts`'s `createNode` RPC shim, which this stage deliberately leaves
//   untouched), so `createNodeTool` writes directly through `NodesRepository`, the same
//   repository that inline logic itself uses. Every tool function here is deliberately "pure"
//   (performs its mutation, returns its output) — the SAME synchronous step that persists the
//   associated `ChangesMessage` and stamps `pending.sequence` (§Q15's crash-safety pivot) is
//   `executeToolCall`'s job, uniformly, for every tool, not each tool's own — see that function's
//   doc comment.
// - **Mainline invisibility**: pending nodes/facts/edges are filtered out of
//   `NodesRepository.list`/`FactsRepository.list`/`EdgesRepository.list`/`GraphService.
//   listBacklinks` (see those files' own doc comments) — not by anything in this file — because
//   pending records are never written to the SQL read-model (`rm_nodes`/`rm_facts`/`rm_edges`/
//   `graph_text_search`) or the structured-record sync feed at creation time; those two writes are
//   *deferred* until `mergeChanges` promotes the record (this file's `promoteNode`/`promoteFact`/
//   `promoteEdge`). A chat's own preview never needs `.list()` at all — it resolves a binding to
//   an id and `.get()`s it directly, which is deliberately NOT filtered.
// - **`mergeChanges`/`revertChanges`** promote/delete pending records by `PendingMarker.sequence`
//   range, exactly per §Q15: "`mergeChanges(chatId, mergeThrough)` promotes... records with
//   `sequence <= mergeThrough`" / "`revertChanges(chatId, revertFrom)` deletes... records with
//   `sequence >= revertFrom`." Revert needs no read-model cleanup — pending records never touched
//   the read-model, so there is nothing to undo there, only the KV row itself.
// - **`reconcilePendingChanges(chatId)`**: the crash-safety sweep, run automatically at the start
//   and end of `sendChatMessage` (mirroring §Q15's "at agent turn start and end") and directly
//   callable by tests. See its own doc comment for the exact set-difference algorithm.
// - **Note-body edits**: Loro pages use the semantic ledger gateway and become durable immediately;
//   legacy Automerge pages retain the existing chat fork, so older pages remain reviewable without
//   allowing the compatibility path to become a second Loro authority. Accept/revert of a legacy
//   fork stays on `ChatForkService`'s own RPC methods.
// - **Binding map + naming**: `chatBindings` (agent-edit-collections.ts), a per-chat namespace
//   (chat-binding.ts's own doc comment: "chat-local"). `createNodeTool` claims the agent-chosen
//   `binding` name, deduping via `ensureUniqueBindingName`'s `_2`/`_3` suffixing on collision —
//   the SAME suffixing mechanism `deriveFallbackBindingName`'s real, directly-tested fallback path
//   uses when no agent-chosen name exists to start from (see that function's own doc comment for
//   why Athenaeum's tool set never actually needs the no-name case, and why the function is still
//   real and tested regardless, per this task's own instruction).
//
// Every tool executes real, tested mutation machinery; only `linkCalendarEventTool` is a stub
// (`ToolNotImplemented`, per agent-tools.ts's own doc comment — calendar doesn't exist as a
// concept until Phase 5).

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  AddEdgeToolInput,
  AddEdgeToolOutput,
  AddedEdgeSummary,
  AddedFactSummary,
  AddFactToolInput,
  AddFactToolOutput,
  App,
  AppBindingTarget,
  AppCodeVersion,
  AgentChangeProposal,
  AgentChangeProposalDecision,
  AgentChangeReservation,
  AgentChangeSnapshot,
  agentChangeReservationKey,
  canonicalJsonBytes,
  sha256HexSync,
  Chat,
  ChatBinding,
  ChatBindingName,
  ChatBindingNotFound,
  ChatBindingTarget,
  ChangesMessage,
  ChatMessageRecord,
  ChatNotFound,
  ChatContentBlock,
  ChatMessage,
  ChatTextBlock,
  ChatThread,
  ChatToolResultBlock,
  ChatToolUseBlock,
  CreatedAppSummary,
  CreatedNodeSummary,
  CreateAppToolInput,
  CreateAppToolOutput,
  CreateNodeToolInput,
  CreateNodeToolOutput,
  DefineSupertagToolInput,
  DefineSupertagToolOutput,
  ApplySupertagToolInput,
  ApplySupertagToolOutput,
  Edge,
  EdgesRepository,
  EditNoteToolInput,
  EditNoteToolOutput,
  EntityId,
  Fact,
  FactsRepository,
  IsoDateTimeString,
  LinkCalendarEventToolInput,
  LinkCalendarEventToolOutput,
  ModelClient,
  Node as NodeEntity,
  NodeBindingTarget,
  NodesRepository,
  AppsRepository,
  PendingMarker,
  PendingNameConflict,
  ReadNoteToolInput,
  ReadNoteToolOutput,
  ToolCallRequest,
  ToolNotImplemented,
  ToolSpec,
  UnexpectedError,
  UpdatedAppCodeSummary,
  UpdateAppCodeToolInput,
  UpdateAppCodeToolOutput,
  ValidationError,
  encodeRpcError,
  isValidChatBindingName,
  type DomainError
} from "@athenaeum/domain"
import type { AppCollections } from "./app-collections.js"
import {
  appCodeVersionKey,
  reviveApp,
  reviveAppCodeVersion,
  toUnexpectedError as appsToUnexpectedError
} from "./app-collections.js"
import { checkAppCodeSize } from "./apps-service-live.js"
import type { EdgesCollections } from "./edges-repository-live.js"
import { reviveEdge } from "./edges-repository-live.js"
import type { FactsCollections } from "./facts-repository-live.js"
import { reviveFact } from "./facts-repository-live.js"
import type { WorkspaceCollections } from "./nodes-repository-live.js"
import { reviveNode } from "./nodes-repository-live.js"
import { indexNodeText, upsertEdge, upsertFact, upsertNode } from "./read-model.js"
import { SyncFeedService } from "./sync-feed-service-live.js"
import { ChatForkService } from "./chat-fork-service-live.js"
import { AgentLoroEditService, type AgentLoroEditContext } from "./agent-loro-edit-service-live.js"
import { GraphService } from "./graph-service-live.js"
import { NotesService } from "./notes-service-live.js"
import {
  type AgentEditCollections,
  type ChatBindingRecord,
  reviveChangesMessage,
  reviveChat,
  reviveChatMessage,
  toUnexpectedError
} from "./agent-edit-collections.js"
import type { AgentChangeProposalCollections } from "./agent-change-proposal-collections.js"
import { proposalStorageError } from "./agent-change-proposal-collections.js"

// --- Test hooks (same established convention as `createEdgeTestHook`/`putTestHook`/
// `notesServiceSessionCapTestHook`) ------------------------------------------------------------
//
// Module-level, not per-instance: these are plain boolean toggles, not per-workspace state, so the
// "module-level mutable state can leak across colocated DO instances" concern (documented at
// `sync-feed-service-live.ts`'s `currentEpochAndGeneration`) doesn't apply — every real
// production call sees both `false`, unconditionally. A test sets one (or both) to construct the
// two crash scenarios `reconcilePendingChanges` is meant to recover from, without needing a real
// mid-fiber DO-eviction harness: `skipToolLog: true` means "the pending write happened but the
// tool call was never logged" (the orphan case — reaped); `skipFlush: true` alone (with logging
// left on) means "the pending write happened and was logged, but the flush that would have
// stamped it never ran" (the re-adopt case).
// A third hook, `skipReconcile`, gates `sendChatMessage`'s own automatic start-/end-of-turn
// `reconcilePendingChanges` calls (§Q15: "at agent turn start and end") — needed so a test can
// simulate a crash that prevents even the end-of-turn reconcile from running (not just the flush),
// leaving a genuinely un-reconciled pending record for a LATER, separate `sendChatMessage` call
// (with the hook restored) to recover deterministically, mirroring "the DO restarts, and the next
// turn's start-of-turn sweep finds the orphan/re-adoptable record" rather than recovering within
// the very same call that produced it.
export const agentEditTestHooks: { skipToolLog: boolean; skipFlush: boolean; skipReconcile: boolean } = {
  skipToolLog: false,
  skipFlush: false,
  skipReconcile: false
}

/** Test-only crash point: invoked inside the real outer capture transaction after a reservation
 * SQLite INSERT. Throwing proves evidence, request identity, and every reservation roll back together. */
export const agentChangeCaptureTestHooks: {
  afterReservationInsert?: (count: number) => void
  /** Simulates the crash window P5 reconciliation must defend: durable reservation survives while
   * a pending marker appears unstamped to the next turn. Never enabled outside tests. */
  unstampCapturedNode?: boolean
} = {}

const MAX_TURN_ITERATIONS = 25

// --- Fallback binding naming (plan §"Agent-native editing", workpiece/binding-model paragraph;
// task item 5) -----------------------------------------------------------------------------------

/**
 * Derives a deterministic `ChatBindingName`-shaped slug from a node's title — the plan's own
 * documented fallback scheme ("a short deterministic slug from the node's title/type + numeric
 * suffix on collision") for when a live quick-model naming call isn't available (per the Decisions
 * stage: no real LLM API key exists in this environment for the product's own runtime). Pure,
 * exported, and directly unit-tested (agent-edit-service.test.ts) — real, not a stub, even though
 * Athenaeum's Phase 3 tool set never actually needs it standalone (see this function's own
 * "why it's still real" note below): `createNodeTool` always has an agent-chosen `binding` to
 * start from (agent-tools.ts's `CreateNodeToolInput.binding` is required, mirroring
 * `multi-gadget.md`'s `createGadget(title, bindingName)` — the agent picks the name itself, no
 * naming chokepoint needed for *that* tool specifically). `deriveFallbackBindingName` is what a
 * future stage would call at multi-gadget's own "lazy naming chokepoint" for a resource introduced
 * *without* an agent-chosen name (there is no such resource in Phase 3's tool set) — implemented
 * now, for real, exactly as instructed, rather than treated as unimplemented for lack of a caller.
 * The numeric-suffix-on-collision half of the scheme is real and load-bearing today regardless:
 * `ensureUniqueBindingName` below applies the identical suffixing to every binding name, agent-
 * chosen or fallback-derived alike (`multi-gadget.md` Part 2: "validate as identifier; dedupe").
 */
export const deriveFallbackBindingName = (title: string): string => {
  const upper = title.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  const candidate = upper.length === 0 ? "NODE" : /^[A-Z_]/.test(upper) ? upper : `NODE_${upper}`
  return isValidChatBindingName(candidate) ? candidate : "NODE"
}

// --- The AgentEditService Context.Tag -----------------------------------------------------------

export interface AgentTurnResult {
  readonly messages: ReadonlyArray<ChatMessageRecord>
  readonly changesSequences: ReadonlyArray<number>
}

export interface ReconcileResult {
  readonly reAdopted: number
  readonly reaped: number
}

export class AgentEditService extends Context.Tag("@athenaeum/backend/AgentEditService")<
  AgentEditService,
  {
    readonly createChat: (workspaceId: EntityId, title: string) => Effect.Effect<Chat, DomainError>
    readonly listChats: (workspaceId: EntityId) => Effect.Effect<ReadonlyArray<Chat>, DomainError>
    readonly getChat: (
      chatId: EntityId
    ) => Effect.Effect<{ chat: Chat; messages: ReadonlyArray<ChatMessageRecord> }, DomainError>
    readonly addChatMessage: (
      chatId: EntityId,
      role: "user" | "assistant" | "tool",
      content: string,
      toolCalls?: ReadonlyArray<ToolCallRequest>
    ) => Effect.Effect<ChatMessageRecord, DomainError>
    readonly sendChatMessage: (
      chatId: EntityId,
      text: string,
      context?: AgentLoroEditContext
    ) => Effect.Effect<AgentTurnResult, DomainError>
    readonly mergeChanges: (chatId: EntityId, mergeThrough: number) => Effect.Effect<void, DomainError>
    readonly revertChanges: (chatId: EntityId, revertFrom: number) => Effect.Effect<void, DomainError>
    readonly listChatChanges: (chatId: EntityId) => Effect.Effect<ReadonlyArray<ChangesMessage>, DomainError>
    /** Web-stage addition (see `ListPendingChangesOutput`'s doc comment in agent-edit-rpc.ts for
     *  why `listChatChanges` alone isn't the right data source for an accept/revert UI): the
     *  entities this chat currently has pending, right now — thin wrapper around the same
     *  `pendingNodesForChat`/`pendingFactsForChat`/`pendingEdgesForChat` reads `mergeChanges`/
     *  `revertChanges` themselves already use, with a `ChatNotFound` existence check up front to
     *  match every other method here. */
    readonly listPendingChanges: (
      chatId: EntityId
    ) => Effect.Effect<{ nodes: ReadonlyArray<NodeEntity>; facts: ReadonlyArray<Fact>; edges: ReadonlyArray<Edge> }, DomainError>
    readonly reconcilePendingChanges: (chatId: EntityId) => Effect.Effect<ReconcileResult, DomainError>
    /** Must be invoked inside the Workspace DO's one outer `storage.transactionSync` callback. */
    readonly captureProposalAndReserve: (input: {
      chatId: EntityId; operation: "merge" | "revert"; rangeBoundary: number; requestId: string;
      actor: string; provenance: string
    }) => Effect.Effect<AgentChangeProposal, DomainError>
    readonly capturedProposalForRequest: (requestId: string) => Effect.Effect<AgentChangeProposal | undefined, DomainError>
    /** Applies one immutable proposal snapshot. The caller must wrap this effect in the
     * Workspace DO's outer transaction together with the ledger command and receipt. */
    readonly decideAgentChangeProposal: (input: {
      proposalId: EntityId
      decision: "accept" | "reject"
    }) => Effect.Effect<"accepted" | "rejected" | "conflicted", DomainError>

    // Agent tools (task item 6) — real, pending-record-producing implementations exercised by
    // `sendChatMessage`'s tool-calling loop, and directly callable/testable on their own. None of
    // these log/flush themselves — `executeToolCall` (used only by `sendChatMessage`) does that
    // uniformly, once, for whichever tool ran; a direct test calling one of these bypasses
    // logging/flushing entirely, which is the correct behavior for unit-testing the mutation in
    // isolation.
    readonly readNoteTool: (input: ReadNoteToolInput) => Effect.Effect<ReadNoteToolOutput, DomainError>
    readonly editNoteTool: (
      input: EditNoteToolInput,
      toolCallId?: string,
      context?: AgentLoroEditContext
    ) => Effect.Effect<EditNoteToolOutput, DomainError>
    readonly createNodeTool: (input: CreateNodeToolInput) => Effect.Effect<CreateNodeToolOutput, DomainError>
    readonly addFactTool: (input: AddFactToolInput) => Effect.Effect<AddFactToolOutput, DomainError>
    readonly addEdgeTool: (input: AddEdgeToolInput) => Effect.Effect<AddEdgeToolOutput, DomainError>
    readonly linkCalendarEventTool: (
      input: LinkCalendarEventToolInput
    ) => Effect.Effect<LinkCalendarEventToolOutput, DomainError>
    readonly createAppTool: (input: CreateAppToolInput) => Effect.Effect<CreateAppToolOutput, DomainError>
    readonly updateAppCodeTool: (input: UpdateAppCodeToolInput) => Effect.Effect<UpdateAppCodeToolOutput, DomainError>

    // Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2, agent-tools.ts's own
    // "Supertag-centering pass: agent tools" section header comment).
    readonly defineSupertagTool: (input: DefineSupertagToolInput) => Effect.Effect<DefineSupertagToolOutput, DomainError>
    readonly applySupertagTool: (input: ApplySupertagToolInput) => Effect.Effect<ApplySupertagToolOutput, DomainError>
  }
>() {}

// --- The tool-calling surface offered to `ModelClient.converse` --------------------------------
//
// `chatId` is deliberately absent from every `inputSchema` below — it's context the backend
// injects (the turn's own `chatId`), never a model-supplied parameter, even though the underlying
// agent-tools.ts schemas *do* declare a `chatId` field (see `decodeToolInput` below for where it's
// injected before decoding).

const TOOL_SPECS: ReadonlyArray<ToolSpec> = [
  new ToolSpec({
    name: "readNote",
    description: "Read the current text of a bound note (the chat's own pending edit if one is open, else mainline).",
    inputSchema: { type: "object", properties: { binding: { type: "string" } }, required: ["binding"] }
  }),
  new ToolSpec({
    name: "editNote",
    description: "Apply a text splice to a bound note. Loro notes commit through the semantic ledger; legacy Automerge notes stay in this chat's reviewable fork.",
    inputSchema: {
      type: "object",
      properties: {
        binding: { type: "string" },
        index: { type: "number" },
        deleteCount: { type: "number" },
        insertText: { type: "string" },
        commitMessage: { type: "string" }
      },
      required: ["binding", "index", "deleteCount", "insertText", "commitMessage"]
    }
  }),
  new ToolSpec({
    name: "createNode",
    description: "Create a new pending graph node and bind it to a chat-local name you choose.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, binding: { type: "string" } },
      required: ["title", "binding"]
    }
  }),
  new ToolSpec({
    name: "addFact",
    description: "Add a pending (nodeId, predicateId, value) fact to a bound node.",
    inputSchema: {
      type: "object",
      properties: { binding: { type: "string" }, predicateId: { type: "string" }, value: {} },
      required: ["binding", "predicateId", "value"]
    }
  }),
  new ToolSpec({
    name: "addEdge",
    description: "Add a pending edge between two bound nodes under an existing relationDefinition.",
    inputSchema: {
      type: "object",
      properties: {
        relationDefinitionId: { type: "string" },
        sourceBinding: { type: "string" },
        targetBinding: { type: "string" }
      },
      required: ["relationDefinitionId", "sourceBinding", "targetBinding"]
    }
  }),
  new ToolSpec({
    name: "linkCalendarEvent",
    description: "Not implemented in Phase 3 — calendar does not exist as a concept yet.",
    inputSchema: {
      type: "object",
      properties: { binding: { type: "string" }, calendarEventId: { type: "string" } },
      required: ["binding", "calendarEventId"]
    }
  }),
  new ToolSpec({
    name: "createApp",
    description:
      "Create a new pending, codeless App (App Library) and bind it to a chat-local name you choose. " +
      "Write its client/server code afterward with updateAppCode.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, icon: { type: "string" }, binding: { type: "string" } },
      required: ["title", "icon", "binding"]
    }
  }),
  new ToolSpec({
    name: "updateAppCode",
    description:
      "Propose a new version of an App's client (iframe UI) or server (sandboxed Worker Loader) code. " +
      "Writes a pending, not-yet-accepted code version.",
    inputSchema: {
      type: "object",
      properties: {
        binding: { type: "string" },
        kind: { type: "string", enum: ["client", "server"] },
        code: { type: "string" }
      },
      required: ["binding", "kind", "code"]
    }
  }),
  new ToolSpec({
    name: "defineSupertag",
    description: "Add a new field to an existing Supertag (tag), e.g. adding a 'birthday' field to Person.",
    inputSchema: {
      type: "object",
      properties: {
        tagId: { type: "string" },
        name: { type: "string" },
        valueKind: { type: "string", enum: ["text", "number", "date", "checkbox", "entity-ref"] },
        sortOrder: { type: "number" }
      },
      required: ["tagId", "name", "valueKind", "sortOrder"]
    }
  }),
  new ToolSpec({
    name: "applySupertag",
    description:
      "Tag a bound node with an existing Supertag (tag) and optionally seed initial field values in one call. " +
      "Field values are written as pending facts, reviewable like every other pending change.",
    inputSchema: {
      type: "object",
      properties: {
        binding: { type: "string" },
        tagId: { type: "string" },
        fieldValues: {
          type: "array",
          items: {
            type: "object",
            properties: { fieldId: { type: "string" }, value: {} },
            required: ["fieldId", "value"]
          }
        }
      },
      required: ["binding", "tagId"]
    }
  })
]

const SYSTEM_PROMPT =
  "You are Athenaeum's agent-native editing assistant. You can read/edit notes and propose graph " +
  "changes (nodes/facts/edges) via tools. Loro note edits commit through the semantic ledger; " +
  "legacy Automerge note edits remain pending for review. Reply with plain text once you are done."

/** What one dispatched tool call produced, before `executeToolCall` logs/flushes it — `refs` is
 *  which pending entities (if any) this call touched, `batch` is the `ChangesMessage` fields (if
 *  any) summarizing them. Both empty for `readNote`/`editNote` (no row-level pending record). */
interface ToolDispatchOutcome {
  readonly resultText: string
  readonly refs: ReadonlyArray<{ readonly kind: "node" | "fact" | "edge" | "app"; readonly id: EntityId }>
  readonly batch: {
    readonly createdNodes?: ReadonlyArray<CreatedNodeSummary>
    readonly addedFacts?: ReadonlyArray<AddedFactSummary>
    readonly addedEdges?: ReadonlyArray<AddedEdgeSummary>
    readonly createdApps?: ReadonlyArray<CreatedAppSummary>
    readonly updatedAppCode?: ReadonlyArray<UpdatedAppCodeSummary>
  }
}

export const makeAgentEditServiceLive = (
  workspaceId: EntityId,
  collections: AgentEditCollections,
  nodesCollections: WorkspaceCollections,
  factsCollections: FactsCollections,
  edgesCollections: EdgesCollections,
  appCollections: AppCollections,
  proposalCollections: AgentChangeProposalCollections,
  sql: SqlStorage
): Layer.Layer<
  AgentEditService,
  never,
  | NodesRepository
  | FactsRepository
  | EdgesRepository
  | AppsRepository
  | GraphService
  | NotesService
  | ChatForkService
  | AgentLoroEditService
  | SyncFeedService
  | ModelClient
> =>
  Layer.effect(
    AgentEditService,
    Effect.gen(function* () {
      const nodesRepository = yield* NodesRepository
      const factsRepository = yield* FactsRepository
      const edgesRepository = yield* EdgesRepository
      const appsRepository = yield* AppsRepository
      const graph = yield* GraphService
      const notes = yield* NotesService
      const chatFork = yield* ChatForkService
      const agentLoroEdit = yield* AgentLoroEditService
      const syncFeed = yield* SyncFeedService
      const modelClient = yield* ModelClient

      // --- Small storage helpers -----------------------------------------------------------

      const getChatRow = (chatId: EntityId): Effect.Effect<Chat, ChatNotFound | UnexpectedError> =>
        collections.chats.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap(
            (raw): Effect.Effect<Chat, ChatNotFound | UnexpectedError> =>
              raw === undefined ? Effect.fail(new ChatNotFound({ chatId })) : reviveChat(raw)
          )
        )

      const listChatMessagesSorted = (
        chatId: EntityId
      ): Effect.Effect<ReadonlyArray<ChatMessageRecord>, UnexpectedError> =>
        collections.chatMessages.byChatId.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveChatMessage)),
          Effect.map((messages) => [...messages].sort((a, b) => a.sequence - b.sequence))
        )

      const listChangesSorted = (chatId: EntityId): Effect.Effect<ReadonlyArray<ChangesMessage>, UnexpectedError> =>
        collections.changesMessages.byChatId.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveChangesMessage)),
          Effect.map((messages) => [...messages].sort((a, b) => a.sequence - b.sequence))
        )

      const nextChatMessageSequence = (chatId: EntityId): Effect.Effect<number, UnexpectedError> =>
        listChatMessagesSorted(chatId).pipe(
          Effect.map((messages) => (messages.length === 0 ? 0 : messages[messages.length - 1]!.sequence + 1))
        )

      const nextChangesSequence = (chatId: EntityId): Effect.Effect<number, UnexpectedError> =>
        listChangesSorted(chatId).pipe(
          Effect.map((messages) => (messages.length === 0 ? 0 : messages[messages.length - 1]!.sequence + 1))
        )

      const addChatMessage = (
        chatId: EntityId,
        role: "user" | "assistant" | "tool",
        content: string,
        toolCalls?: ReadonlyArray<ToolCallRequest>
      ): Effect.Effect<ChatMessageRecord, DomainError> =>
        Effect.gen(function* () {
          const sequence = yield* nextChatMessageSequence(chatId)
          const message = new ChatMessageRecord({
            id: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
            chatId,
            role,
            content,
            toolCalls: toolCalls === undefined ? undefined : [...toolCalls],
            sequence
          })
          yield* collections.chatMessages.put(message).pipe(Effect.mapError(toUnexpectedError))
          return message
        })

      // --- Binding map -----------------------------------------------------------------------

      const bindingKey = (chatId: EntityId, name: string): string => `${chatId}:${name}`

      const getBinding = (
        chatId: EntityId,
        name: string
      ): Effect.Effect<ChatBindingRecord | undefined, UnexpectedError> =>
        collections.chatBindings.get(bindingKey(chatId, name)).pipe(Effect.mapError(toUnexpectedError))

      /** Claims `candidate` (or `candidate_2`, `candidate_3`, ...) as this chat's binding name for
       *  `target`, per `multi-gadget.md` Part 2's "validate as identifier; dedupe" naming rule —
       *  the same suffixing mechanism backs both an agent-chosen name (`createNodeTool`, this
       *  function's only real Phase 3 caller) and `deriveFallbackBindingName`'s documented fallback
       *  path (no caller yet — see that function's own doc comment). Idempotent: if `candidate`
       *  already maps to `target` in this chat, it's reused rather than re-suffixed. */
      const ensureUniqueBindingName = (
        chatId: EntityId,
        candidate: string,
        target: ChatBindingTarget
      ): Effect.Effect<ChatBindingName, PendingNameConflict | UnexpectedError> =>
        Effect.gen(function* () {
          let attempt = candidate
          let suffix = 2
          // Bounded by construction: `isValidChatBindingName` guarantees `candidate` is already a
          // valid identifier, and appending `_N` preserves that — this loop only ever terminates
          // by finding a free (or matching) slot, capped defensively so a storage bug can't spin
          // forever.
          for (let i = 0; i < 1000; i++) {
            const existing = yield* getBinding(chatId, attempt)
            if (existing === undefined) {
              const name = Schema.decodeUnknownSync(ChatBindingName)(attempt)
              const binding = new ChatBinding({ name, target })
              const record: ChatBindingRecord = { chatId, name: binding.name, target: binding.target }
              yield* collections.chatBindings.put(record).pipe(Effect.mapError(toUnexpectedError))
              return name
            }
            if (
              existing.target.kind === target.kind &&
              (existing.target as { id: EntityId }).id === (target as { id: EntityId }).id
            ) {
              return existing.name
            }
            attempt = `${candidate}_${suffix}`
            suffix++
          }
          return yield* Effect.fail(new PendingNameConflict({ name: candidate, claimedByChatId: chatId }))
        })

      const resolveBinding = (
        chatId: EntityId,
        name: string
      ): Effect.Effect<ChatBindingTarget, ChatBindingNotFound | UnexpectedError> =>
        getBinding(chatId, name).pipe(
          Effect.flatMap((record) =>
            record === undefined ? Effect.fail(new ChatBindingNotFound({ chatId, name })) : Effect.succeed(record.target)
          )
        )

      const resolveNodeBinding = (
        chatId: EntityId,
        name: string
      ): Effect.Effect<EntityId, ChatBindingNotFound | ValidationError | UnexpectedError> =>
        resolveBinding(chatId, name).pipe(
          Effect.flatMap((target) =>
            target.kind === "node"
              ? Effect.succeed(target.id)
              : Effect.fail(new ValidationError({ message: `binding "${name}" does not resolve to a node` }))
          )
        )

      // --- Pending-record flush (§Q15's stamping step) ----------------------------------------

      type EntityRef = { readonly kind: "node" | "fact" | "edge" | "app"; readonly id: EntityId }

      const stampPending = (ref: EntityRef, chatId: EntityId, sequence: number): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const marker = new PendingMarker({ chatId, sequence })
          switch (ref.kind) {
            case "node": {
              const node = yield* nodesRepository.get(ref.id)
              yield* nodesRepository.put(new NodeEntity({ ...node, pending: marker }))
              return
            }
            case "fact": {
              const fact = yield* factsRepository.get(ref.id)
              yield* factsRepository.put(new Fact({ ...fact, pending: marker }))
              return
            }
            case "edge": {
              const edge = yield* edgesRepository.get(ref.id)
              yield* edgesRepository.put(new Edge({ ...edge, pending: marker }))
              return
            }
            case "app": {
              // Unconditionally (re-)stamps the OWNING chat's marker on the App row — correct both
              // for a brand-new pending App (`createAppTool` constructed it with an unstamped
              // marker for THIS SAME chat) and for an already-mainline App just touched by
              // `updateAppCodeTool` (which never writes `pending` itself — see that tool's own doc
              // comment — this is the one place its App row actually becomes pending, for the
              // duration of `marker.chatId`'s outstanding proposal).
              const app = yield* appsRepository.get(ref.id)
              yield* appsRepository.put(new App({ ...app, pending: marker }))
              return
            }
          }
        })

      // --- Agent tools (pure: mutate + return output, no logging/flushing) --------------------

      const readNoteTool = (input: ReadNoteToolInput): Effect.Effect<ReadNoteToolOutput, DomainError> =>
        Effect.gen(function* () {
          const nodeId = yield* resolveNodeBinding(input.chatId, input.binding)
          // The format router owns this decision.  In particular, a migrated Loro descriptor
          // retains an Automerge witness but remains Loro-active, so it must not probe the
          // legacy fork/page services at all.
          const loroRead = yield* agentLoroEdit.read(nodeId)
          if (loroRead.format === "loro-v1") return new ReadNoteToolOutput({ text: loroRead.text })
          const preview = yield* chatFork.previewFork(input.chatId, nodeId)
          if (preview.forked) return new ReadNoteToolOutput({ text: preview.text })
          const { text } = yield* notes.getPageText(nodeId)
          return new ReadNoteToolOutput({ text })
        })

      const editNoteTool = (
        input: EditNoteToolInput,
        toolCallId = `direct-edit:${crypto.randomUUID()}`,
        context: AgentLoroEditContext = {}
      ): Effect.Effect<EditNoteToolOutput, DomainError> =>
        Effect.gen(function* () {
          const nodeId = yield* resolveNodeBinding(input.chatId, input.binding)
          const loroEdit = yield* agentLoroEdit.edit({
            chatId: input.chatId,
            toolCallId,
            nodeId,
            index: input.index,
            deleteCount: input.deleteCount,
            insertText: input.insertText,
            commitMessage: input.commitMessage,
            context
          })
          if (loroEdit.format === "loro-v1") return new EditNoteToolOutput({ text: loroEdit.text, nodeId })
          // Legacy compatibility still uses a reviewable Automerge proposal, but retain the
          // agent-authored commit message as its durable rationale for later acceptance/audit.
          yield* chatFork.fork(input.chatId, nodeId, input.commitMessage)
          const { text } = yield* chatFork.applyForkEdit(
            input.chatId,
            nodeId,
            input.index,
            input.deleteCount,
            input.insertText,
            input.commitMessage
          )
          // `nodeId` rides along in the output (adversarial-review fix) purely so a reviewing
          // client can discover, from the tool-log JSON it already fetches, which node this
          // `editNote` call forked — see `EditNoteToolOutput`'s own doc comment in agent-tools.ts
          // for why this is NOT done via `refs`/`stampPending` instead.
          return new EditNoteToolOutput({ text, nodeId })
        })

      const createNodeTool = (input: CreateNodeToolInput): Effect.Effect<CreateNodeToolOutput, DomainError> =>
        Effect.gen(function* () {
          const chatId = input.chatId
          yield* getChatRow(chatId)
          const nodeId = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
          const node = new NodeEntity({
            id: nodeId,
            workspaceId,
            title: input.title,
            createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString()),
            pending: new PendingMarker({ chatId })
          })
          yield* nodesRepository.put(node)
          const target = new NodeBindingTarget({ kind: "node", id: nodeId })
          const finalName = yield* ensureUniqueBindingName(chatId, input.binding, target)
          return new CreateNodeToolOutput({ binding: finalName, nodeId })
        })

      const addFactTool = (input: AddFactToolInput): Effect.Effect<AddFactToolOutput, DomainError> =>
        Effect.gen(function* () {
          const nodeId = yield* resolveNodeBinding(input.chatId, input.binding)
          const fact = yield* graph.addFact(
            workspaceId,
            nodeId,
            input.predicateId,
            input.value,
            undefined,
            new PendingMarker({ chatId: input.chatId })
          )
          return new AddFactToolOutput({ factId: fact.id })
        })

      const addEdgeTool = (input: AddEdgeToolInput): Effect.Effect<AddEdgeToolOutput, DomainError> =>
        Effect.gen(function* () {
          const sourceNodeId = yield* resolveNodeBinding(input.chatId, input.sourceBinding)
          const targetNodeId = yield* resolveNodeBinding(input.chatId, input.targetBinding)
          const edge = yield* graph.createEdge(
            workspaceId,
            input.relationDefinitionId,
            sourceNodeId,
            targetNodeId,
            new PendingMarker({ chatId: input.chatId })
          )
          return new AddEdgeToolOutput({ edgeId: edge.id })
        })

      const linkCalendarEventTool = (
        _input: LinkCalendarEventToolInput
      ): Effect.Effect<LinkCalendarEventToolOutput, DomainError> =>
        Effect.fail(
          new ToolNotImplemented({
            toolName: "linkCalendarEvent",
            message: "linkCalendarEvent is not implemented until Phase 5 (Google Calendar gatekeeper)."
          })
        )

      // --- Supertag-centering pass agent tools (docs/supertag-centering-decisions.md §1/§2) ----
      //
      // `defineSupertagTool` is a mainline schema mutation (like `createTag`/`createRelationDefinition`,
      // neither of which has a dedicated agent tool either) — it produces no pending row, so
      // `dispatchTool`'s case for it below returns empty `refs`/`batch`. `applySupertagTool`
      // produces PENDING `Fact`s for any `fieldValues` supplied (mirroring `addFactTool` exactly)
      // — the tag *assignment* itself has no pending/accept-revert concept (`GraphService.assignTag`
      // writes immediately, same as the mainline `applySupertag` RPC), only the field-value facts
      // are subject to the chat's existing accept/revert flow.
      //
      // KNOWN, DOCUMENTED GAP (adversarial-review finding; full trade-off writeup in
      // docs/supertag-centering-decisions.md's "Known risks / trade-offs" section, not just this
      // comment): this means an agent-applied tag CANNOT be undone via `revertChanges`/rejecting
      // the chat turn, unlike every other agent mutation in this file. It also inserts no text chip
      // into the note (`applySupertagTool` never touches the Automerge doc), so
      // `RichNoteEditor.tsx`'s chip-diffing sync (`scheduleSupertagSync`) never sees it either —
      // there is no automatic path back. The mitigation actually shipped is a manual one:
      // `SupertagFieldPopover.tsx`'s "Remove tag" button calls the same `unassignTag` RPC
      // unconditionally for whatever tag the popover is open on, regardless of how it was applied
      // (inline chip or this tool) — a real, always-available UI undo path, just not the automatic
      // accept/revert-on-reject one the rest of this file's tools get. A future pass could close
      // this properly by giving `graph_node_tags` rows their own `PendingMarker` (mirroring
      // `Node`/`Fact`/`Edge`) — deliberately not attempted here: it would touch the read-model
      // write-gating for a THIRD entity kind (`upsertNodeTag`/the `hasTag` view predicate) and this
      // file's `mergeChanges`/`revertChanges`/`reconcilePendingChanges` sweeps, a materially larger
      // change than this fix pass's scope.

      const defineSupertagTool = (input: DefineSupertagToolInput): Effect.Effect<DefineSupertagToolOutput, DomainError> =>
        Effect.gen(function* () {
          yield* getChatRow(input.chatId)
          const fieldDefinition = yield* graph.defineTagField(
            workspaceId,
            input.tagId,
            input.name,
            input.valueKind,
            input.sortOrder
          )
          return new DefineSupertagToolOutput({ fieldId: fieldDefinition.id })
        })

      const applySupertagTool = (input: ApplySupertagToolInput): Effect.Effect<ApplySupertagToolOutput, DomainError> =>
        Effect.gen(function* () {
          const nodeId = yield* resolveNodeBinding(input.chatId, input.binding)
          yield* graph.assignTag(workspaceId, nodeId, input.tagId)
          const facts = yield* Effect.forEach(input.fieldValues ?? [], (fieldValue) =>
            graph.addFact(
              workspaceId,
              nodeId,
              fieldValue.fieldId,
              fieldValue.value,
              undefined,
              new PendingMarker({ chatId: input.chatId })
            )
          )
          return new ApplySupertagToolOutput({ tagId: input.tagId, factIds: facts.map((fact) => fact.id) })
        })

      // --- App Library agent tools (App Library backend-implementation task) — mirrors
      // `createNodeTool`/`addFactTool`'s own "pure: mutate + return output, no logging/flushing"
      // discipline exactly (this file's header comment). `createAppTool` constructs the new App
      // row with an UNSTAMPED `PendingMarker` itself (same as `createNodeTool` does for `Node`) —
      // `executeToolCall`'s uniform `stampPending` step (above) fills in the real `sequence`.
      // `updateAppCodeTool` deliberately does NOT touch `pending` itself (see `stampPending`'s
      // `"app"` case doc comment) — it only writes the new `AppCodeVersion` row; `stampPending`
      // is what actually marks the (possibly already-mainline) App pending for this chat.

      const createAppTool = (input: CreateAppToolInput): Effect.Effect<CreateAppToolOutput, DomainError> =>
        Effect.gen(function* () {
          const chatId = input.chatId
          yield* getChatRow(chatId)
          const appId = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
          const now = Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
          const app = new App({
            id: appId,
            workspaceId,
            title: input.title,
            icon: input.icon,
            clientCodeVersion: 0,
            serverCodeVersion: 0,
            createdAt: now,
            updatedAt: now,
            pending: new PendingMarker({ chatId })
          })
          yield* appsRepository.put(app)
          const target = new AppBindingTarget({ kind: "app", id: appId })
          const finalName = yield* ensureUniqueBindingName(chatId, input.binding, target)
          return new CreateAppToolOutput({ binding: finalName, appId })
        })

      /** Resolves `binding` to an App id, failing `ValidationError` (not `ChatBindingNotFound`
       *  itself — that's what `resolveBinding` already raises for an unknown name) if it resolves
       *  to a non-App target — mirrors `resolveNodeBinding`'s identical "wrong kind" failure mode
       *  above. Shared by `updateAppCodeTool` and `dispatchTool`'s own `"updateAppCode"` case
       *  (which needs the resolved `appId` for its `ChangesMessage` batch summary). */
      const resolveAppBinding = (
        chatId: EntityId,
        name: string
      ): Effect.Effect<EntityId, ChatBindingNotFound | ValidationError | UnexpectedError> =>
        resolveBinding(chatId, name).pipe(
          Effect.flatMap((target) =>
            target.kind === "app"
              ? Effect.succeed(target.id)
              : Effect.fail(new ValidationError({ message: `binding "${name}" does not resolve to an App` }))
          )
        )

      const maxAppCodeVersionForKind = (appId: EntityId, kind: "client" | "server"): Effect.Effect<number, UnexpectedError> =>
        appCollections.appCodeVersions.byAppIdKind.get(`${appId}:${kind}`).pipe(
          Effect.mapError(appsToUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveAppCodeVersion)),
          Effect.map((rows) => rows.reduce((max, row) => Math.max(max, row.version), 0))
        )

      const updateAppCodeTool = (input: UpdateAppCodeToolInput): Effect.Effect<UpdateAppCodeToolOutput, DomainError> =>
        Effect.gen(function* () {
          const appId = yield* resolveAppBinding(input.chatId, input.binding)
          const app = yield* appsRepository.get(appId)
          if (app.pending !== undefined && app.pending.chatId !== input.chatId) {
            return yield* Effect.fail(
              new ValidationError({
                message: `App ${appId} already has a pending change from another chat (${app.pending.chatId}); ` +
                  "accept or revert it before proposing a new one."
              })
            )
          }
          yield* checkAppCodeSize(appId, input.kind, input.code)
          const pointer = input.kind === "client" ? app.clientCodeVersion : app.serverCodeVersion
          const currentMax = yield* maxAppCodeVersionForKind(appId, input.kind)
          const newVersion = Math.max(currentMax, pointer) + 1
          const codeVersion = new AppCodeVersion({
            id: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
            appId,
            kind: input.kind,
            version: newVersion,
            code: input.code,
            createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
          })
          yield* appCollections.appCodeVersions.put(codeVersion).pipe(Effect.mapError(appsToUnexpectedError))
          return new UpdateAppCodeToolOutput({ binding: input.binding, version: newVersion })
        })

      // --- mergeChanges / revertChanges (§Q15) -------------------------------------------------

      const promoteNode = (node: NodeEntity): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const promoted = new NodeEntity({ ...node, pending: undefined })
          yield* nodesRepository.put(promoted)
          yield* upsertNode(sql, promoted)
          yield* indexNodeText(sql, promoted.id, promoted.title, "")
          yield* syncFeed.append("node", promoted.id, "put", promoted)
        })

      const promoteFact = (fact: Fact): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const promoted = new Fact({ ...fact, pending: undefined })
          yield* factsRepository.put(promoted)
          yield* upsertFact(sql, promoted)
          yield* syncFeed.append("fact", promoted.id, "put", promoted)
        })

      const promoteEdge = (edge: Edge): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const promoted = new Edge({ ...edge, pending: undefined })
          yield* edgesRepository.put(promoted)
          yield* upsertEdge(sql, promoted)
          yield* syncFeed.append("edge", promoted.id, "put", promoted)
        })

      /** Every `AppCodeVersion` row for `(appId, kind)` currently sitting AHEAD of `app`'s own
       *  pointer for that kind — the rows a still-open pending arc wrote via `updateAppCodeTool`,
       *  regardless of exactly how many separate tool calls produced them (see app.ts's
       *  `AppCodeVersion` doc comment: "there is never more than one AppCodeVersion row ahead of
       *  either pointer" in the common single-edit case, but `promoteApp`/`revertApp` below handle
       *  any number uniformly by comparing against the pointer, not by counting calls). */
      const aheadOfPointerVersions = (
        appId: EntityId,
        kind: "client" | "server",
        pointer: number
      ): Effect.Effect<ReadonlyArray<AppCodeVersion>, UnexpectedError> =>
        appCollections.appCodeVersions.byAppIdKind.get(`${appId}:${kind}`).pipe(
          Effect.mapError(appsToUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveAppCodeVersion)),
          Effect.map((rows) => rows.filter((row) => row.version > pointer))
        )

      /**
       * Accepts a pending App (app.ts's `App.pending` doc comment — either a wholly new App or an
       * already-mainline App with a pending code update): for each code `kind`, advances the
       * pointer to the max ahead-of-pointer `AppCodeVersion` row that exists (a no-op for a kind
       * this pending arc never touched), clears `pending`, and bumps `updatedAt` — the ONLY place
       * `updatedAt` is bumped outside `createApp`'s own initial construction, which is exactly what
       * `revertApp`'s `wasNeverAccepted` discriminator below (`updatedAt === createdAt`) relies on.
       * No `SyncFeedService`/SQL-read-model write, unlike `promoteNode`/`promoteFact`/`promoteEdge`
       * — Apps are not part of the graph read-model (`rm_nodes`/etc.) this stage's scope covers;
       * a future App Library UI stage reads Apps through `AppsService` directly, not the sync feed.
       */
      const promoteApp = (app: App): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const aheadClient = yield* aheadOfPointerVersions(app.id, "client", app.clientCodeVersion)
          const aheadServer = yield* aheadOfPointerVersions(app.id, "server", app.serverCodeVersion)
          const newClientVersion = aheadClient.reduce((max, row) => Math.max(max, row.version), app.clientCodeVersion)
          const newServerVersion = aheadServer.reduce((max, row) => Math.max(max, row.version), app.serverCodeVersion)
          const promoted = new App({
            ...app,
            clientCodeVersion: newClientVersion,
            serverCodeVersion: newServerVersion,
            updatedAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString()),
            pending: undefined
          })
          yield* appsRepository.put(promoted)
        })

      /**
       * Reverts a pending App: deletes every ahead-of-pointer `AppCodeVersion` row for both kinds
       * (they never became real — mirrors the "reverted pending version" exception app.ts's
       * `AppCodeVersion` doc comment carves out of its own "append-only, never deleted" rule), then
       * either deletes the App row entirely (if `updatedAt === createdAt` — this App has never
       * been through `promoteApp`, i.e. it originated as THIS still-open pending arc's own
       * creation, mirroring `promoteNode`/`revertChanges`'s node-deletion precedent) or just clears
       * `pending` (an already-real App that merely had a pending code update reverted).
       */
      const revertApp = (app: App): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          const aheadClient = yield* aheadOfPointerVersions(app.id, "client", app.clientCodeVersion)
          const aheadServer = yield* aheadOfPointerVersions(app.id, "server", app.serverCodeVersion)
          yield* Effect.forEach(
            [...aheadClient, ...aheadServer],
            (row) => appCollections.appCodeVersions.delete(appCodeVersionKey(row)).pipe(Effect.mapError(appsToUnexpectedError)),
            { discard: true }
          )
          const wasNeverAccepted = app.updatedAt === app.createdAt
          if (wasNeverAccepted) {
            yield* appsRepository.delete(app.id)
          } else {
            yield* appsRepository.put(new App({ ...app, pending: undefined }))
          }
        })

      const pendingNodesForChat = (chatId: EntityId): Effect.Effect<ReadonlyArray<NodeEntity>, UnexpectedError> =>
        nodesCollections.nodes.byPendingChatId.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveNode))
        )

      const pendingFactsForChat = (chatId: EntityId): Effect.Effect<ReadonlyArray<Fact>, UnexpectedError> =>
        factsCollections.facts.byPendingChatId.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveFact))
        )

      const pendingEdgesForChat = (chatId: EntityId): Effect.Effect<ReadonlyArray<Edge>, UnexpectedError> =>
        edgesCollections.edges.byPendingChatId.get(chatId).pipe(
          Effect.mapError(toUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveEdge))
        )

      const pendingAppsForChat = (chatId: EntityId): Effect.Effect<ReadonlyArray<App>, UnexpectedError> =>
        appCollections.apps.byPendingChatId.get(chatId).pipe(
          Effect.mapError(appsToUnexpectedError),
          Effect.flatMap((raw) => Effect.forEach(raw, reviveApp))
        )

      /** Capture is deliberately a synchronous effect: its caller places this entire read/validate/
       * write sequence in a single DO transaction. Canonical bytes, not the digest, are the live
       * validation primitive; the SHA-256 is an integrity/audit aid only. */
      const captureProposalAndReserve = (input: {
        chatId: EntityId; operation: "merge" | "revert"; rangeBoundary: number; requestId: string;
        actor: string; provenance: string
      }): Effect.Effect<AgentChangeProposal, DomainError> => Effect.gen(function* () {
        const chat = yield* getChatRow(input.chatId)
        if (chat.workspaceId !== workspaceId) return yield* Effect.fail(new ValidationError({ message: "chat does not belong to this workspace" }))
        // Derive idempotency evidence from the actual semantic command inside the transaction;
        // a caller-provided fingerprint is never an authority on command identity.
        const requestCanonicalPayload = canonicalJsonBytes({
          version: "athenaeum.agent-change-capture.v1", workspaceId, chatId: input.chatId,
          operation: input.operation, rangeBoundary: input.rangeBoundary,
          actor: input.actor, provenance: input.provenance
        })
        const requestCanonicalPayloadText = new TextDecoder().decode(requestCanonicalPayload)
        const requestFingerprint = sha256HexSync(requestCanonicalPayload)
        const identity = sql.exec<{ canonicalPayload: string; fingerprint: string; proposalId: string }>(
          "SELECT canonicalPayload, fingerprint, proposalId FROM agent_change_request_identities WHERE requestId = ?", input.requestId
        ).toArray()[0]
        if (identity !== undefined) {
          if (identity.canonicalPayload !== requestCanonicalPayloadText || identity.fingerprint !== requestFingerprint) {
            return yield* Effect.fail(new ValidationError({ message: "request id was already used for a different proposal capture" }))
          }
          const replay = yield* proposalCollections.proposals.get(Schema.decodeUnknownSync(EntityId)(identity.proposalId)).pipe(Effect.mapError(proposalStorageError))
          if (replay === undefined) return yield* Effect.fail(new UnexpectedError({ message: "request identity has no immutable proposal evidence" }))
          return replay
        }
        const eligible = (sequence: number | undefined) => sequence !== undefined && (input.operation === "merge" ? sequence <= input.rangeBoundary : sequence >= input.rangeBoundary)
        const nodes = (yield* pendingNodesForChat(input.chatId)).filter((row) => eligible(row.pending?.sequence))
        const facts = (yield* pendingFactsForChat(input.chatId)).filter((row) => eligible(row.pending?.sequence))
        const edges = (yield* pendingEdgesForChat(input.chatId)).filter((row) => eligible(row.pending?.sequence))
        const apps = (yield* pendingAppsForChat(input.chatId)).filter((row) => eligible(row.pending?.sequence))
        const rows: ReadonlyArray<{ kind: "node" | "fact" | "edge" | "app" | "appCodeVersion"; id: string; row: unknown; pendingSequence: number }> = [
          ...nodes.map((row) => ({ kind: "node" as const, id: row.id, row, pendingSequence: row.pending!.sequence! })),
          ...facts.map((row) => ({ kind: "fact" as const, id: row.id, row, pendingSequence: row.pending!.sequence! })),
          ...edges.map((row) => ({ kind: "edge" as const, id: row.id, row, pendingSequence: row.pending!.sequence! })),
          ...apps.map((app) => ({ kind: "app" as const, id: app.id, row: app, pendingSequence: app.pending!.sequence! }))
        ]
        const appVersions = yield* Effect.forEach(apps, (app) => Effect.all([
          aheadOfPointerVersions(app.id, "client", app.clientCodeVersion),
          aheadOfPointerVersions(app.id, "server", app.serverCodeVersion)
        ]).pipe(Effect.map((byKind) => byKind.flat().map((row) => ({
          kind: "appCodeVersion" as const, id: appCodeVersionKey(row), row, pendingSequence: app.pending!.sequence!
        })))))
        const all = [...rows, ...appVersions.flat()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))
        if (all.length === 0) return yield* Effect.fail(new ValidationError({ message: "proposal capture selected no stamped pending changes" }))
        const proposalId = Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())
        const capturedAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
        const snapshot = all.map((entry, selectionPosition) => {
          const canonicalRowBytes = canonicalJsonBytes(entry.row)
          const sha256 = sha256HexSync(canonicalRowBytes)
          const expectedDurableVersion = entry.kind === "appCodeVersion"
            ? String((entry.row as AppCodeVersion).version)
            : entry.kind === "app"
              ? (entry.row as App).updatedAt
              : entry.kind === "node"
                ? (entry.row as NodeEntity).createdAt
                : sha256
          return new AgentChangeSnapshot({
            kind: entry.kind, id: entry.id, canonicalRowBytes, sha256,
            // P5.2 validates these against a fresh live read, and compares canonical bytes
            // synchronously as the final authority (never trusting a digest alone).
            expectedDurableVersion, pendingChatId: input.chatId,
            pendingSequence: entry.pendingSequence, selectionPosition
          })
        })
        // This is an INSERT-only unique identity reservation. The surrounding WDO transaction
        // rolls this back with the evidence and target reservations if any later step fails.
        yield* Effect.try({
          try: () => sql.exec(
            "INSERT INTO agent_change_request_identities (requestId, canonicalPayload, fingerprint, proposalId) VALUES (?, ?, ?, ?)",
            input.requestId, requestCanonicalPayloadText, requestFingerprint, proposalId
          ),
          catch: () => new ValidationError({ message: "request id was already reserved" })
        })
        const proposal = new AgentChangeProposal({
          proposalId, workspaceId, chatId: input.chatId, operation: input.operation, rangeBoundary: input.rangeBoundary,
          requestId: input.requestId, requestCanonicalPayload, requestFingerprint, actor: input.actor, provenance: input.provenance, capturedAt, snapshot
        })
        yield* proposalCollections.proposals.put(proposal).pipe(Effect.mapError(proposalStorageError))
        yield* proposalCollections.decisions.put(new AgentChangeProposalDecision({ proposalId, state: "reserved" })).pipe(Effect.mapError(proposalStorageError))
        let inserted = 0
        yield* Effect.forEach(snapshot, (entry) => Effect.gen(function* () {
          const key = agentChangeReservationKey(entry.kind, entry.id)
          yield* Effect.try({
            try: () => sql.exec(
              `INSERT INTO agent_change_reservation_keys
                (reservationKey, kind, entityId, proposalId, chatId, expectedVersion, expectedDigest, capturedAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              key, entry.kind, entry.id, proposalId, input.chatId, entry.expectedDurableVersion, entry.sha256, capturedAt
            ),
            catch: () => new ValidationError({ message: `pending target ${key} is already reserved` })
          })
          inserted++
          agentChangeCaptureTestHooks.afterReservationInsert?.(inserted)
          yield* proposalCollections.reservations.put(new AgentChangeReservation({
            key, kind: entry.kind, id: entry.id, proposalId,
            expectedDurableVersion: entry.expectedDurableVersion, expectedDigest: entry.sha256, state: "reserved", capturedAt
          })).pipe(Effect.mapError(proposalStorageError))
        }), { discard: true })
        if (agentChangeCaptureTestHooks.unstampCapturedNode) {
          for (const entry of snapshot.filter((entry) => entry.kind === "node")) {
            const node = yield* nodesRepository.get(Schema.decodeUnknownSync(EntityId)(entry.id))
            yield* nodesRepository.put(new NodeEntity({ ...node, pending: new PendingMarker({ chatId: input.chatId }) }))
          }
        }
        return proposal
      })

      const capturedProposalForRequest = (requestId: string): Effect.Effect<AgentChangeProposal | undefined, DomainError> => Effect.gen(function* () {
        const identity = sql.exec<{ proposalId: string }>(
          "SELECT proposalId FROM agent_change_request_identities WHERE requestId = ?", requestId
        ).toArray()[0]
        if (identity === undefined) return undefined
        return yield* proposalCollections.proposals.get(Schema.decodeUnknownSync(EntityId)(identity.proposalId)).pipe(Effect.mapError(proposalStorageError))
      })

      const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
        left.length === right.length && left.every((byte, index) => byte === right[index])

      type SnapshotValue = NodeEntity | Fact | Edge | App | AppCodeVersion

      /** Reads the exact current row named by a snapshot. Missing targets are returned as
       * `undefined` so a stale proposal becomes a durable conflict instead of a partial write. */
      const currentSnapshotValue = (snapshot: AgentChangeSnapshot): Effect.Effect<SnapshotValue | undefined, UnexpectedError> => {
        const id = Schema.decodeUnknownSync(EntityId)(snapshot.id)
        switch (snapshot.kind) {
          case "node":
            return nodesRepository.get(id).pipe(
              Effect.catchTag("NodeNotFound", () => Effect.succeed(undefined))
            )
          case "fact":
            return factsRepository.get(id).pipe(
              Effect.catchTag("FactNotFound", () => Effect.succeed(undefined))
            )
          case "edge":
            return edgesRepository.get(id).pipe(
              Effect.catchTag("EdgeNotFound", () => Effect.succeed(undefined))
            )
          case "app":
            return appsRepository.get(id).pipe(
              Effect.catchTag("AppNotFound", () => Effect.succeed(undefined))
            )
          case "appCodeVersion":
            return appCollections.appCodeVersions.get(snapshot.id).pipe(
              Effect.mapError(appsToUnexpectedError),
              Effect.flatMap((raw) => raw === undefined ? Effect.succeed(undefined) : reviveAppCodeVersion(raw))
            )
        }
      }

      const releaseProposalReservations = (proposalId: EntityId, snapshots: ReadonlyArray<AgentChangeSnapshot>): Effect.Effect<void, UnexpectedError> =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            snapshots,
            (snapshot) => proposalCollections.reservations.delete(agentChangeReservationKey(snapshot.kind, snapshot.id)).pipe(Effect.mapError(proposalStorageError)),
            { discard: true }
          )
          sql.exec("DELETE FROM agent_change_reservation_keys WHERE proposalId = ?", proposalId)
        })

      /** P5.2's exact-decision path. It validates every immutable snapshot against fresh storage
       * before mutating anything; one stale/missing target conflicts the whole proposal. */
      const decideAgentChangeProposal = (input: {
        proposalId: EntityId
        decision: "accept" | "reject"
      }): Effect.Effect<"accepted" | "rejected" | "conflicted", DomainError> => Effect.gen(function* () {
        const proposal = yield* proposalCollections.proposals.get(input.proposalId).pipe(Effect.mapError(proposalStorageError))
        if (proposal === undefined || proposal.workspaceId !== workspaceId) {
          return yield* Effect.fail(new ValidationError({ message: "agent change proposal was not found in this workspace" }))
        }
        const existing = yield* proposalCollections.decisions.get(input.proposalId).pipe(Effect.mapError(proposalStorageError))
        if (existing === undefined) {
          return yield* Effect.fail(new UnexpectedError({ message: "agent change proposal has no decision row" }))
        }
        if (existing.state !== "reserved") {
          return existing.state === "accepted" || existing.state === "rejected" || existing.state === "conflicted"
            ? existing.state
            : yield* Effect.fail(new ValidationError({ message: `unsupported terminal proposal state ${existing.state}` }))
        }

        const current = new Map<string, SnapshotValue>()
        let fresh = true
        for (const snapshot of proposal.snapshot) {
          const value = yield* currentSnapshotValue(snapshot)
          if (value === undefined) {
            fresh = false
            continue
          }
          const bytes = canonicalJsonBytes(value)
          if (!bytesEqual(bytes, snapshot.canonicalRowBytes) || sha256HexSync(bytes) !== snapshot.sha256) fresh = false
          current.set(`${snapshot.kind}:${snapshot.id}`, value)
        }

        if (!fresh) {
          yield* proposalCollections.decisions.put(new AgentChangeProposalDecision({ proposalId: input.proposalId, state: "conflicted" })).pipe(Effect.mapError(proposalStorageError))
          yield* releaseProposalReservations(input.proposalId, proposal.snapshot)
          return "conflicted"
        }

        if (input.decision === "accept") {
          const promotedApps = new Set<string>()
          for (const snapshot of proposal.snapshot) {
            const value = current.get(`${snapshot.kind}:${snapshot.id}`)
            if (value === undefined) continue
            switch (snapshot.kind) {
              case "node": yield* promoteNode(value as NodeEntity); break
              case "fact": yield* promoteFact(value as Fact); break
              case "edge": yield* promoteEdge(value as Edge); break
              case "app":
                if (!promotedApps.has(snapshot.id)) {
                  yield* promoteApp(value as App)
                  promotedApps.add(snapshot.id)
                }
                break
              case "appCodeVersion": break
            }
          }
        } else {
          const revertedApps = new Set<string>()
          for (const snapshot of proposal.snapshot) {
            const value = current.get(`${snapshot.kind}:${snapshot.id}`)
            if (value === undefined) continue
            switch (snapshot.kind) {
              case "node": yield* nodesRepository.delete(Schema.decodeUnknownSync(EntityId)(snapshot.id)); break
              case "fact": yield* factsRepository.delete(Schema.decodeUnknownSync(EntityId)(snapshot.id)); break
              case "edge": yield* edgesRepository.delete(Schema.decodeUnknownSync(EntityId)(snapshot.id)); break
              case "app":
                if (!revertedApps.has(snapshot.id)) {
                  yield* revertApp(value as App)
                  revertedApps.add(snapshot.id)
                }
                break
              case "appCodeVersion":
                if (!revertedApps.has((value as AppCodeVersion).appId)) {
                  yield* appCollections.appCodeVersions.delete(snapshot.id).pipe(Effect.mapError(appsToUnexpectedError))
                }
                break
            }
          }
        }

        const state = input.decision === "accept" ? "accepted" : "rejected"
        yield* proposalCollections.decisions.put(new AgentChangeProposalDecision({ proposalId: input.proposalId, state })).pipe(Effect.mapError(proposalStorageError))
        yield* releaseProposalReservations(input.proposalId, proposal.snapshot)
        return state
      })

      const mergeChanges = (chatId: EntityId, mergeThrough: number): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          yield* getChatRow(chatId)
          const nodes = yield* pendingNodesForChat(chatId)
          const facts = yield* pendingFactsForChat(chatId)
          const edges = yield* pendingEdgesForChat(chatId)
          const apps = yield* pendingAppsForChat(chatId)
          yield* Effect.forEach(
            nodes.filter((n) => n.pending!.sequence !== undefined && n.pending!.sequence <= mergeThrough),
            promoteNode,
            { discard: true }
          )
          yield* Effect.forEach(
            facts.filter((f) => f.pending!.sequence !== undefined && f.pending!.sequence <= mergeThrough),
            promoteFact,
            { discard: true }
          )
          yield* Effect.forEach(
            edges.filter((e) => e.pending!.sequence !== undefined && e.pending!.sequence <= mergeThrough),
            promoteEdge,
            { discard: true }
          )
          yield* Effect.forEach(
            apps.filter((a) => a.pending!.sequence !== undefined && a.pending!.sequence <= mergeThrough),
            promoteApp,
            { discard: true }
          )
        })

      const revertChanges = (chatId: EntityId, revertFrom: number): Effect.Effect<void, DomainError> =>
        Effect.gen(function* () {
          yield* getChatRow(chatId)
          const nodes = yield* pendingNodesForChat(chatId)
          const facts = yield* pendingFactsForChat(chatId)
          const edges = yield* pendingEdgesForChat(chatId)
          const apps = yield* pendingAppsForChat(chatId)
          yield* Effect.forEach(
            nodes.filter((n) => n.pending!.sequence !== undefined && n.pending!.sequence >= revertFrom),
            (n) => nodesRepository.delete(n.id),
            { discard: true }
          )
          yield* Effect.forEach(
            facts.filter((f) => f.pending!.sequence !== undefined && f.pending!.sequence >= revertFrom),
            (f) => factsRepository.delete(f.id),
            { discard: true }
          )
          yield* Effect.forEach(
            edges.filter((e) => e.pending!.sequence !== undefined && e.pending!.sequence >= revertFrom),
            (e) => edgesRepository.delete(e.id),
            { discard: true }
          )
          yield* Effect.forEach(
            apps.filter((a) => a.pending!.sequence !== undefined && a.pending!.sequence >= revertFrom),
            revertApp,
            { discard: true }
          )
        })

      // --- reconcilePendingChanges (§Q15's crash-safety sweep) ---------------------------------

      /** Every entity id referenced by any `"tool"`-role logged message in this chat — the "was
       *  this pending record's creation logged" half of §Q15's set-difference. Malformed/legacy
       *  content (shouldn't occur — every writer here uses the same JSON shape) is skipped rather
       *  than failing the sweep. */
      const loggedEntityIds = (chatId: EntityId): Effect.Effect<ReadonlySet<string>, UnexpectedError> =>
        listChatMessagesSorted(chatId).pipe(
          Effect.map((messages) => {
            const ids = new Set<string>()
            for (const message of messages) {
              if (message.role !== "tool") continue
              try {
                const parsed = JSON.parse(message.content) as { entityIds?: ReadonlyArray<string> }
                for (const id of parsed.entityIds ?? []) ids.add(id)
              } catch {
                // Not this convention's JSON shape — ignore.
              }
            }
            return ids
          })
        )

      /**
       * §Q15's crash-safety sweep, reimplemented exactly: for every UNSTAMPED pending node/fact/
       * edge this chat owns (`pending.sequence === undefined`), a set-difference against
       * `loggedEntityIds` decides its fate — **re-adopt** (its id appears in some `"tool"`-role
       * log message: the tool call that created it was logged, but the crash landed before the
       * flush that would have stamped it — so this sweep performs that flush now, on its own
       * fresh `ChangesMessage`) or **reap** (its id appears nowhere in the log at all: the crash
       * landed before even the tool call was logged, so there is no record this was ever a real,
       * intentional mutation — delete it). A record that already has `pending.sequence` set is
       * untouched either way — it was already durably flushed, nothing to reconcile.
       */
      const reconcilePendingChanges = (chatId: EntityId): Effect.Effect<ReconcileResult, DomainError> =>
        Effect.gen(function* () {
          const logged = yield* loggedEntityIds(chatId)
          // A reserved target is deliberate in-flight proposal evidence, not a crash orphan.
          // Reconciliation must not mutate or reap it until the P5.2 terminal decision path owns it.
          const reserved = new Set(sql.exec<{ reservationKey: string }>(
            "SELECT reservationKey FROM agent_change_reservation_keys WHERE chatId = ?", chatId
          ).toArray().map((row) => row.reservationKey))
          // Filter against authoritative storage *before* selecting unstamped crash candidates.
          // This is what makes the branch real when a restart observes a reservation plus a
          // partially persisted pending marker.
          const nodes = (yield* pendingNodesForChat(chatId)).filter((n) =>
            !reserved.has(agentChangeReservationKey("node", n.id)) && n.pending!.sequence === undefined)
          const facts = (yield* pendingFactsForChat(chatId)).filter((f) =>
            !reserved.has(agentChangeReservationKey("fact", f.id)) && f.pending!.sequence === undefined)
          const edges = (yield* pendingEdgesForChat(chatId)).filter((e) =>
            !reserved.has(agentChangeReservationKey("edge", e.id)) && e.pending!.sequence === undefined)
          const apps = (yield* pendingAppsForChat(chatId)).filter((a) =>
            !reserved.has(agentChangeReservationKey("app", a.id)) && a.pending!.sequence === undefined)

          let reAdopted = 0
          let reaped = 0

          for (const node of nodes) {
            if (logged.has(node.id)) {
              const sequence = yield* nextChangesSequence(chatId)
              yield* collections.changesMessages
                .put(
                  new ChangesMessage({
                    chatId,
                    sequence,
                    createdNodes: [new CreatedNodeSummary({ nodeId: node.id, title: node.title })]
                  })
                )
                .pipe(Effect.mapError(toUnexpectedError))
              yield* stampPending({ kind: "node", id: node.id }, chatId, sequence)
              reAdopted++
            } else {
              yield* nodesRepository.delete(node.id)
              reaped++
            }
          }

          for (const fact of facts) {
            if (logged.has(fact.id)) {
              const sequence = yield* nextChangesSequence(chatId)
              yield* collections.changesMessages
                .put(
                  new ChangesMessage({
                    chatId,
                    sequence,
                    addedFacts: [new AddedFactSummary({ factId: fact.id, nodeId: fact.nodeId, predicateId: fact.predicateId })]
                  })
                )
                .pipe(Effect.mapError(toUnexpectedError))
              yield* stampPending({ kind: "fact", id: fact.id }, chatId, sequence)
              reAdopted++
            } else {
              yield* factsRepository.delete(fact.id)
              reaped++
            }
          }

          for (const edge of edges) {
            if (logged.has(edge.id)) {
              const sequence = yield* nextChangesSequence(chatId)
              yield* collections.changesMessages
                .put(
                  new ChangesMessage({
                    chatId,
                    sequence,
                    addedEdges: [
                      new AddedEdgeSummary({
                        edgeId: edge.id,
                        relationDefinitionId: edge.relationDefinitionId,
                        sourceNodeId: edge.sourceNodeId,
                        targetNodeId: edge.targetNodeId
                      })
                    ]
                  })
                )
                .pipe(Effect.mapError(toUnexpectedError))
              yield* stampPending({ kind: "edge", id: edge.id }, chatId, sequence)
              reAdopted++
            } else {
              yield* edgesRepository.delete(edge.id)
              reaped++
            }
          }

          // Every unstamped pending App this chat holds was necessarily produced by `createAppTool`
          // (the sole writer of an initial, unstamped `App.pending` marker — `updateAppCodeTool`
          // never touches `pending` itself, see `stampPending`'s `"app"` case doc comment), so its
          // re-adopt summary is always `createdApps`, mirroring the `nodes` loop above exactly.
          for (const app of apps) {
            if (logged.has(app.id)) {
              const sequence = yield* nextChangesSequence(chatId)
              yield* collections.changesMessages
                .put(
                  new ChangesMessage({
                    chatId,
                    sequence,
                    createdApps: [new CreatedAppSummary({ appId: app.id, title: app.title })]
                  })
                )
                .pipe(Effect.mapError(toUnexpectedError))
              yield* stampPending({ kind: "app", id: app.id }, chatId, sequence)
              reAdopted++
            } else {
              // Reap: the crash landed before even the tool call was logged, so this App (and any
              // code version rows an immediately-following, same-turn `updateAppCodeTool` call may
              // have written before the crash — cascade-deleted here, same as `deleteApp`'s own
              // cascade in `apps-service-live.ts`) never became a real, intentional mutation.
              const orphanedVersions = yield* appCollections.appCodeVersions.byAppId.get(app.id).pipe(
                Effect.mapError(appsToUnexpectedError),
                Effect.flatMap((raw) => Effect.forEach(raw, reviveAppCodeVersion))
              )
              yield* Effect.forEach(
                orphanedVersions,
                (row) => appCollections.appCodeVersions.delete(appCodeVersionKey(row)).pipe(Effect.mapError(appsToUnexpectedError)),
                { discard: true }
              )
              yield* appsRepository.delete(app.id)
              reaped++
            }
          }

          return { reAdopted, reaped }
        })

      // --- sendChatMessage: one full agent turn ------------------------------------------------

      const toChatMessage = (record: ChatMessageRecord): ChatMessage => {
        if (record.role === "user") {
          return new ChatMessage({ role: "user", content: [new ChatTextBlock({ type: "text", text: record.content })] })
        }
        if (record.role === "assistant") {
          const blocks: Array<ChatContentBlock> = []
          if (record.content.length > 0) blocks.push(new ChatTextBlock({ type: "text", text: record.content }))
          for (const call of record.toolCalls ?? []) {
            blocks.push(new ChatToolUseBlock({ type: "tool_use", id: call.id, name: call.name, input: call.input }))
          }
          return new ChatMessage({ role: "assistant", content: blocks })
        }
        // role === "tool"
        const parsed = JSON.parse(record.content) as { toolUseId: string; result: string; isError?: boolean }
        return new ChatMessage({
          role: "user",
          content: [
            new ChatToolResultBlock({
              type: "tool_result",
              toolUseId: parsed.toolUseId,
              content: parsed.result,
              isError: parsed.isError
            })
          ]
        })
      }

      const buildChatThread = (chatId: EntityId): Effect.Effect<ChatThread, UnexpectedError> =>
        listChatMessagesSorted(chatId).pipe(
          Effect.map((messages) => new ChatThread({ systemPrompt: SYSTEM_PROMPT, messages: messages.map(toChatMessage) }))
        )

      /** Injects the turn's `chatId` (context, never model-supplied — see `TOOL_SPECS`'s own doc
       *  comment) into a raw tool-call input before validating it against its real agent-tools.ts
       *  schema. */
      const decodeToolInput = <A, I>(
        schema: Schema.Schema<A, I>,
        chatId: EntityId,
        rawInput: unknown
      ): Effect.Effect<A, ValidationError> =>
        Schema.decodeUnknown(schema)({
          ...(typeof rawInput === "object" && rawInput !== null ? rawInput : {}),
          chatId
        }).pipe(
          Effect.mapError((parseError) => new ValidationError({ message: `invalid tool input: ${parseError.message}` }))
        )

      /** Runs the real tool implementation for one `ToolCallRequest`, normalizing its output into
       *  the `{resultText, refs, batch}` shape `executeToolCall` needs — never itself logs or
       *  flushes (that's `executeToolCall`'s uniform job for every tool, below). */
      const dispatchTool = (
        chatId: EntityId,
        call: ToolCallRequest,
        context: AgentLoroEditContext
      ): Effect.Effect<ToolDispatchOutcome, DomainError> =>
        Effect.gen(function* () {
          switch (call.name) {
            case "readNote": {
              const input = yield* decodeToolInput(ReadNoteToolInput, chatId, call.input)
              const output = yield* readNoteTool(input)
              return { resultText: JSON.stringify(output), refs: [], batch: {} }
            }
            case "editNote": {
              const input = yield* decodeToolInput(EditNoteToolInput, chatId, call.input)
              const output = yield* editNoteTool(input, call.id, context)
              return { resultText: JSON.stringify(output), refs: [], batch: {} }
            }
            case "createNode": {
              const input = yield* decodeToolInput(CreateNodeToolInput, chatId, call.input)
              const output = yield* createNodeTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: [{ kind: "node" as const, id: output.nodeId }],
                batch: { createdNodes: [new CreatedNodeSummary({ nodeId: output.nodeId, title: input.title })] }
              }
            }
            case "addFact": {
              const input = yield* decodeToolInput(AddFactToolInput, chatId, call.input)
              const nodeId = yield* resolveNodeBinding(chatId, input.binding)
              const output = yield* addFactTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: [{ kind: "fact" as const, id: output.factId }],
                batch: {
                  addedFacts: [new AddedFactSummary({ factId: output.factId, nodeId, predicateId: input.predicateId })]
                }
              }
            }
            case "addEdge": {
              const input = yield* decodeToolInput(AddEdgeToolInput, chatId, call.input)
              const sourceNodeId = yield* resolveNodeBinding(chatId, input.sourceBinding)
              const targetNodeId = yield* resolveNodeBinding(chatId, input.targetBinding)
              const output = yield* addEdgeTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: [{ kind: "edge" as const, id: output.edgeId }],
                batch: {
                  addedEdges: [
                    new AddedEdgeSummary({
                      edgeId: output.edgeId,
                      relationDefinitionId: input.relationDefinitionId,
                      sourceNodeId,
                      targetNodeId
                    })
                  ]
                }
              }
            }
            case "linkCalendarEvent": {
              const input = yield* decodeToolInput(LinkCalendarEventToolInput, chatId, call.input)
              yield* linkCalendarEventTool(input)
              return { resultText: "", refs: [], batch: {} }
            }
            case "createApp": {
              const input = yield* decodeToolInput(CreateAppToolInput, chatId, call.input)
              const output = yield* createAppTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: [{ kind: "app" as const, id: output.appId }],
                batch: { createdApps: [new CreatedAppSummary({ appId: output.appId, title: input.title })] }
              }
            }
            case "updateAppCode": {
              const input = yield* decodeToolInput(UpdateAppCodeToolInput, chatId, call.input)
              const appId = yield* resolveAppBinding(chatId, input.binding)
              const output = yield* updateAppCodeTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: [{ kind: "app" as const, id: appId }],
                batch: { updatedAppCode: [new UpdatedAppCodeSummary({ appId, kind: input.kind, version: output.version })] }
              }
            }
            case "defineSupertag": {
              const input = yield* decodeToolInput(DefineSupertagToolInput, chatId, call.input)
              const output = yield* defineSupertagTool(input)
              // No pending row (mainline schema mutation, like `createTag`) — empty `refs`/`batch`,
              // same shape `readNote`/`editNote` above use for the identical reason.
              return { resultText: JSON.stringify(output), refs: [], batch: {} }
            }
            case "applySupertag": {
              const input = yield* decodeToolInput(ApplySupertagToolInput, chatId, call.input)
              const nodeId = yield* resolveNodeBinding(chatId, input.binding)
              const output = yield* applySupertagTool(input)
              return {
                resultText: JSON.stringify(output),
                refs: output.factIds.map((factId) => ({ kind: "fact" as const, id: factId })),
                batch: {
                  addedFacts: output.factIds.map(
                    (factId, index) =>
                      new AddedFactSummary({
                        factId,
                        nodeId,
                        predicateId: (input.fieldValues ?? [])[index]!.fieldId
                      })
                  )
                }
              }
            }
            default:
              return yield* Effect.fail(new ValidationError({ message: `unknown tool "${call.name}"` }))
          }
        })

      /**
       * Dispatches one `ToolCallRequest`, then uniformly logs the result (`"tool"`-role
       * `ChatMessageRecord`, per this file's header comment's JSON convention) and — unless the
       * call produced no pending entities (`readNote`/`editNote`) or a test has asked to skip it
       * (`agentEditTestHooks.skipFlush`) — flushes those entities into their own `ChangesMessage`
       * and stamps `pending.sequence`, all in the same Effect step (§Q15's "same synchronous DO
       * step" — see `agentEditTestHooks`'s own doc comment for how a test simulates a crash
       * landing between the log and the flush). A tool failure (any `DomainError`) is converted
       * into an `isError: true` tool-result log entry rather than aborting the turn — the model
       * sees its own tool's error on the next `converse` call and can try something else, matching
       * real tool-calling conventions; only a `ModelClient.converse` failure or a storage-layer
       * `UnexpectedError` propagates out of `sendChatMessage` itself.
       */
      const executeToolCall = (
        chatId: EntityId,
        call: ToolCallRequest,
        context: AgentLoroEditContext
      ): Effect.Effect<{ logMessage: ChatMessageRecord | undefined; changesSequence: number | undefined }, DomainError> =>
        Effect.gen(function* () {
          const outcome = yield* Effect.either(dispatchTool(chatId, call, context))

          // `encodeRpcError` (not `error.message`) — every `Data.TaggedError` subclass here
          // structurally inherits a `.message` from JS's own `Error`, but most of these classes
          // (e.g. `ChatBindingNotFound`) never set it, leaving it silently `""`; `encodeRpcError`
          // is the domain package's own canonical "flatten a `DomainError` to a real message"
          // logic (rpc-error.ts), already correct for every tag.
          const resultText = outcome._tag === "Right" ? outcome.right.resultText : encodeRpcError(outcome.left).message
          const isError = outcome._tag === "Left"
          const refs = outcome._tag === "Right" ? outcome.right.refs : []
          const batch = outcome._tag === "Right" ? outcome.right.batch : {}

          const logMessage = agentEditTestHooks.skipToolLog
            ? undefined
            : yield* addChatMessage(
                chatId,
                "tool",
                JSON.stringify({ toolUseId: call.id, entityIds: refs.map((r) => r.id), result: resultText, isError })
              )

          if (agentEditTestHooks.skipFlush || refs.length === 0) {
            return { logMessage, changesSequence: undefined }
          }

          const sequence = yield* nextChangesSequence(chatId)
          yield* collections.changesMessages
            .put(new ChangesMessage({ chatId, sequence, ...batch }))
            .pipe(Effect.mapError(toUnexpectedError))
          yield* Effect.forEach(refs, (ref) => stampPending(ref, chatId, sequence), { discard: true })

          return { logMessage, changesSequence: sequence }
        })

      const sendChatMessage = (
        chatId: EntityId,
        text: string,
        context: AgentLoroEditContext = {}
      ): Effect.Effect<AgentTurnResult, DomainError> =>
        Effect.gen(function* () {
          yield* getChatRow(chatId)
          // §Q15: "reconcilePendingGadgets(chatId)... at agent turn start and end."
          if (!agentEditTestHooks.skipReconcile) yield* reconcilePendingChanges(chatId)

          const userMessage = yield* addChatMessage(chatId, "user", text)
          const produced: Array<ChatMessageRecord> = [userMessage]
          const changesSequences: Array<number> = []

          let iterations = 0
          while (true) {
            iterations++
            if (iterations > MAX_TURN_ITERATIONS) {
              return yield* Effect.fail(
                new UnexpectedError({
                  message: `sendChatMessage: exceeded ${MAX_TURN_ITERATIONS} tool-call iterations for chat ${chatId}`
                })
              )
            }

            const thread = yield* buildChatThread(chatId)
            const result = yield* modelClient.converse(thread, TOOL_SPECS).pipe(
              Effect.mapError(
                (modelError) =>
                  new UnexpectedError({ message: `ModelClient.converse failed: ${modelError._tag}: ${modelError.message}` })
              )
            )

            if (result.kind === "final_text") {
              const assistantMessage = yield* addChatMessage(chatId, "assistant", result.text)
              produced.push(assistantMessage)
              if (!agentEditTestHooks.skipReconcile) yield* reconcilePendingChanges(chatId)
              return { messages: produced, changesSequences }
            }

            const assistantToolMessage = yield* addChatMessage(chatId, "assistant", "", result.calls)
            produced.push(assistantToolMessage)

            for (const call of result.calls) {
              const { logMessage, changesSequence } = yield* executeToolCall(chatId, call, context)
              if (logMessage !== undefined) produced.push(logMessage)
              if (changesSequence !== undefined) changesSequences.push(changesSequence)
            }
          }
        })

      return {
        createChat: (workspaceIdArg, title) =>
          Effect.gen(function* () {
            void workspaceIdArg
            const chat = new Chat({
              id: Schema.decodeUnknownSync(EntityId)(crypto.randomUUID()),
              workspaceId,
              title,
              createdAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
            })
            yield* collections.chats.put(chat).pipe(Effect.mapError(toUnexpectedError))
            return chat
          }),

        listChats: (workspaceIdArg) =>
          Effect.gen(function* () {
            void workspaceIdArg
            const raw = yield* collections.chats.byWorkspaceId.get(workspaceId).pipe(Effect.mapError(toUnexpectedError))
            return yield* Effect.forEach(raw, reviveChat)
          }),

        getChat: (chatId) =>
          Effect.gen(function* () {
            const chat = yield* getChatRow(chatId)
            const messages = yield* listChatMessagesSorted(chatId)
            return { chat, messages }
          }),

        addChatMessage,
        sendChatMessage,
        mergeChanges,
        revertChanges,
        listChatChanges: listChangesSorted,
        captureProposalAndReserve,
        capturedProposalForRequest,
        decideAgentChangeProposal,
        listPendingChanges: (chatId) =>
          Effect.gen(function* () {
            yield* getChatRow(chatId)
            const nodes = yield* pendingNodesForChat(chatId)
            const facts = yield* pendingFactsForChat(chatId)
            const edges = yield* pendingEdgesForChat(chatId)
            return { nodes, facts, edges }
          }),
        reconcilePendingChanges,

        readNoteTool,
        editNoteTool,
        createNodeTool,
        addFactTool,
        addEdgeTool,
        linkCalendarEventTool,
        createAppTool,
        updateAppCodeTool,
        defineSupertagTool,
        applySupertagTool
      }
    })
  )
