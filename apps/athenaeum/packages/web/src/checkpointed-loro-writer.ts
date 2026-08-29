import { LoroDoc, VersionVector } from "loro-crdt/bundler"
import {
  LoroMutationIntentV1,
  type CommitLoroPageContentOutput,
  type PageDocumentDescriptor
} from "@athenaeum/domain"

/** The Daily Note semantic checkpoint duration. Deliberately one named, deterministic batch. */
export const DAILY_NOTE_SEMANTIC_DEBOUNCE_MS = 500

export interface AcceptedLoroBase {
  readonly doc: LoroDoc
  readonly descriptor: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
}

export interface FrozenLoroIntent {
  readonly requestId: string
  readonly intent: LoroMutationIntentV1
  readonly expectedStorageVersion: number
  readonly expectedSnapshotSha256: string
  readonly expectedVersionVector: Uint8Array
  readonly update: Uint8Array
  /** The precise A state which B is measured from; never mutated after freeze. */
  readonly frozenWorking: LoroDoc
}

/**
 * Custody for one Loro page.  The editor is always attached to `workingDraft`, never to the
 * accepted replica.  `freeze` immediately swaps it for a new fork, so user edit B cannot mutate
 * the bytes or witness of in-flight A.  Network retry calls must reuse `inFlight` verbatim.
 */
export class CheckpointedLoroWriter {
  #acceptedBase: AcceptedLoroBase
  #workingDraft: LoroDoc
  #inFlight: FrozenLoroIntent | undefined

  constructor(accepted: AcceptedLoroBase) {
    this.#acceptedBase = { doc: accepted.doc.fork(), descriptor: accepted.descriptor }
    this.#workingDraft = this.#acceptedBase.doc.fork()
  }

  get acceptedBase(): AcceptedLoroBase { return this.#acceptedBase }
  get workingDraft(): LoroDoc { return this.#workingDraft }
  get inFlight(): FrozenLoroIntent | undefined { return this.#inFlight }

  /** Freeze exactly one user batch. Initial/import/plugin normalization never call this. */
  freeze(intent: LoroMutationIntentV1): FrozenLoroIntent {
    if (this.#inFlight !== undefined) throw new Error("cannot freeze a second Loro batch while one is in flight")
    const frozenWorking = this.#workingDraft.fork()
    const baseVersion = this.#acceptedBase.doc.version()
    const update = frozenWorking.export({ mode: "update", from: baseVersion })
    if (update.byteLength === 0) throw new Error("cannot publish an empty Loro semantic batch")
    const flight: FrozenLoroIntent = {
      requestId: intent.requestId,
      intent,
      expectedStorageVersion: this.#acceptedBase.descriptor.storageVersion,
      expectedSnapshotSha256: this.#acceptedBase.descriptor.loro.snapshotSha256,
      expectedVersionVector: baseVersion.encode(),
      update,
      frozenWorking
    }
    this.#inFlight = flight
    // B gets a distinct peer/replica seeded with A, not the in-flight document.
    this.#workingDraft = frozenWorking.fork()
    return flight
  }

  /** The exact, immutable A request. This is intentionally safe for response-loss retry. */
  retry(): FrozenLoroIntent {
    if (this.#inFlight === undefined) throw new Error("there is no frozen Loro batch to retry")
    return this.#inFlight
  }

  /**
   * Replace cache only from an authoritative download. Preserve B as an update since frozen A
   * and replay it onto that authority; A bytes are never repurposed as B.
   */
  accept(authoritative: AcceptedLoroBase, receipt: CommitLoroPageContentOutput): void {
    const flight = this.#inFlight
    if (flight === undefined) throw new Error("received a Loro receipt with no in-flight batch")
    if (receipt.storageVersion !== authoritative.descriptor.storageVersion ||
      receipt.resultSnapshotSha256 !== authoritative.descriptor.loro.snapshotSha256) {
      throw new Error("malformed Loro receipt does not match authoritative convergence")
    }
    const postFreezeDelta = this.#workingDraft.export({ mode: "update", from: flight.frozenWorking.version() })
    this.#acceptedBase = { doc: authoritative.doc.fork(), descriptor: authoritative.descriptor }
    this.#workingDraft = this.#acceptedBase.doc.fork()
    if (postFreezeDelta.byteLength > 0) this.#workingDraft.import(postFreezeDelta)
    this.#inFlight = undefined
  }

  /** A base conflict is terminal for A: visible B stays in its own draft without auto-rebase. */
  rejectConflict(): void {
    if (this.#inFlight === undefined) throw new Error("received a Loro conflict with no in-flight batch")
    this.#inFlight = undefined
  }

  /** Explicit conflict recovery: discard the retained local draft only after authority arrives. */
  replaceAccepted(authoritative: AcceptedLoroBase): void {
    if (this.#inFlight !== undefined) throw new Error("cannot replace authority while a Loro batch is in flight")
    this.#acceptedBase = { doc: authoritative.doc.fork(), descriptor: authoritative.descriptor }
    this.#workingDraft = this.#acceptedBase.doc.fork()
  }

  /**
   * Explicitly abandon a retained frozen request only after the caller has fetched and verified
   * a replacement authority. Conflict and request-identity handlers must not call this: keeping
   * `inFlight` is how the exact immutable A and separate visible B remain in custody.
   */
  discardRetainedFlightAfterVerifiedReload(authoritative: AcceptedLoroBase): void {
    this.#acceptedBase = { doc: authoritative.doc.fork(), descriptor: authoritative.descriptor }
    this.#workingDraft = this.#acceptedBase.doc.fork()
    this.#inFlight = undefined
  }
}

export const versionVectorFrom = (bytes: Uint8Array): VersionVector => VersionVector.decode(bytes)
