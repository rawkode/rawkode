import { LoroDoc } from "loro-crdt/bundler"
import type { EntityId, LoroMutationIntentV1, PageDocumentDescriptor } from "@athenaeum/domain"
import { CheckpointedLoroWriter, DAILY_NOTE_SEMANTIC_DEBOUNCE_MS } from "./checkpointed-loro-writer.js"
import type { AcceptedLoroBase, FrozenLoroIntent } from "./checkpointed-loro-writer.js"
import { inspectLoroPage, LORO_PAGE_SCHEMA_VERSION } from "./loro-page.js"

/**
 * In-process custody for semantic Loro writes.  This intentionally has no persistence promise:
 * a reload, crash, or tab close loses this registry.  Its job is narrower: React attachments can
 * come and go without dropping a frozen ledger request or silently adopting it across a runtime
 * connection change.
 */
export type LoroSemanticCustodyState =
  | "clean"
  | "externalCommit"
  | "externalCommitFailed"
  | "queued"
  | "inFlight"
  | "retainedRetry"
  | "retainedConflict"
  | "retainedRequestIdentity"
  | "recovering"

export const LORO_SEMANTIC_RETRY_DELAYS_MS = [100, 250, 500] as const

export interface LoroCheckpointTransportResult {
  readonly authoritative: AcceptedLoroBase
  readonly receipt: import("@athenaeum/domain").CommitLoroPageContentOutput
}

export interface LoroAuthorityReload {
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly doc: LoroDoc
  readonly descriptor: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
}

export interface LoroSemanticCustodyClock {
  readonly setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
}

const browserClock: LoroSemanticCustodyClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer)
}

export interface LoroSemanticCustodySnapshot {
  /** Attachment-scoped token. A snapshot from a detached token is never bindable. */
  readonly token: string
  readonly active: boolean
  readonly bindable: boolean
  readonly state: LoroSemanticCustodyState
  readonly revision: number
  readonly acceptedBase?: AcceptedLoroBase
  readonly workingDraft?: LoroDoc
  readonly frozenA?: FrozenLoroIntent
  readonly hasPostFreezeDraft: boolean
  readonly error?: unknown
  readonly failure?: "witnessMismatch" | "runtimeScopeMismatch"
}

export interface LoroSemanticCustodyAttachmentOptions {
  /** The actual ManagedRuntime object, used as the WeakMap key. */
  readonly runtime: object
  /** Changes whenever `switchWorkspaceConnection` replaces that runtime connection. */
  readonly runtimeConnectionIdentity: object
  readonly workspaceId: EntityId
  readonly nodeId: EntityId
  readonly initial: AcceptedLoroBase
  readonly makeIntent: () => LoroMutationIntentV1
  readonly transport: (flight: FrozenLoroIntent) => Promise<LoroCheckpointTransportResult>
  readonly loadAuthority: () => Promise<LoroAuthorityReload>
  readonly debounceMs?: number
  readonly clock?: LoroSemanticCustodyClock
  /** Test seam for validating an explicit reload without depending on WebCrypto. */
  readonly snapshotDigest?: (doc: LoroDoc) => Promise<string>
}

const descriptorWitness = (descriptor: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>): string =>
  JSON.stringify({
    nodeId: descriptor.nodeId,
    storageVersion: descriptor.storageVersion,
    schemaVersion: descriptor.loro.schemaVersion,
    snapshotSha256: descriptor.loro.snapshotSha256
  })

const sameDescriptorWitness = (
  left: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>,
  right: Extract<PageDocumentDescriptor, { activeFormat: "loro-v1" }>
): boolean => descriptorWitness(left) === descriptorWitness(right)

const isLoroContentConflict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "LoroContentConflict"

export const isTerminalLoroRequestIdentityError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const candidate = error as { _tag?: string; message?: string }
  return candidate._tag === "RequestIdentityConflict" ||
    (candidate._tag === "ValidationError" && /request identity.*(already used|different|incompatible)/i.test(candidate.message ?? ""))
}

const sha256Snapshot = async (doc: LoroDoc): Promise<string> => {
  const bytes = doc.export({ mode: "snapshot" })
  // Loro exposes ArrayBufferLike bytes; WebCrypto's stricter DOM type wants a concrete
  // ArrayBuffer-backed view, so make the integrity boundary explicit rather than casting.
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", input)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

let nextAttachmentToken = 0

/**
 * A UI-owned attachment. The registry retains no UI continuation: components poll this tiny
 * tokenized handle from their own effect lifecycle, so semantic custody cannot revive a stale
 * React view after navigation or unmount.
 */
export class LoroSemanticCustodyAttachment {
  readonly #token = `loro-attachment-${++nextAttachmentToken}`
  #active = true
  readonly #owner: LoroSemanticCustodyOwner | undefined
  readonly #failure: "witnessMismatch" | "runtimeScopeMismatch" | undefined

  constructor(
    owner: LoroSemanticCustodyOwner | undefined,
    failure?: "witnessMismatch" | "runtimeScopeMismatch"
  ) {
    this.#owner = owner
    this.#failure = failure
  }

  get token(): string { return this.#token }
  get active(): boolean { return this.#active && this.#owner?.isCurrentAttachment(this) === true }

  snapshot(): LoroSemanticCustodySnapshot {
    if (this.#owner === undefined) {
      return {
        token: this.#token,
        active: false,
        bindable: false,
        state: "retainedConflict",
        revision: 0,
        hasPostFreezeDraft: false,
        failure: this.#failure
      }
    }
    return this.#owner.snapshotFor(this, this.active)
  }

  noteHumanEdit(): boolean {
    return this.active && this.#owner?.noteHumanEdit(this) === true
  }

  manualRetry(): boolean {
    return this.active && this.#owner?.manualRetry(this) === true
  }

  discardAndReload(): Promise<boolean> {
    if (!this.active || this.#owner === undefined) return Promise.resolve(false)
    return this.#owner.discardAndReload(this)
  }

  /** Refresh the editor from a server-owned mutation that happened outside the editor queue. */
  reloadAfterExternalCommit(): Promise<boolean> {
    // The attachment may have been detached while its already-entered external RPC was still
    // settling. The owner retains a one-shot lease for that reservation so the original async
    // continuation can still reconcile authority; an unrelated stale attachment is rejected by
    // the owner's token check.
    if (this.#owner === undefined) return Promise.resolve(false)
    return this.#owner.reloadAfterExternalCommit(this)
  }

  /** Reserve a clean attachment for a server-owned mutation. While reserved, local edits are
   * rejected and the editor is presented read-only until authority is reloaded. */
  beginExternalCommit(): boolean {
    return this.active && this.#owner?.beginExternalCommit(this) === true
  }

  detach(): void {
    if (!this.#active) return
    this.#active = false
    this.#owner?.detach(this)
  }
}

class LoroSemanticCustodyOwner {
  readonly writer: CheckpointedLoroWriter
  readonly #attachments = new Set<LoroSemanticCustodyAttachment>()
  readonly #clock: LoroSemanticCustodyClock
  readonly #debounceMs: number
  readonly #snapshotDigest: (doc: LoroDoc) => Promise<string>
  readonly #makeIntent: () => LoroMutationIntentV1
  readonly #transport: (flight: FrozenLoroIntent) => Promise<LoroCheckpointTransportResult>
  readonly #loadAuthority: () => Promise<LoroAuthorityReload>
  readonly #retire: (owner: LoroSemanticCustodyOwner) => void
  #state: LoroSemanticCustodyState = "clean"
  #revision = 0
  #queuedTimer: ReturnType<typeof setTimeout> | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retryAttempt = 0
  #runningTransport = false
  #externalReloadRunning = false
  #externalCommitToken: string | undefined
  #frozenA: FrozenLoroIntent | undefined
  #hasPostFreezeDraft = false
  #lastError: unknown
  #recoverySequence = 0

  constructor(
    readonly runtime: object,
    readonly runtimeConnectionIdentity: object,
    readonly workspaceId: EntityId,
    readonly nodeId: EntityId,
    makeIntent: () => LoroMutationIntentV1,
    transport: (flight: FrozenLoroIntent) => Promise<LoroCheckpointTransportResult>,
    loadAuthority: () => Promise<LoroAuthorityReload>,
    initial: AcceptedLoroBase,
    retire: (owner: LoroSemanticCustodyOwner) => void,
    options: Pick<LoroSemanticCustodyAttachmentOptions, "clock" | "debounceMs" | "snapshotDigest">
  ) {
    this.writer = new CheckpointedLoroWriter(initial)
    this.#clock = options.clock ?? browserClock
    this.#debounceMs = options.debounceMs ?? DAILY_NOTE_SEMANTIC_DEBOUNCE_MS
    this.#snapshotDigest = options.snapshotDigest ?? sha256Snapshot
    this.#makeIntent = makeIntent
    this.#transport = transport
    this.#loadAuthority = loadAuthority
    this.#retire = retire
  }

  get state(): LoroSemanticCustodyState { return this.#state }

  canAttach(options: LoroSemanticCustodyAttachmentOptions): "ok" | "witnessMismatch" | "runtimeScopeMismatch" {
    if (this.runtimeConnectionIdentity !== options.runtimeConnectionIdentity) return "runtimeScopeMismatch"
    // Once a clean owner exists it remains the current in-process authority until idle retirement.
    // In particular, a late/stale React prop may not replace it with an older initial document.
    if (sameDescriptorWitness(this.writer.acceptedBase.descriptor, options.initial.descriptor)) return "ok"

    // An external server-owned mutation can advance durable authority after its editor has
    // detached, while the in-process owner is retaining a retryable reload failure. Permit a
    // later route attachment only when it presents a strictly newer Loro storage witness and no
    // previous attachment is still live. The new document is not adopted here; the explicit
    // external-reload path validates server authority before replacing the retained document.
    if (
      this.#attachments.size === 0 &&
      this.#state === "externalCommitFailed" &&
      options.initial.descriptor.activeFormat === "loro-v1" &&
      Number.isSafeInteger(options.initial.descriptor.storageVersion) &&
      options.initial.descriptor.storageVersion > this.writer.acceptedBase.descriptor.storageVersion
    ) return "ok"

    return "witnessMismatch"
  }

  attach(): LoroSemanticCustodyAttachment {
    const attachment = new LoroSemanticCustodyAttachment(this)
    this.#attachments.add(attachment)
    return attachment
  }

  isCurrentAttachment(attachment: LoroSemanticCustodyAttachment): boolean {
    return this.#attachments.has(attachment)
  }

  snapshotFor(attachment: LoroSemanticCustodyAttachment, active: boolean): LoroSemanticCustodySnapshot {
    const current = this.isCurrentAttachment(attachment)
    return {
      token: attachment.token,
      active: active && current,
      // Terminal custody still renders its *owned* B draft, read-only. Only a rejected
      // witness/scope attachment is non-bindable; that is the fail-closed boundary.
      bindable: active && current,
      state: this.#state,
      revision: this.#revision,
      acceptedBase: this.writer.acceptedBase,
      workingDraft: this.writer.workingDraft,
      // Deliberately expose the writer's custody rather than the owner's mirror. A future
      // accidental `rejectConflict()` would therefore make this invariant fail in tests instead
      // of being masked by the registry's retained reference.
      frozenA: this.writer.inFlight,
      hasPostFreezeDraft: this.#hasPostFreezeDraft,
      error: this.#lastError
    }
  }

  detach(attachment: LoroSemanticCustodyAttachment): void {
    this.#attachments.delete(attachment)
    this.#maybeRetire()
  }

  noteHumanEdit(attachment: LoroSemanticCustodyAttachment): boolean {
    if (!this.isCurrentAttachment(attachment)) return false
    if (this.#state === "externalCommit" || this.#state === "externalCommitFailed" || this.#state === "retainedConflict" || this.#state === "retainedRequestIdentity" || this.#state === "recovering") return false
    if (this.#state === "inFlight" || this.#runningTransport) {
      this.#hasPostFreezeDraft = true
      this.#bump()
      return true
    }
    if (this.#state === "retainedRetry") return false
    this.#scheduleDebounce()
    return true
  }

  beginExternalCommit(attachment: LoroSemanticCustodyAttachment): boolean {
    if (
      !this.isCurrentAttachment(attachment) ||
      this.#state !== "clean" ||
      this.#runningTransport ||
      this.#queuedTimer !== undefined ||
      this.#retryTimer !== undefined ||
      this.#frozenA !== undefined ||
      this.writer.inFlight !== undefined ||
      this.#hasPostFreezeDraft ||
      this.#externalReloadRunning
    ) return false
    this.#state = "externalCommit"
    this.#externalCommitToken = attachment.token
    this.#lastError = undefined
    this.#bump()
    return true
  }

  manualRetry(attachment: LoroSemanticCustodyAttachment): boolean {
    if (!this.isCurrentAttachment(attachment) || this.#state !== "retainedRetry" || this.#runningTransport) return false
    const flight = this.writer.inFlight ?? this.#frozenA
    if (flight === undefined) return false
    this.#clearRetryTimer()
    this.#retryAttempt = 0
    this.#state = "inFlight"
    this.#lastError = undefined
    this.#bump()
    this.#dispatch(flight)
    return true
  }

  async discardAndReload(attachment: LoroSemanticCustodyAttachment): Promise<boolean> {
    if (
      !this.isCurrentAttachment(attachment) ||
      (this.#state !== "retainedConflict" && this.#state !== "retainedRequestIdentity")
    ) return false
    const retainedState = this.#state
    const recovery = ++this.#recoverySequence
    this.#state = "recovering"
    this.#lastError = undefined
    this.#bump()
    try {
      const candidate = await this.#loadAuthority()
      // A detached/stale token has no authority to make a recovery decision for a later view.
      if (!this.isCurrentAttachment(attachment) || recovery !== this.#recoverySequence || this.#state !== "recovering") {
        if (recovery === this.#recoverySequence && this.#state === "recovering") {
          this.#state = retainedState
          this.#bump()
        }
        return false
      }
      const valid = await this.#validateExplicitAuthority(candidate)
      if (!valid || !this.isCurrentAttachment(attachment) || recovery !== this.#recoverySequence || this.#state !== "recovering") {
        this.#state = retainedState
        if (!valid) this.#lastError = new Error("authoritative Loro reload failed descriptor or snapshot verification")
        this.#bump()
        return false
      }
      // This is the one transition allowed to clear retained A/B custody. Authority has already
      // been fetched for this exact scope and its descriptor/storage/snapshot digest verified.
      this.writer.discardRetainedFlightAfterVerifiedReload({ doc: candidate.doc, descriptor: candidate.descriptor })
      this.#frozenA = undefined
      this.#hasPostFreezeDraft = false
      this.#state = "clean"
      this.#lastError = undefined
      this.#bump()
      this.#maybeRetire()
      return true
    } catch (error) {
      if (recovery === this.#recoverySequence && this.#state === "recovering") {
        this.#state = retainedState
        this.#lastError = error
        this.#bump()
      }
      return false
    }
  }

  async reloadAfterExternalCommit(attachment: LoroSemanticCustodyAttachment): Promise<boolean> {
    const ownsExternalLease = this.#externalCommitToken === attachment.token
    if (
      (!this.isCurrentAttachment(attachment) && !ownsExternalLease) ||
      (this.#state !== "clean" && this.#state !== "externalCommit" && this.#state !== "externalCommitFailed") ||
      this.#runningTransport ||
      this.#queuedTimer !== undefined ||
      this.#retryTimer !== undefined ||
      this.#frozenA !== undefined ||
      this.writer.inFlight !== undefined ||
      this.#hasPostFreezeDraft ||
      this.#externalReloadRunning
    ) return false
    this.#externalReloadRunning = true
    try {
      const candidate = await this.#loadAuthority()
      if (
        (!this.isCurrentAttachment(attachment) && this.#externalCommitToken !== attachment.token) ||
        (this.#state !== "clean" && this.#state !== "externalCommit" && this.#state !== "externalCommitFailed")
      ) return false
      if (!await this.#validateExplicitAuthority(candidate)) {
        this.#state = "externalCommitFailed"
        this.#lastError = new Error("authoritative Loro reload failed descriptor or snapshot verification")
        this.#bump()
        return false
      }
      this.writer.replaceAccepted({ doc: candidate.doc, descriptor: candidate.descriptor })
      this.#state = "clean"
      this.#externalCommitToken = undefined
      this.#lastError = undefined
      this.#bump()
      this.#maybeRetire()
      return true
    } catch (error) {
      // An external RPC may settle after the initiating editor detached. Preserve the
      // retryable failure on the owner so a later attachment can recover it explicitly.
      if (this.isCurrentAttachment(attachment) || ownsExternalLease) {
        this.#state = "externalCommitFailed"
        this.#lastError = error
        this.#bump()
      }
      return false
    } finally {
      this.#externalReloadRunning = false
    }
  }

  #scheduleDebounce(): void {
    this.#clearQueuedTimer()
    this.#state = "queued"
    this.#lastError = undefined
    this.#queuedTimer = this.#clock.setTimeout(() => {
      this.#queuedTimer = undefined
      this.#beginFrozenBatch()
    }, this.#debounceMs)
    this.#bump()
  }

  #beginFrozenBatch(): void {
    if (this.#state !== "queued" || this.#runningTransport) return
    try {
      const intent = this.#makeIntent()
      if (
        intent.requestId.trim().length === 0 ||
        intent.requestId !== intent.requestId.trim() ||
        intent.commitMessage.trim().length === 0 ||
        intent.commitMessage !== intent.commitMessage.trim() ||
        intent.attribution.kind !== "humanUi" ||
        intent.attribution.surface !== "rich-text-editor"
      ) {
        throw new Error("Loro semantic checkpoint requires canonical nonblank human rich-text intent")
      }
      const flight = this.writer.freeze(intent)
      this.#frozenA = flight
      this.#hasPostFreezeDraft = false
      this.#state = "inFlight"
      this.#bump()
      this.#dispatch(flight)
    } catch (error) {
      this.#state = "retainedRetry"
      this.#lastError = error
      this.#bump()
    }
  }

  #dispatch(flight: FrozenLoroIntent): void {
    if (this.#runningTransport || this.#frozenA !== flight) return
    this.#runningTransport = true
    void this.#transport(flight).then(
      (result) => this.#acceptFlight(flight, result),
      (error) => this.#rejectFlight(flight, error)
    )
  }

  #acceptFlight(flight: FrozenLoroIntent, result: LoroCheckpointTransportResult): void {
    if (this.#frozenA !== flight) return
    this.#runningTransport = false
    try {
      if (result.authoritative.descriptor.nodeId !== this.nodeId || result.authoritative.descriptor.activeFormat !== "loro-v1") {
        throw new Error("authoritative Loro convergence returned a descriptor for another page")
      }
      // `accept` verifies the receipt before it replaces the cache, then replays only B.
      this.writer.accept(result.authoritative, result.receipt)
      this.#frozenA = undefined
      this.#retryAttempt = 0
      this.#clearRetryTimer()
      const hasB = this.#hasPostFreezeDraft
      this.#hasPostFreezeDraft = false
      if (hasB) {
        // B is a fresh delta from frozen A and therefore gets its own deterministic checkpoint.
        this.#scheduleDebounce()
      } else {
        this.#state = "clean"
        this.#lastError = undefined
        this.#bump()
        this.#maybeRetire()
      }
    } catch (error) {
      // A receipt that cannot be verified never updates local authority or discards B.
      this.#state = "retainedRetry"
      this.#lastError = error
      this.#bump()
    }
  }

  #rejectFlight(flight: FrozenLoroIntent, error: unknown): void {
    if (this.#frozenA !== flight) return
    this.#runningTransport = false
    this.#lastError = error
    if (isLoroContentConflict(error)) {
      this.#clearRetryTimer()
      this.#state = "retainedConflict"
      this.#bump()
      return
    }
    if (isTerminalLoroRequestIdentityError(error)) {
      this.#clearRetryTimer()
      this.#state = "retainedRequestIdentity"
      this.#bump()
      return
    }
    if (this.#retryAttempt >= LORO_SEMANTIC_RETRY_DELAYS_MS.length) {
      this.#state = "retainedRetry"
      this.#bump()
      return
    }
    const delay = LORO_SEMANTIC_RETRY_DELAYS_MS[this.#retryAttempt]
    this.#retryAttempt += 1
    this.#state = "inFlight"
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = undefined
      if (this.#state !== "inFlight" || this.#runningTransport || this.#frozenA !== flight) return
      this.#dispatch(flight)
    }, delay)
    this.#bump()
  }

  async #validateExplicitAuthority(candidate: LoroAuthorityReload): Promise<boolean> {
    if (
      candidate.workspaceId !== this.workspaceId ||
      candidate.nodeId !== this.nodeId ||
      candidate.descriptor.nodeId !== this.nodeId ||
      candidate.descriptor.activeFormat !== "loro-v1" ||
      !Number.isSafeInteger(candidate.descriptor.storageVersion) ||
      candidate.descriptor.storageVersion < 1 ||
      !Number.isSafeInteger(candidate.descriptor.loro.schemaVersion) ||
      candidate.descriptor.loro.schemaVersion < 1 ||
      candidate.descriptor.loro.schemaVersion !== LORO_PAGE_SCHEMA_VERSION ||
      !/^[a-f0-9]{64}$/.test(candidate.descriptor.loro.snapshotSha256)
    ) return false
    try {
      const page = inspectLoroPage(candidate.doc)
      if (
        page.meta.get("schemaVersion") !== LORO_PAGE_SCHEMA_VERSION ||
        page.meta.get("schemaVersion") !== candidate.descriptor.loro.schemaVersion
      ) return false
    } catch {
      return false
    }
    const exportDigest = await this.#snapshotDigest(candidate.doc)
    return /^[a-f0-9]{64}$/.test(exportDigest) &&
      exportDigest === candidate.descriptor.loro.snapshotSha256
  }

  #clearQueuedTimer(): void {
    if (this.#queuedTimer === undefined) return
    this.#clock.clearTimeout(this.#queuedTimer)
    this.#queuedTimer = undefined
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer === undefined) return
    this.#clock.clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  #bump(): void {
    this.#revision += 1
  }

  #maybeRetire(): void {
    // Retirement is deliberately all-or-nothing. A timer, frozen A, or post-freeze B means this
    // owner still has semantic custody even if no editor is currently mounted.
    if (
      this.#attachments.size !== 0 ||
      this.#state !== "clean" ||
      this.#queuedTimer !== undefined ||
      this.#retryTimer !== undefined ||
      this.#runningTransport ||
      this.#frozenA !== undefined ||
      this.#hasPostFreezeDraft ||
      this.writer.inFlight !== undefined
    ) return
    this.#retire(this)
  }
}

/** Runtime-keyed in-process registry. Its WeakMap makes old auth/workspace runtimes unadoptable. */
export class LoroSemanticCustodyRegistry {
  readonly #ownersByRuntime = new WeakMap<object, Map<string, LoroSemanticCustodyOwner>>()

  attach(options: LoroSemanticCustodyAttachmentOptions): LoroSemanticCustodyAttachment {
    let owners = this.#ownersByRuntime.get(options.runtime)
    if (owners === undefined) {
      owners = new Map()
      this.#ownersByRuntime.set(options.runtime, owners)
    }
    const key = `${options.workspaceId}:${options.nodeId}`
    const existing = owners.get(key)
    if (existing !== undefined) {
      const eligibility = existing.canAttach(options)
      if (eligibility !== "ok") return new LoroSemanticCustodyAttachment(undefined, eligibility)
      return existing.attach()
    }
    const owner = new LoroSemanticCustodyOwner(
      options.runtime,
      options.runtimeConnectionIdentity,
      options.workspaceId,
      options.nodeId,
      options.makeIntent,
      options.transport,
      options.loadAuthority,
      options.initial,
      (retiringOwner) => {
        const current = owners?.get(key)
        if (current === retiringOwner) owners?.delete(key)
      },
      options
    )
    owners.set(key, owner)
    return owner.attach()
  }

  /** Test/diagnostic seam: no data escapes, only whether a scope still has live custody. */
  hasOwner(runtime: object, workspaceId: EntityId, nodeId: EntityId): boolean {
    return this.#ownersByRuntime.get(runtime)?.has(`${workspaceId}:${nodeId}`) ?? false
  }
}

/** The production in-process registry. It is intentionally not browser-persistent. */
export const loroSemanticCustodyRegistry = new LoroSemanticCustodyRegistry()
