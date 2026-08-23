// Compatibility RPC façade for durable PageProposal records. Page sync transport stays direct.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PageNotFound, PageProposalProvenance, UnexpectedError, ValidationError, type EntityId } from "@athenaeum/domain"
import { PageProposalService } from "./page-proposal-service-live.js"

export interface ChatForkPreview { readonly forked: boolean; readonly text: string }

export class ChatForkService extends Context.Tag("@athenaeum/backend/ChatForkService")<ChatForkService, {
  readonly fork: (chatId: string, nodeId: EntityId) => Effect.Effect<{ text: string }, PageNotFound | ValidationError | UnexpectedError>
  readonly applyForkEdit: (chatId: string, nodeId: EntityId, index: number, deleteCount: number, insertText: string) => Effect.Effect<{ text: string }, ValidationError | PageNotFound | UnexpectedError>
  readonly previewFork: (chatId: string, nodeId: EntityId) => Effect.Effect<ChatForkPreview, never>
  /** Returns the durable proposal identity used as the accept ledger identity; accepted rows are replayable. */
  readonly proposalForAcceptance: (chatId: string, nodeId: EntityId) => Effect.Effect<import("@athenaeum/domain").PageProposal, ValidationError | UnexpectedError>
  readonly accept: (proposalId: EntityId) => Effect.Effect<{ page: import("@athenaeum/domain").Page; text: string; publish: () => void }, ValidationError | PageNotFound | UnexpectedError>
  readonly revert: (chatId: string, nodeId: EntityId) => Effect.Effect<void, never>
}>() {}

const provenance = (chatId: string, nodeId: EntityId) => new PageProposalProvenance({
  chatId,
  assistantMessageId: `chat-fork:${nodeId}`,
  // Chat forks have a stable chat/node lookup but each accepted/reverted cycle must receive a
  // fresh proposal identity. Repeated fork calls while a proposal remains open return that row.
  toolCallId: `chat-fork:${nodeId}:${crypto.randomUUID()}`,
  toolName: "editNote",
  source: "agent" as const
})

export const makeChatForkServiceLive = (workspaceId: EntityId): Layer.Layer<ChatForkService, never, PageProposalService> =>
  Layer.effect(ChatForkService, Effect.gen(function* () {
    const proposals = yield* PageProposalService
    return {
      fork: (chatId, nodeId) => Effect.gen(function* () {
        const pending = yield* proposals.findPendingChatFork(chatId, nodeId).pipe(Effect.option)
        if (pending._tag === "Some") {
          const preview = yield* proposals.preview(pending.value.proposalId)
          return { text: preview.text }
        }
        const proposal = yield* proposals.propose({ workspaceId, nodeId, index: 0, deleteCount: 0, insertText: "", rationale: "Chat-authored page edit awaiting explicit acceptance.", provenance: provenance(chatId, nodeId) })
        const preview = yield* proposals.preview(proposal.proposalId)
        return { text: preview.text }
      }),
      applyForkEdit: (chatId, nodeId, index, deleteCount, insertText) => Effect.gen(function* () {
        const proposal = yield* proposals.findPendingChatFork(chatId, nodeId)
        const updated = yield* proposals.applyEdit(proposal.proposalId, index, deleteCount, insertText)
        const preview = yield* proposals.preview(updated.proposalId)
        return { text: preview.text }
      }),
      previewFork: (chatId, nodeId) => proposals.findPendingChatFork(chatId, nodeId).pipe(
        Effect.flatMap((proposal) => proposals.preview(proposal.proposalId)),
        Effect.map(({ text }) => ({ forked: true, text })),
        Effect.catchAll(() => Effect.succeed({ forked: false, text: "" }))
      ),
      proposalForAcceptance: (chatId, nodeId) => proposals.findChatForkForAcceptance(chatId, nodeId),
      accept: (proposalId) => proposals.accept(proposalId).pipe(Effect.map(({ page, text, publish }) => ({ page, text, publish }))),
      revert: (chatId, nodeId) => proposals.findPendingChatFork(chatId, nodeId).pipe(
        Effect.flatMap((proposal) => proposals.revert(proposal.proposalId)), Effect.asVoid,
        Effect.catchAll(() => Effect.void)
      )
    }
  }))
