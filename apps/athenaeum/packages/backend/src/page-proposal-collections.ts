import * as Schema from "effect/Schema"
import { PageCommit, PageProposal, type EntityId } from "@athenaeum/domain"
import { collection, createEffectTypedStorage, type Collection, type NonUniqueIndex } from "@athenaeum/typed-storage-effect"

/** Storage-only supplement: base bytes make the recorded base verifiable after an eviction. */
export interface StoredPageProposal {
  readonly proposal: PageProposal
  readonly baseBytes: Uint8Array
}
const proposals = collection<StoredPageProposal>()({
  primaryKey: (row) => row.proposal.proposalId,
  nonUniqueIndexes: {
    byChatTool: (row: StoredPageProposal) => `${row.proposal.provenance.chatId}:${row.proposal.provenance.toolCallId}`,
    byNode: (row: StoredPageProposal) => row.proposal.nodeId,
    byStatus: (row: StoredPageProposal) => row.proposal.status
  }
})
const commits = collection<PageCommit>()({ primaryKey: "proposalId" })

export interface PageProposalCollections {
  readonly proposals: Collection<StoredPageProposal, EntityId> & {
    readonly byChatTool: NonUniqueIndex<StoredPageProposal, string>
    readonly byNode: NonUniqueIndex<StoredPageProposal, EntityId>
    readonly byStatus: NonUniqueIndex<StoredPageProposal, string>
  }
  readonly commits: Collection<PageCommit, EntityId>
}
export const makePageProposalCollections = (storage: DurableObjectStorage): PageProposalCollections => {
  const typed = createEffectTypedStorage(storage, { collections: { pageProposals: proposals, pageCommits: commits } })
  return { proposals: typed.pageProposals, commits: typed.pageCommits }
}
