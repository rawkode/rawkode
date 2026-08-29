/** In-runtime semantic Loro gateway for `AgentEditService`.
 *
 * It intentionally does not recurse through the public Cap'n Web RPC. The adapter prepares a
 * bounded text splice from authoritative Loro state, executes the existing ledger protocol in
 * this Workspace DO's transaction, then publishes (or reloads on receipt replay) the cache.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { VersionVector } from "loro-crdt/bundler"
import {
	CommitLoroPageContentOutput,
	LoroContentConflict,
	LoroRequestIdentityConflict,
	PageFormatMismatch,
	PageNotFound,
	AgentJobMutationAttribution,
	Unauthorized,
	UnexpectedError,
	ValidationError,
	canonicalJsonBytes,
	sha256HexSync,
	type DomainError,
	type EntityId,
} from "@athenaeum/domain"
import {
	LedgerConflict,
	LedgerService,
	type CommitLoroPageContentLedgerCommandInput,
} from "./ledger-service.js"
import {
	LoroPageService,
	loroVersionVectorIdentity,
	type PreparedLoroContentCommit,
} from "./loro-page-service-live.js"
import { domainErrorFromCause } from "./rpc-boundary.js"

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

						const splice = yield* loro.prepareTextSplice(input)
						const requestId = `agent-edit:${input.chatId}:${input.toolCallId}`
						const requestIdentity = requestId
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
							attribution: new AgentJobMutationAttribution({
								version: "athenaeum.mutation-attribution.v1",
								kind: "agentJob",
								jobId: input.chatId,
								runId: input.toolCallId,
							}),
						}
						const fingerprint = sha256HexSync(
							canonicalJsonBytes({
								version: "athenaeum.agent-loro-edit.v1",
								requestId,
								workspaceId,
								principal: input.context.principal,
								policy: input.context.policy,
								nodeId: input.nodeId,
								index: input.index,
								deleteCount: input.deleteCount,
								insertText: input.insertText,
								commitMessage: input.commitMessage,
								attribution: {
									version: "athenaeum.mutation-attribution.v1",
									kind: "agentJob",
									jobId: input.chatId,
									runId: input.toolCallId,
								},
							}),
						)
						let prepared: PreparedLoroContentCommit | undefined
						yield* Effect.try({
							try: () =>
								storage.transactionSync(() =>
									ledger.executeV2({
										requestIdentity,
										fingerprint,
										type: "commitLoroPageContent",
										mutate: () => {
											const exit = Effect.runSyncExit(
												loro.commitContent({
													nodeId: input.nodeId,
													expectedStorageVersion: splice.expectedStorageVersion,
													expectedSnapshotSha256: splice.expectedSnapshotSha256,
													expectedVersionVector: splice.expectedVersionVector,
													update: splice.update,
												}),
											)
											if (Exit.isFailure(exit))
												throw domainErrorFromCause(exit.cause)
											prepared = exit.value
											if (exit.value.descriptor.activeFormat !== "loro-v1")
												throw new Error(
													"Loro content commit returned a non-Loro descriptor",
												)
											return new CommitLoroPageContentOutput({
												descriptor: exit.value.descriptor,
												storageVersion: exit.value.descriptor.storageVersion,
												resultSnapshotSha256:
													exit.value.descriptor.loro.snapshotSha256,
												baseVersionVectorSha256:
													exit.value.baseVersionVectorSha256,
												resultVersionVectorSha256:
													exit.value.resultVersionVectorSha256,
												updateSha256: exit.value.updateSha256,
											})
										},
										encodeOutput: (value) =>
											Schema.encodeSync(CommitLoroPageContentOutput)(value),
										decodeOutput: (value) =>
											Schema.decodeUnknownSync(CommitLoroPageContentOutput)(
												value,
											),
										appendCommand: () => {
											const value = prepared
											if (value === undefined)
												throw new Error(
													"Loro content commit completed without prepared evidence",
												)
											if (value.descriptor.activeFormat !== "loro-v1")
												throw new Error(
													"Loro content commit completed without a Loro descriptor",
												)
											const command: CommitLoroPageContentLedgerCommandInput = {
												...base,
												fingerprint,
												resultVersionVectorSha256:
													value.resultVersionVectorSha256,
												resultSnapshotSha256:
													value.descriptor.loro.snapshotSha256,
												createdAt: new Date().toISOString(),
											}
											ledger.appendCommitLoroPageContent(command)
										},
										appendSideEffects: () => {
											const payload = {
												nodeId: input.nodeId,
												format: "loro-v1",
												resultSnapshotSha256:
													prepared?.descriptor.activeFormat === "loro-v1"
														? prepared.descriptor.loro.snapshotSha256
														: undefined,
											}
											ledger.appendEvent(
												requestIdentity,
												"commit-loro-page-content",
												payload,
											)
											ledger.appendOutbox(
												requestIdentity,
												"commit-loro-page-content",
												payload,
											)
										},
									}),
								),
							catch: (error): DomainError =>
								error instanceof LoroContentConflict
									? error
									: error instanceof LedgerConflict
										? new LoroRequestIdentityConflict({
												nodeId: input.nodeId,
												requestId,
											})
										: error instanceof PageFormatMismatch ||
											  error instanceof PageNotFound ||
											  error instanceof ValidationError ||
											  error instanceof UnexpectedError
											? error
											: new UnexpectedError({
													message: `ledgered agent Loro edit failed: ${error instanceof Error ? error.message : String(error)}`,
												}),
						})
						if (prepared === undefined) {
							yield* loro.reloadCommittedDocument(input.nodeId)
							return {
								format: "loro-v1",
								text: yield* loro.getText(input.nodeId),
							}
						}
						loro.publishCommittedDocument(input.nodeId, prepared.candidate)
						return { format: "loro-v1", text: splice.text }
					}),
			}
		}),
	)
