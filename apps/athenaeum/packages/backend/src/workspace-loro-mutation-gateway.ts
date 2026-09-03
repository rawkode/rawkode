/**
 * The intentionally small Loro-only mutation gateway. It is not a generic ledger callback:
 * callers can commit content, ensure a page, migrate a legacy page, or prepare a meeting, and
 * nothing else. The Workspace DO owns the
 * surrounding SQLite transaction; the returned finalizer is invoked only after that transaction
 * has committed, keeping the Loro cache out of rollback paths.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Context from "effect/Context"
import { LoroDoc } from "loro-crdt/bundler"
import {
  CommitLoroPageContentOutput,
  CreateLoroPageOutput,
  MigrateLegacyPageOutput,
  PrepareMeetingInDailyNoteOutput,
  type EntityId,
  type LocalDate
} from "@athenaeum/domain"
import {
  LedgerService,
  LedgerConflict,
  agentLoroEditLedgerFingerprint,
  commitLoroPageContentLedgerFingerprint,
  ensureLoroPageLedgerFingerprint,
  migrateLegacyPageLedgerFingerprint,
  prepareMeetingInDailyNoteLedgerFingerprint,
  type CommitLoroPageContentLedgerCommandInput,
  type EnsureLoroPageLedgerCommandInput,
  type LedgerCustodyInput,
  type MigrateLegacyPageLedgerCommandInput,
  type PrepareMeetingInDailyNoteLedgerCommandInput
} from "./ledger-service.js"
import {
  LoroPageService,
  type PreparedLegacyMigration,
  type PreparedLoroContentCommit
} from "./loro-page-service-live.js"
import { domainErrorFromCause } from "./rpc-boundary.js"

const assertGatewayCustodyBinding = (input: {
  readonly requestIdentity: string
  readonly fingerprint: string
  readonly type: LedgerCustodyInput["type"]
  readonly workspaceId: string
  readonly nodeId: string
  readonly custody: LedgerCustodyInput
  readonly expectedFingerprint: string
  readonly commandRequestIdentity: string
}): void => {
  if (input.commandRequestIdentity !== input.requestIdentity ||
    input.custody.requestIdentity !== input.requestIdentity ||
    input.custody.fingerprint !== input.fingerprint ||
    input.custody.type !== input.type ||
    input.custody.workspaceId !== input.workspaceId ||
    input.custody.targetKind !== "node" ||
    input.custody.targetId !== input.nodeId ||
    input.expectedFingerprint !== input.fingerprint) {
    throw new LedgerConflict("gateway custody does not match the mutation")
  }
}

export class WorkspaceLoroMutationGateway {
  constructor(
    private readonly ledger: LedgerService,
    private readonly loro: Context.Tag.Service<typeof LoroPageService>,
    private readonly storage?: DurableObjectStorage,
  ) {}

  /** Top-level user-facing wrapper. Callers already inside a Workspace transaction must use the
   * corresponding `WithinTransaction` operation so the Loro cache is published only after their
   * outer transaction commits. */
  commitContent(input: Parameters<WorkspaceLoroMutationGateway["commitContentWithinTransaction"]>[0]): CommitLoroPageContentOutput {
    if (this.storage === undefined) throw new Error("Loro gateway storage is required for a top-level commit")
    const committed = this.storage.transactionSync(() => this.commitContentWithinTransaction(input))
    committed.finalize()
    return committed.output
  }

  commitContentWithinTransaction(input: {
    readonly requestIdentity: string; readonly fingerprint: string
    readonly command: Omit<CommitLoroPageContentLedgerCommandInput, "fingerprint" | "resultVersionVectorSha256" | "resultSnapshotSha256" | "createdAt">
    readonly custody: LedgerCustodyInput
    readonly expectedVersionVector: Uint8Array; readonly update: Uint8Array
    /** The only alternate identity is the closed user-directed agent-chat splice contract. */
    readonly agentChatBinding?: {
      readonly index: number; readonly deleteCount: number; readonly insertText: string
    }
    /** Test-only failpoint retained from the pre-gateway path. */
    readonly afterPrepareBeforeCommit?: () => void
  }): { readonly output: CommitLoroPageContentOutput; readonly finalize: () => void } {
    assertGatewayCustodyBinding({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint,
      type: "commitLoroPageContent", workspaceId: input.command.workspaceId,
      nodeId: input.command.nodeId, custody: input.custody,
      expectedFingerprint: input.agentChatBinding === undefined
        ? commitLoroPageContentLedgerFingerprint(input.command)
        : agentLoroEditLedgerFingerprint({
            requestId: input.command.requestId, workspaceId: input.command.workspaceId,
            principal: input.command.principal, policy: input.command.policy, nodeId: input.command.nodeId,
            index: input.agentChatBinding.index, deleteCount: input.agentChatBinding.deleteCount,
            insertText: input.agentChatBinding.insertText, commitMessage: input.command.commitMessage,
            attribution: input.command.attribution
          }),
      commandRequestIdentity: input.command.requestIdentity
    })
    let prepared: PreparedLoroContentCommit | undefined
    const output = this.ledger.executeV2({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint, type: "commitLoroPageContent",
      mutate: () => {
        const exit = Effect.runSyncExit(this.loro.commitContent({
          nodeId: input.command.nodeId as EntityId,
          expectedStorageVersion: input.command.expectedStorageVersion,
          expectedSnapshotSha256: input.command.expectedSnapshotSha256,
          expectedVersionVector: input.expectedVersionVector, update: input.update
        }))
        if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
        const value = exit.value
        prepared = value
        input.afterPrepareBeforeCommit?.()
        if (value.descriptor.activeFormat !== "loro-v1") throw new Error("Loro content commit returned a non-Loro descriptor")
        return new CommitLoroPageContentOutput({
          descriptor: value.descriptor, storageVersion: value.descriptor.storageVersion,
          resultSnapshotSha256: value.descriptor.loro.snapshotSha256,
          baseVersionVectorSha256: value.baseVersionVectorSha256,
          resultVersionVectorSha256: value.resultVersionVectorSha256, updateSha256: value.updateSha256
        })
      },
      encodeOutput: (value) => Schema.encodeSync(CommitLoroPageContentOutput)(value),
      decodeOutput: (value) => Schema.decodeUnknownSync(CommitLoroPageContentOutput)(value),
      appendCommand: () => {
        if (prepared === undefined || prepared.descriptor.activeFormat !== "loro-v1") throw new Error("Loro content commit missing prepared evidence")
        this.ledger.appendCommitLoroPageContent({ ...input.command, fingerprint: input.fingerprint,
          resultVersionVectorSha256: prepared.resultVersionVectorSha256,
          resultSnapshotSha256: prepared.descriptor.loro.snapshotSha256, createdAt: new Date().toISOString() })
      },
      appendCustody: () => this.ledger.appendCustody(input.custody),
      validateReplayCustody: () => this.ledger.validateCustody(input.custody),
      appendSideEffects: () => {
        const payload = prepared?.descriptor.activeFormat === "loro-v1"
          ? { nodeId: input.command.nodeId, format: "loro-v1", resultSnapshotSha256: prepared.descriptor.loro.snapshotSha256 }
          : { nodeId: input.command.nodeId, format: "loro-v1" }
        this.ledger.appendEvent(input.requestIdentity, "commit-loro-page-content", payload)
        this.ledger.appendOutbox(input.requestIdentity, "commit-loro-page-content", payload)
      }
    })
    return { output, finalize: () => prepared === undefined
      ? Effect.runSync(this.loro.reloadCommittedDocument(input.command.nodeId as EntityId))
      : this.loro.publishCommittedDocument(input.command.nodeId as EntityId, prepared.candidate) }
  }

  ensurePageWithinTransaction(input: {
    readonly requestIdentity: string; readonly fingerprint: string
    readonly command: Omit<EnsureLoroPageLedgerCommandInput, "fingerprint" | "outcome" | "storageVersion" | "schemaVersion" | "createdAt">
    readonly custody: LedgerCustodyInput
    /** The workforce adapter keeps its historical event vocabulary while sharing this gateway. */
    readonly eventKind?: "ensure-loro-page" | "workforce-loro-created"
    /** Optional initial body for an admitted workforce companion. Public page creation leaves it blank. */
    readonly initialText?: string
    /** Test-only failpoint retained from the pre-gateway path. */
    readonly afterPrepareBeforeCommit?: () => void
  }): { readonly output: CreateLoroPageOutput; readonly finalize: () => void } {
    assertGatewayCustodyBinding({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint,
      type: "ensureLoroPage", workspaceId: input.command.workspaceId,
      nodeId: input.command.nodeId, custody: input.custody,
      expectedFingerprint: ensureLoroPageLedgerFingerprint(input.command),
      commandRequestIdentity: input.command.requestIdentity
    })
    let candidate: { readonly candidate: LoroDoc | undefined } | undefined
    // The concrete Loro service type is Effect based; keep the mutable evidence in its narrowed
    // value form rather than exposing a callback to gateway callers.
    let descriptor: CreateLoroPageOutput["descriptor"] | undefined
    const output = this.ledger.executeV2({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint, type: "ensureLoroPage",
      mutate: () => {
        const exit = Effect.runSyncExit(input.initialText === undefined
          ? this.loro.create(input.command.nodeId as EntityId)
          : this.loro.createWithText(input.command.nodeId as EntityId, input.initialText))
        if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
        candidate = { candidate: exit.value.candidate }
        descriptor = exit.value.descriptor
        input.afterPrepareBeforeCommit?.()
        if (descriptor.activeFormat !== "loro-v1" || descriptor.loro === undefined) throw new Error("ensureLoroPage returned non-Loro descriptor")
        return new CreateLoroPageOutput({ descriptor })
      },
      encodeOutput: (value) => Schema.encodeSync(CreateLoroPageOutput)(value),
      decodeOutput: (value) => Schema.decodeUnknownSync(CreateLoroPageOutput)(value),
      appendCommand: () => {
        if (descriptor === undefined || descriptor.activeFormat !== "loro-v1" || descriptor.loro === undefined) throw new Error("ensureLoroPage missing descriptor")
        this.ledger.appendEnsureLoroPage({ ...input.command, fingerprint: input.fingerprint,
          outcome: candidate?.candidate === undefined ? "alreadyExisted" : "created",
          storageVersion: descriptor.storageVersion, schemaVersion: descriptor.loro.schemaVersion, createdAt: new Date().toISOString() })
      },
      appendCustody: () => this.ledger.appendCustody(input.custody),
      validateReplayCustody: () => this.ledger.validateCustody(input.custody),
      appendSideEffects: () => {
        const eventKind = input.eventKind ?? "ensure-loro-page"
        const payload = input.eventKind === "workforce-loro-created" && descriptor?.activeFormat === "loro-v1" && descriptor.loro !== undefined
          ? { nodeId: input.command.nodeId, format: "loro-v1", snapshotSha256: descriptor.loro.snapshotSha256 }
          : { nodeId: input.command.nodeId, format: "loro-v1" }
        this.ledger.appendEvent(input.requestIdentity, eventKind, payload)
        this.ledger.appendOutbox(input.requestIdentity, eventKind, payload)
      }
    })
    return { output, finalize: () => {
      if (candidate === undefined || candidate.candidate === undefined) {
        Effect.runSync(this.loro.reloadCommittedDocument(input.command.nodeId as EntityId))
      } else this.loro.publishCommittedDocument(input.command.nodeId as EntityId, candidate.candidate)
    } }
  }

  migrateLegacyWithinTransaction(input: {
    readonly requestIdentity: string
    readonly fingerprint: string
    readonly command: Omit<MigrateLegacyPageLedgerCommandInput, "fingerprint" | "resultSnapshotSha256" | "resultSnapshotLength" | "storageVersion" | "createdAt">
    readonly custody: LedgerCustodyInput
    readonly afterPrepareBeforeCommit?: () => void
  }): { readonly output: MigrateLegacyPageOutput; readonly finalize: () => void } {
    assertGatewayCustodyBinding({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint,
      type: "migrateLegacyPage", workspaceId: input.command.workspaceId,
      nodeId: input.command.nodeId, custody: input.custody,
      expectedFingerprint: migrateLegacyPageLedgerFingerprint(input.command),
      commandRequestIdentity: input.command.requestIdentity
    })
    let prepared: PreparedLegacyMigration | undefined
    const output = this.ledger.executeV2({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint, type: "migrateLegacyPage",
      mutate: () => {
        const exit = Effect.runSyncExit(this.loro.migrateLegacy({
          nodeId: input.command.nodeId as EntityId,
          expectedStorageVersion: input.command.sourceStorageVersion,
          expectedAutomerge: input.command.sourceAutomerge
        }))
        if (Exit.isFailure(exit)) throw domainErrorFromCause(exit.cause)
        prepared = exit.value
        input.afterPrepareBeforeCommit?.()
        return new MigrateLegacyPageOutput({ descriptor: exit.value.descriptor })
      },
      encodeOutput: (value) => Schema.encodeSync(MigrateLegacyPageOutput)(value),
      decodeOutput: (value) => Schema.decodeUnknownSync(MigrateLegacyPageOutput)(value),
      appendCommand: () => {
        if (prepared === undefined) throw new Error("migration completed without evidence")
        this.ledger.appendMigrateLegacyPage({
          ...input.command,
          fingerprint: input.fingerprint,
          resultSnapshotSha256: prepared.resultSnapshotSha256,
          resultSnapshotLength: prepared.resultSnapshotLength,
          storageVersion: prepared.descriptor.storageVersion,
          schemaVersion: prepared.descriptor.activeFormat === "loro-v1" && prepared.descriptor.loro !== undefined
            ? prepared.descriptor.loro.schemaVersion : 1,
          createdAt: new Date().toISOString()
        })
      },
      appendCustody: () => this.ledger.appendCustody(input.custody),
      validateReplayCustody: () => this.ledger.validateCustody(input.custody),
      appendSideEffects: () => {
        if (prepared === undefined) throw new Error("migration completed without evidence")
        const payload = { nodeId: input.command.nodeId, format: "loro-v1", snapshotSha256: prepared.resultSnapshotSha256 }
        this.ledger.appendEvent(input.requestIdentity, "migrate-legacy-page", payload)
        this.ledger.appendOutbox(input.requestIdentity, "migrate-legacy-page", payload)
      }
    })
    return { output, finalize: () => prepared === undefined
      ? Effect.runSync(this.loro.reloadCommittedDocument(input.command.nodeId as EntityId))
      : this.loro.publishCommittedDocument(input.command.nodeId as EntityId, prepared.candidate) }
  }

  prepareMeetingWithinTransaction(input: {
    readonly requestIdentity: string
    readonly fingerprint: string
    readonly command: Omit<PrepareMeetingInDailyNoteLedgerCommandInput, "fingerprint" | "status" | "resultSnapshotSha256" | "createdAt">
    readonly custody: LedgerCustodyInput
    readonly attendeeNames: ReadonlyArray<string>
    readonly afterPrepareBeforeCommit?: () => void
  }): { readonly output: PrepareMeetingInDailyNoteOutput; readonly finalize: () => void } {
    assertGatewayCustodyBinding({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint,
      type: "prepareMeetingInDailyNote", workspaceId: input.command.workspaceId,
      nodeId: input.command.nodeId, custody: input.custody,
      expectedFingerprint: prepareMeetingInDailyNoteLedgerFingerprint(input.command),
      commandRequestIdentity: input.command.requestIdentity
    })
    let committed: PreparedLoroContentCommit | undefined
    let result: PrepareMeetingInDailyNoteOutput | undefined
    const output = this.ledger.executeV2({
      requestIdentity: input.requestIdentity, fingerprint: input.fingerprint, type: "prepareMeetingInDailyNote",
      mutate: () => {
        const proposed = Effect.runSyncExit(this.loro.prepareMeeting({
          nodeId: input.command.nodeId as EntityId,
          localDate: input.command.localDate as LocalDate,
          occurrenceKey: input.command.occurrenceKey,
          attendeeNames: input.attendeeNames
        }))
        if (Exit.isFailure(proposed)) throw domainErrorFromCause(proposed.cause)
        if (proposed.value.status === "created") {
          if (proposed.value.update === undefined) throw new Error("meeting preparation missing its update")
          const commit = Effect.runSyncExit(this.loro.commitContent({
            nodeId: input.command.nodeId as EntityId,
            expectedStorageVersion: proposed.value.expectedStorageVersion,
            expectedSnapshotSha256: proposed.value.expectedSnapshotSha256,
            expectedVersionVector: proposed.value.expectedVersionVector,
            update: proposed.value.update
          }))
          if (Exit.isFailure(commit)) throw domainErrorFromCause(commit.cause)
          committed = commit.value
        }
        input.afterPrepareBeforeCommit?.()
        const snapshot = committed?.descriptor.activeFormat === "loro-v1"
          ? committed.descriptor.loro.snapshotSha256
          : proposed.value.expectedSnapshotSha256
        result = new PrepareMeetingInDailyNoteOutput({
          dailyNoteId: input.command.nodeId as EntityId,
          localDate: input.command.localDate as LocalDate,
          occurrenceKey: input.command.occurrenceKey,
          status: proposed.value.status,
          resultSnapshotSha256: snapshot
        })
        return result
      },
      encodeOutput: (value) => Schema.encodeSync(PrepareMeetingInDailyNoteOutput)(value),
      decodeOutput: (value) => Schema.decodeUnknownSync(PrepareMeetingInDailyNoteOutput)(value),
      appendCommand: () => {
        if (result === undefined) throw new Error("meeting preparation completed without receipt")
        this.ledger.appendPrepareMeetingInDailyNote({
          ...input.command,
          fingerprint: input.fingerprint,
          status: result.status,
          resultSnapshotSha256: result.resultSnapshotSha256,
          createdAt: new Date().toISOString()
        })
      },
      appendCustody: () => this.ledger.appendCustody(input.custody),
      validateReplayCustody: () => this.ledger.validateCustody(input.custody),
      appendSideEffects: () => {
        if (result === undefined) throw new Error("meeting preparation completed without receipt")
        const payload = {
          nodeId: input.command.nodeId,
          localDate: input.command.localDate,
          occurrenceKey: input.command.occurrenceKey,
          status: result.status,
          resultSnapshotSha256: result.resultSnapshotSha256
        }
        this.ledger.appendEvent(input.requestIdentity, "prepare-meeting-in-daily-note", payload)
        this.ledger.appendOutbox(input.requestIdentity, "prepare-meeting-in-daily-note", payload)
      }
    })
    return { output, finalize: () => committed === undefined
      ? Effect.runSync(this.loro.reloadCommittedDocument(input.command.nodeId as EntityId))
      : this.loro.publishCommittedDocument(input.command.nodeId as EntityId, committed.candidate) }
  }

  ensurePage(input: Parameters<WorkspaceLoroMutationGateway["ensurePageWithinTransaction"]>[0]): CreateLoroPageOutput {
    if (this.storage === undefined) throw new Error("Loro gateway storage is required for a top-level ensure")
    const committed = this.storage.transactionSync(() => this.ensurePageWithinTransaction(input))
    committed.finalize()
    return committed.output
  }
}
