import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"
import { Page } from "./page.js"
import { PageCommit, PageProposal, PageProposalProvenance } from "./page-proposal.js"

const ProposalInput = {
  workspaceId: EntityId,
  proposalId: EntityId
}

export class ProposePageEditInput extends Schema.Class<ProposePageEditInput>("ProposePageEditInput")({
  workspaceId: EntityId,
  nodeId: EntityId,
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deleteCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  insertText: Schema.String,
  rationale: Schema.String.pipe(Schema.minLength(1)),
  provenance: PageProposalProvenance
}) {}
export class ProposePageEditOutput extends Schema.Class<ProposePageEditOutput>("ProposePageEditOutput")({ proposal: PageProposal }) {}
export class PreviewPageProposalInput extends Schema.Class<PreviewPageProposalInput>("PreviewPageProposalInput")(ProposalInput) {}
export class PreviewPageProposalOutput extends Schema.Class<PreviewPageProposalOutput>("PreviewPageProposalOutput")({ proposal: PageProposal, text: Schema.String }) {}
export class AcceptPageProposalInput extends Schema.Class<AcceptPageProposalInput>("AcceptPageProposalInput")(ProposalInput) {}
export class AcceptPageProposalOutput extends Schema.Class<AcceptPageProposalOutput>("AcceptPageProposalOutput")({ proposal: PageProposal, commit: PageCommit, page: Page, text: Schema.String }) {}
export class RevertPageProposalInput extends Schema.Class<RevertPageProposalInput>("RevertPageProposalInput")(ProposalInput) {}
export class RevertPageProposalOutput extends Schema.Class<RevertPageProposalOutput>("RevertPageProposalOutput")({ proposal: PageProposal }) {}
