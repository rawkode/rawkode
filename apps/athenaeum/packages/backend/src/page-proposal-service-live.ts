import * as Automerge from "@automerge/automerge"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { canonicalAutomergeHeadsHash, IsoDateTimeString, PageCommit, PageNotFound, PageProposal, PageProposalProvenance, type EntityId, UnexpectedError, ValidationError } from "@athenaeum/domain"
import * as Schema from "effect/Schema"
import type { PageDoc } from "./notes-service-live.js"
import { NotesService } from "./notes-service-live.js"
import { type PageProposalCollections, type StoredPageProposal } from "./page-proposal-collections.js"

const timestamp = () => Schema.decodeUnknownSync(IsoDateTimeString)(new Date().toISOString())
const headsHash = (doc: Automerge.Doc<PageDoc>) => canonicalAutomergeHeadsHash(Automerge.getHeads(doc))
const storageFailure = (error: unknown) => new UnexpectedError({ message: `page proposal storage failure: ${error instanceof Error ? error.message : String(error)}` })

export class PageProposalService extends Context.Tag("@athenaeum/backend/PageProposalService")<
  PageProposalService,
  {
    readonly propose: (input: {
      workspaceId: EntityId; nodeId: EntityId; index: number; deleteCount: number; insertText: string;
      rationale: string; provenance: PageProposal["provenance"]
    }) => Effect.Effect<PageProposal, ValidationError | PageNotFound | UnexpectedError>
    readonly preview: (proposalId: EntityId) => Effect.Effect<{ proposal: PageProposal; text: string }, ValidationError | PageNotFound | UnexpectedError>
    /** Legacy chat-fork façade lookup. Only an open proposal is addressable through this path. */
    readonly findPendingChatFork: (chatId: string, nodeId: EntityId) => Effect.Effect<PageProposal, ValidationError | UnexpectedError>
    /** Acceptance lookup also resolves an already accepted proposal so retries can replay its receipt. */
    readonly findChatForkForAcceptance: (chatId: string, nodeId: EntityId) => Effect.Effect<PageProposal, ValidationError | UnexpectedError>
    readonly applyEdit: (proposalId: EntityId, index: number, deleteCount: number, insertText: string) => Effect.Effect<PageProposal, ValidationError | UnexpectedError>
    readonly accept: (proposalId: EntityId) => Effect.Effect<{ proposal: PageProposal; commit: PageCommit; page: import("@athenaeum/domain").Page; text: string; publish: () => void }, ValidationError | PageNotFound | UnexpectedError>
    readonly revert: (proposalId: EntityId) => Effect.Effect<PageProposal, ValidationError | UnexpectedError>
  }
>() {}

export const makePageProposalServiceLive = (collections: PageProposalCollections): Layer.Layer<PageProposalService, never, NotesService> =>
  Layer.effect(PageProposalService, Effect.gen(function* () {
    const notes = yield* NotesService
    // typed-storage serializes Schema.Class values as structural data. Rehydrate the
    // nested provenance class before constructing or returning another PageProposal;
    // otherwise Schema.Class's constructor rejects an otherwise valid stored row.
    const hydrateProposal = (proposal: PageProposal): PageProposal => new PageProposal({
      ...proposal,
      provenance: new PageProposalProvenance({ ...proposal.provenance })
    })
    const hydrateRow = (row: StoredPageProposal): StoredPageProposal => ({ ...row, proposal: hydrateProposal(row.proposal) })
    const hydrateCommit = (commit: PageCommit): PageCommit => new PageCommit({
      ...commit,
      provenance: new PageProposalProvenance({ ...commit.provenance })
    })
    const get = (proposalId: EntityId) => collections.proposals.get(proposalId).pipe(
      Effect.mapError(storageFailure),
      Effect.flatMap((row) => row === undefined ? Effect.fail(new ValidationError({ message: `page proposal ${proposalId} was not found` })) : Effect.succeed(hydrateRow(row)))
    )
    const save = (row: StoredPageProposal) => collections.proposals.put(row).pipe(Effect.mapError(storageFailure), Effect.as(row))
    return {
      propose: (input) => Effect.gen(function* () {
        const rationale = input.rationale.trim()
        if (rationale.length === 0) return yield* Effect.fail(new ValidationError({ message: "proposal rationale must not be blank" }))
        const toolKey = `${input.provenance.chatId}:${input.provenance.toolCallId}`
        const existingRows = yield* collections.proposals.byChatTool.get(toolKey).pipe(Effect.mapError(storageFailure))
        const existing = existingRows.map(hydrateRow)
        const existingProposal = existing
          .sort((left, right) => right.proposal.createdAt.localeCompare(left.proposal.createdAt))
          .at(0)
        if (existingProposal !== undefined) {
          const row = existingProposal
          if (
            row.proposal.workspaceId !== input.workspaceId || row.proposal.nodeId !== input.nodeId ||
            row.proposal.index !== input.index || row.proposal.deleteCount !== input.deleteCount ||
            row.proposal.insertText !== input.insertText || row.proposal.rationale !== rationale ||
            row.proposal.provenance.chatId !== input.provenance.chatId ||
            row.proposal.provenance.assistantMessageId !== input.provenance.assistantMessageId ||
            row.proposal.provenance.toolCallId !== input.provenance.toolCallId ||
            row.proposal.provenance.toolName !== input.provenance.toolName ||
            row.proposal.provenance.source !== input.provenance.source
          ) {
            return yield* Effect.fail(new ValidationError({ message: "tool call id was already used for a different page proposal" }))
          }
          return row.proposal
        }
        const base = yield* notes.loadDocForMerge(input.nodeId)
        const fork = Automerge.change(Automerge.clone<PageDoc>(base), (draft) => {
          Automerge.splice(draft, ["text"], input.index, input.deleteCount, input.insertText)
        })
        const now = timestamp()
        const proposal = new PageProposal({
          proposalId: crypto.randomUUID() as EntityId, workspaceId: input.workspaceId, nodeId: input.nodeId, status: "proposed",
          proposalBytes: Automerge.save(fork), proposalHeadsHash: headsHash(fork), baseHeadsHash: headsHash(base),
          index: input.index, deleteCount: input.deleteCount, insertText: input.insertText,
          rationale, provenance: input.provenance, createdAt: now, updatedAt: now
        })
        yield* save({ proposal, baseBytes: Automerge.save(base) })
        return proposal
      }),
      preview: (proposalId) => Effect.gen(function* () {
        const row = yield* get(proposalId)
        const doc = Automerge.load<PageDoc>(row.proposal.proposalBytes)
        return { proposal: row.proposal, text: doc.text }
      }),
      findPendingChatFork: (chatId, nodeId) => Effect.gen(function* () {
        const rows = yield* collections.proposals.byNode.get(nodeId).pipe(Effect.mapError(storageFailure))
        const hydratedRows = rows.map(hydrateRow)
        const row = hydratedRows
          .filter((candidate) => candidate.proposal.status === "proposed" && candidate.proposal.provenance.chatId === chatId && candidate.proposal.provenance.toolCallId.startsWith(`chat-fork:${nodeId}:`))
          .sort((left, right) => right.proposal.createdAt.localeCompare(left.proposal.createdAt))
          .at(0)
        if (row === undefined) return yield* Effect.fail(new ValidationError({ message: `no active durable proposal for chat ${chatId} on node ${nodeId}` }))
        return row.proposal
      }),
      findChatForkForAcceptance: (chatId, nodeId) => Effect.gen(function* () {
        const rows = yield* collections.proposals.byNode.get(nodeId).pipe(Effect.mapError(storageFailure))
        const hydratedRows = rows.map(hydrateRow)
        const matches = hydratedRows
          .filter((candidate) => (candidate.proposal.status === "proposed" || candidate.proposal.status === "accepted") && candidate.proposal.provenance.chatId === chatId && candidate.proposal.provenance.toolCallId.startsWith(`chat-fork:${nodeId}:`))
          .sort((left, right) => right.proposal.createdAt.localeCompare(left.proposal.createdAt))
        const row = matches.find((candidate) => candidate.proposal.status === "proposed") ?? matches.find((candidate) => candidate.proposal.status === "accepted")
        if (row === undefined) return yield* Effect.fail(new ValidationError({ message: `no durable proposal for chat ${chatId} on node ${nodeId}` }))
        return row.proposal
      }),
      applyEdit: (proposalId, index, deleteCount, insertText) => Effect.gen(function* () {
        const row = yield* get(proposalId)
        if (row.proposal.status !== "proposed") return yield* Effect.fail(new ValidationError({ message: `cannot edit a ${row.proposal.status} page proposal` }))
        const next = Automerge.change(Automerge.load<PageDoc>(row.proposal.proposalBytes), (draft) => {
          Automerge.splice(draft, ["text"], index, deleteCount, insertText)
        })
        const proposal = new PageProposal({ ...row.proposal, proposalBytes: Automerge.save(next), proposalHeadsHash: headsHash(next), updatedAt: timestamp() })
        yield* save({ ...row, proposal })
        return proposal
      }),
      accept: (proposalId) => Effect.gen(function* () {
        const row = yield* get(proposalId)
        if (row.proposal.status === "accepted") {
          const commit = yield* collections.commits.get(proposalId).pipe(Effect.mapError(storageFailure), Effect.flatMap((x) => x === undefined ? Effect.fail(new ValidationError({ message: "accepted proposal has no durable commit" })) : Effect.succeed(hydrateCommit(x))))
          const current = yield* notes.restoreCommittedDoc(row.proposal.nodeId, commit.committedBytes, commit.committedHeadsHash)
          return { proposal: row.proposal, commit, ...current, publish: () => {} }
        }
        if (row.proposal.status !== "proposed") return yield* Effect.fail(new ValidationError({ message: `cannot accept a ${row.proposal.status} page proposal` }))
        const accepting = { ...row, proposal: new PageProposal({ ...row.proposal, status: "accepting", updatedAt: timestamp() }) }
        yield* save(accepting)
        const mainline = yield* notes.loadDocForMerge(row.proposal.nodeId)
        let merged: Automerge.Doc<PageDoc>
        try { merged = Automerge.merge(mainline, Automerge.load<PageDoc>(row.proposal.proposalBytes)) }
        catch (error) {
          yield* save({ ...accepting, proposal: new PageProposal({ ...accepting.proposal, status: "failed", updatedAt: timestamp() }) })
          return yield* Effect.fail(new ValidationError({ message: `proposal does not share the recorded mainline history: ${String(error)}` }))
        }
        // Do all durable fanout before the proposal transition, but deliberately defer cache
        // publication to the WorkspaceDO after its enclosing ledger transaction commits.
        const result = yield* notes.prepareMergedDoc(row.proposal.nodeId, merged)
        const committedAt = timestamp()
        const commit = new PageCommit({ proposalId, committedBytes: Automerge.save(merged), committedHeadsHash: headsHash(merged), committedAt, provenance: row.proposal.provenance })
        const accepted = new PageProposal({ ...accepting.proposal, status: "accepted", updatedAt: committedAt })
        yield* collections.commits.put(commit).pipe(Effect.mapError(storageFailure))
        yield* save({ ...accepting, proposal: accepted })
        return { proposal: accepted, commit, ...result }
      }),
      revert: (proposalId) => Effect.gen(function* () {
        const row = yield* get(proposalId)
        if (row.proposal.status === "accepted") return yield* Effect.fail(new ValidationError({ message: "an accepted proposal cannot be reverted" }))
        if (row.proposal.status === "reverted") return row.proposal
        const proposal = new PageProposal({ ...row.proposal, status: "reverted", updatedAt: timestamp() })
        yield* save({ ...row, proposal })
        return proposal
      })
    }
  }))
