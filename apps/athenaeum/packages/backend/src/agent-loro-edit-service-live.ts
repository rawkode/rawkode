/** In-runtime semantic Loro gateway for `AgentEditService`.
 *
 * It intentionally does not recurse through the public Cap'n Web RPC. The adapter prepares a
 * bounded text splice from authoritative Loro state, executes the existing ledger protocol in
 * this Workspace DO's transaction, then publishes (or reloads on receipt replay) the cache.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { VersionVector } from "loro-crdt/bundler"
import {
	LoroContentConflict,
	LoroRequestIdentityConflict,
	PageFormatMismatch,
	PageNotFound,
	HumanUiMutationAttribution,
	Unauthorized,
	UnexpectedError,
	ValidationError,
	sha256HexSync,
	type DomainError,
	type EntityId,
} from "@athenaeum/domain"
import {
	LedgerConflict,
	LedgerService,
	agentLoroEditLedgerFingerprint,
} from "./ledger-service.js"
import { WorkspaceLoroMutationGateway } from "./workspace-loro-mutation-gateway.js"
import {
	LoroPageService,
	loroVersionVectorIdentity,
} from "./loro-page-service-live.js"

export interface AgentLoroEditContext {
	/** Set only by WorkspaceRpcApi after its role/authentication gate has run. */
	readonly principal?: string
	readonly policy?: string
}

export type AgentLoroEditResult =
	| { readonly format: "automerge-v1" }
	| { readonly format: "loro-v1"; readonly text: string }

export class AgentLoroEditService extends Context.Tag(
	"@athenaeum/backend/AgentLoroEditService",
)<
	AgentLoroEditService,
	{
		/**
		 * Resolves the authoritative descriptor before selecting a read path.  A migrated Loro
		 * descriptor deliberately retains an immutable Automerge witness, but its
		 * `activeFormat` is still `loro-v1` and must never fall through to legacy reads.
		 */
		readonly read: (nodeId: EntityId) => Effect.Effect<AgentLoroEditResult, DomainError>
		readonly edit: (input: {
			readonly chatId: EntityId
			readonly toolCallId: string
			readonly nodeId: EntityId
			readonly index: number
			readonly deleteCount: number
			readonly insertText: string
			readonly commitMessage: string
			readonly context: AgentLoroEditContext
		}) => Effect.Effect<AgentLoroEditResult, DomainError>
	}
>() {}

export const makeAgentLoroEditServiceLive = (
	workspaceId: EntityId,
	storage: DurableObjectStorage,
	ledger: LedgerService,
): Layer.Layer<AgentLoroEditService, never, LoroPageService> =>
	Layer.effect(
		AgentLoroEditService,
		Effect.gen(function* () {
			const loro = yield* LoroPageService
			return {
				read: (nodeId) =>
					Effect.gen(function* () {
						const descriptor = yield* loro.getDescriptor(nodeId)
						if (descriptor.activeFormat === "automerge-v1") {
							return { format: "automerge-v1" }
						}
						return { format: "loro-v1", text: yield* loro.getText(nodeId) }
					}),
				edit: (input) =>
					Effect.gen(function* () {
						const descriptor = yield* loro.getDescriptor(input.nodeId)
						if (descriptor.activeFormat === "automerge-v1")
							return { format: "automerge-v1" }
						if (
							input.context.principal === undefined ||
							input.context.policy === undefined
						) {
							return yield* Effect.fail(
								new Unauthorized({
									message:
										"A trusted workspace mutation context is required for Loro agent edits.",
								}),
							)
						}

						const requestId = `agent-edit:${input.chatId}:${input.toolCallId}`
						const requestIdentity = requestId
						// Chat is a user-directed UI surface, not a workforce job. Keep the private
						// chat/tool correlation in custody rather than fabricating job/run ids.
						const attribution = new HumanUiMutationAttribution({
							version: "athenaeum.mutation-attribution.v1",
							kind: "humanUi",
							surface: "agent-chat",
						})
						const fingerprint = agentLoroEditLedgerFingerprint({
							requestId,
							workspaceId,
							principal: input.context.principal,
							policy: input.context.policy,
							nodeId: input.nodeId,
							index: input.index,
							deleteCount: input.deleteCount,
							insertText: input.insertText,
							commitMessage: input.commitMessage,
							attribution,
						})
						const custody = {
							requestIdentity, fingerprint, type: "commitLoroPageContent" as const, workspaceId,
							actorKind: "user" as const, actorLabel: "You", targetKind: "node" as const, targetId: input.nodeId,
							chatId: input.chatId, toolCallId: input.toolCallId
						}
						const replayed = yield* Effect.try({
							try: () => storage.transactionSync(() => {
								const exists = ledger.hasV2Receipt(requestIdentity, fingerprint, "commitLoroPageContent")
								if (exists) ledger.validateCustody(custody)
								return exists
							}),
							catch: (error): DomainError => error instanceof LedgerConflict
								? new LoroRequestIdentityConflict({ nodeId: input.nodeId, requestId })
								: new UnexpectedError({ message: `agent Loro replay check failed: ${error instanceof Error ? error.message : String(error)}` })
						})
						if (replayed) {
							yield* loro.reloadCommittedDocument(input.nodeId)
							return { format: "loro-v1", text: yield* loro.getText(input.nodeId) }
						}
						// A concurrent identical call can pass this preflight before the first commit; the
						// gateway replay branch below remains authoritative in that race.
						const splice = yield* loro.prepareTextSplice(input)
						const base = {
							requestIdentity,
							requestId,
							workspaceId,
							principal: input.context.principal,
							policy: input.context.policy,
							nodeId: input.nodeId,
							expectedStorageVersion: splice.expectedStorageVersion,
							expectedSnapshotSha256: splice.expectedSnapshotSha256,
							// `commitContent` verifies these bytes again. The ledger stores only the semantic
							// digest, matching the public Loro ingress.
							baseVersionVectorSha256: loroVersionVectorIdentity(
								VersionVector.decode(splice.expectedVersionVector),
							),
							updateSha256: sha256HexSync(splice.update),
							updateLength: splice.update.length,
							commitMessage: input.commitMessage,
							attribution,
						}
						const gateway = new WorkspaceLoroMutationGateway(ledger, loro, storage)
						const committed = yield* Effect.try({
								try: () => storage.transactionSync(() => gateway.commitContentWithinTransaction({
									requestIdentity,
									fingerprint,
									command: base,
									custody,
								expectedVersionVector: splice.expectedVersionVector,
								update: splice.update,
								agentChatBinding: {
									index: input.index, deleteCount: input.deleteCount, insertText: input.insertText
								}
							})),
							catch: (error): DomainError =>
								error instanceof LoroContentConflict
									? error
									: error instanceof LedgerConflict
										? new LoroRequestIdentityConflict({ nodeId: input.nodeId, requestId })
										: error instanceof PageFormatMismatch || error instanceof PageNotFound || error instanceof ValidationError || error instanceof UnexpectedError
											? error
											: new UnexpectedError({ message: `ledgered agent Loro edit failed: ${error instanceof Error ? error.message : String(error)}` })
						})
						committed.finalize()
						if (committed.output.descriptor.activeFormat !== "loro-v1") {
							throw new UnexpectedError({ message: "Loro content commit returned a non-Loro descriptor" })
						}
						return { format: "loro-v1", text: yield* loro.getText(input.nodeId) }
					}),
			}
		}),
	)
