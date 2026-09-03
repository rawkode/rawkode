import type { EntityId, JsonValue, TagFieldValueKind } from "@athenaeum/domain"

/** The value shown by a field control. Keeping the raw representation alongside the parsed
 * value lets the coordinator freeze exactly what the user submitted while still allowing a
 * later edit to be coalesced into a separate operation. */
export interface FieldDraft {
  readonly raw: string
  readonly checked: boolean
}

export interface FieldDefinition {
  readonly fieldId: string
  readonly valueKind: TagFieldValueKind
  readonly accepted: FieldDraft
  readonly factId?: EntityId
}

export interface FieldCommitRequestContext {
  readonly fieldId: string
  readonly valueKind: TagFieldValueKind
  readonly draft: FieldDraft
  readonly factId?: EntityId
  readonly requestId: string
}

export interface FieldCommitResult {
  readonly factId: EntityId
}

/**
 * `frozen` means an immutable ledger submission exists. It remains frozen through a transport
 * failure, so a retry can use its original request identity and complete payload rather than
 * accidentally turning a retry into a second logical mutation.
 */
export type FieldCommitPhase = "pristine" | "accepted" | "frozen" | "failed"

export interface FieldCommitSnapshot<TRequest extends object> {
  readonly fieldId: string
  readonly valueKind: TagFieldValueKind
  readonly phase: FieldCommitPhase
  readonly draft: FieldDraft
  readonly accepted: FieldDraft
  readonly factId?: EntityId
  readonly frozen?: {
    readonly draft: FieldDraft
    readonly request: TRequest
  }
  readonly queued?: FieldDraft
  readonly error?: unknown
}

export interface FieldCommitCoordinatorOptions<TRequest extends object> {
  /** Builds the complete ledger request once for a logical operation. The returned value is kept
   * by identity and passed unchanged on retries, because the ledger fingerprint covers every
   * request field, not just requestId. */
  readonly makeRequest: (context: FieldCommitRequestContext) => TRequest
  readonly submit: (request: TRequest) => Promise<FieldCommitResult>
  readonly requestIdFactory?: () => string
  readonly onAccepted?: (fieldId: string, result: FieldCommitResult) => void
}

type FrozenSubmission<TRequest extends object> = {
  readonly draft: FieldDraft
  readonly request: TRequest
}

type Entry<TRequest extends object> = {
  readonly fieldId: string
  valueKind: TagFieldValueKind
  draft: FieldDraft
  accepted: FieldDraft
  factId?: EntityId
  phase: FieldCommitPhase
  locallyAccepted: boolean
  frozen?: FrozenSubmission<TRequest>
  queued?: FieldDraft
  error?: unknown
}

type DrainWaiter = {
  readonly resolve: (success: boolean) => void
}

const sameDraft = (left: FieldDraft, right: FieldDraft): boolean =>
  left.raw === right.raw && left.checked === right.checked

const freezeDraft = (draft: FieldDraft): FieldDraft => Object.freeze({ raw: draft.raw, checked: draft.checked })

/**
 * The coordinator holds a request until the server accepts it or the user explicitly abandons
 * the field surface. `AddFactInput` is a small schema class today, but recursively freezing its
 * own enumerable values makes that ownership explicit and protects the ledger fingerprint if a
 * future request embeds a nested attribution/value object.
 *
 * This deliberately freezes only data returned by the local request factory; it never walks
 * runtime services, Effects, or arbitrary application state.
 */
const freezeRequestPayload = <TRequest extends object>(request: TRequest, visited = new WeakSet<object>()): TRequest => {
  if (visited.has(request)) return request
  visited.add(request)
  for (const value of Object.values(request)) {
    if (value !== null && typeof value === "object") {
      freezeRequestPayload(value, visited)
    }
  }
  return Object.freeze(request)
}

/**
 * Serializes field writes without making the React component responsible for ledger races.
 *
 * There is one entry per `(nodeId, tagId, fieldId)` coordinator instance. A frozen request is
 * immutable; edits made while it is in flight become one latest queued draft. A failed frozen
 * request stays available for an exact retry and cannot be leapfrogged by the queued value.
 */
export class FieldCommitCoordinator<TRequest extends object> {
  private readonly entries = new Map<string, Entry<TRequest>>()
  private readonly listeners = new Set<() => void>()
  private readonly makeRequest: FieldCommitCoordinatorOptions<TRequest>["makeRequest"]
  private readonly submit: FieldCommitCoordinatorOptions<TRequest>["submit"]
  private readonly requestIdFactory: () => string
  private readonly onAccepted: NonNullable<FieldCommitCoordinatorOptions<TRequest>["onAccepted"]>
  private closing = false
  private closed = false
  private removing = false
  private closeWaiter: DrainWaiter | undefined
  private closePromise: Promise<boolean> | undefined
  private removalWaiter: DrainWaiter | undefined

  constructor(options: FieldCommitCoordinatorOptions<TRequest>) {
    this.makeRequest = options.makeRequest
    this.submit = options.submit
    this.requestIdFactory = options.requestIdFactory ?? (() => crypto.randomUUID())
    this.onAccepted = options.onAccepted ?? (() => undefined)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  setFields(definitions: ReadonlyArray<FieldDefinition>): void {
    for (const definition of definitions) {
      const current = this.entries.get(definition.fieldId)
      if (current === undefined) {
        this.entries.set(definition.fieldId, {
          fieldId: definition.fieldId,
          valueKind: definition.valueKind,
          draft: freezeDraft(definition.accepted),
          accepted: freezeDraft(definition.accepted),
          factId: definition.factId,
          phase: "pristine",
          locallyAccepted: false
        })
        continue
      }

      // A self-triggered/refetch reload must never replace a value with a frozen, queued, failed,
      // or locally accepted operation. Only entries that have never been accepted locally may
      // converge to server truth from a read-model reload.
      if (current.locallyAccepted) continue
      if (current.frozen !== undefined || current.queued !== undefined || current.phase === "failed") continue
      if (!sameDraft(current.draft, current.accepted)) continue
      current.valueKind = definition.valueKind
      current.draft = freezeDraft(definition.accepted)
      current.accepted = freezeDraft(definition.accepted)
      current.factId = definition.factId
      current.phase = definition.factId === undefined ? "pristine" : "accepted"
      current.error = undefined
    }
    this.notify()
    this.maybeFinishDrains()
  }

  snapshot(fieldId: string): FieldCommitSnapshot<TRequest> | undefined {
    const entry = this.entries.get(fieldId)
    if (entry === undefined) return undefined
    return {
      fieldId: entry.fieldId,
      valueKind: entry.valueKind,
      phase: entry.phase,
      draft: entry.draft,
      accepted: entry.accepted,
      ...(entry.factId === undefined ? {} : { factId: entry.factId }),
      ...(entry.frozen === undefined ? {} : { frozen: entry.frozen }),
      ...(entry.queued === undefined ? {} : { queued: entry.queued }),
      ...(entry.error === undefined ? {} : { error: entry.error })
    }
  }

  snapshots(): ReadonlyArray<FieldCommitSnapshot<TRequest>> {
    return [...this.entries.keys()].flatMap((fieldId) => {
      const snapshot = this.snapshot(fieldId)
      return snapshot === undefined ? [] : [snapshot]
    })
  }

  isClosing(): boolean {
    return this.closing
  }

  isRemoving(): boolean {
    return this.removing
  }

  isFrozen(): boolean {
    return this.closing || this.removing
  }

  updateDraft(fieldId: string, draft: FieldDraft): void {
    if (this.closing || this.removing || this.closed) return
    const entry = this.entries.get(fieldId)
    if (entry === undefined) return
    entry.draft = freezeDraft(draft)
    if (entry.frozen !== undefined) {
      entry.queued = sameDraft(entry.draft, entry.frozen.draft) ? undefined : entry.draft
    } else if (sameDraft(entry.draft, entry.accepted)) {
      entry.queued = undefined
    }
    this.notify()
  }

  commit(fieldId: string): void {
    if (this.closing || this.removing || this.closed) return
    const entry = this.entries.get(fieldId)
    if (entry === undefined) return
    this.commitEntry(entry)
  }

  private commitEntry(entry: Entry<TRequest>): void {
    if (entry.frozen !== undefined) {
      entry.queued = sameDraft(entry.draft, entry.frozen.draft) ? undefined : entry.draft
      this.notify()
      return
    }
    if (sameDraft(entry.draft, entry.accepted)) return
    this.start(entry, entry.draft)
  }

  private start(entry: Entry<TRequest>, draft: FieldDraft): void {
    const requestId = this.requestIdFactory()
    let request: TRequest
    try {
      request = this.makeRequest({
        fieldId: entry.fieldId,
        valueKind: entry.valueKind,
        draft,
        ...(entry.factId === undefined ? {} : { factId: entry.factId }),
        requestId
      })
    } catch (error) {
      entry.phase = "failed"
      entry.error = error
      this.notify()
      this.maybeFinishDrains()
      return
    }

    const frozen = Object.freeze({ draft: freezeDraft(draft), request: freezeRequestPayload(request) })
    entry.frozen = frozen
    entry.phase = "frozen"
    entry.error = undefined
    entry.queued = undefined
    this.notify()

    let submitted: Promise<FieldCommitResult>
    try {
      submitted = this.submit(request)
    } catch (error) {
      this.fail(entry, frozen, error)
      return
    }
    void submitted.then(
      (result) => this.accept(entry, frozen, result),
      (error) => this.fail(entry, frozen, error)
    )
  }

  private accept(
    entry: Entry<TRequest>,
    frozen: FrozenSubmission<TRequest>,
    result: FieldCommitResult
  ): void {
    if (entry.frozen !== frozen) return
    entry.frozen = undefined
    entry.factId = result.factId
    entry.accepted = frozen.draft
    entry.phase = "accepted"
    entry.locallyAccepted = true
    entry.error = undefined
    this.onAccepted(entry.fieldId, result)
    const queued = entry.queued
    entry.queued = undefined
    if (queued !== undefined && !sameDraft(queued, entry.accepted)) {
      entry.draft = queued
      this.notify()
      this.start(entry, queued)
      return
    }
    this.notify()
    this.maybeFinishDrains()
  }

  private fail(
    entry: Entry<TRequest>,
    frozen: FrozenSubmission<TRequest>,
    error: unknown
  ): void {
    if (entry.frozen !== frozen) return
    entry.phase = "failed"
    entry.error = error
    this.notify()
    this.maybeFinishDrains()
  }

  retry(fieldId: string): void {
    if (this.removing || this.closed) return
    const entry = this.entries.get(fieldId)
    if (entry === undefined || entry.phase !== "failed") return
    if (entry.frozen === undefined) {
      if (!sameDraft(entry.draft, entry.accepted)) this.start(entry, entry.draft)
      return
    }
    const frozen = entry.frozen
    entry.phase = "frozen"
    entry.error = undefined
    this.notify()
    let submitted: Promise<FieldCommitResult>
    try {
      submitted = this.submit(frozen.request)
    } catch (error) {
      this.fail(entry, frozen, error)
      return
    }
    void submitted.then(
      (result) => this.accept(entry, frozen, result),
      (error) => this.fail(entry, frozen, error)
    )
  }

  /** Starts or queues all dirty fields for a close/removal drain. Failed frozen requests remain
   * frozen and visible; only an explicit retry may release them. */
  private startDrain(): void {
    for (const entry of this.entries.values()) {
      if (entry.frozen !== undefined) {
        entry.queued = sameDraft(entry.draft, entry.frozen.draft) ? undefined : entry.draft
      } else if (entry.phase !== "failed" && !sameDraft(entry.draft, entry.accepted)) {
        this.start(entry, entry.draft)
      }
    }
    this.notify()
    this.maybeFinishDrains()
  }

  requestClose(): Promise<boolean> {
    if (this.removing || this.closed) return Promise.resolve(false)
    // Returning the same promise makes repeated close clicks/Escape fully idempotent. The
    // component attaches its single guarded completion handler when it first requests close.
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = new Promise<boolean>((resolve) => {
      this.closeWaiter = { resolve }
    })
    this.startDrain()
    return this.closePromise
  }

  /** Waits for pending field writes before allowing a destructive tag removal. If any field has a
   * failed request, the action is rejected without invoking the caller's removal callback. */
  requestRemoval(action: () => Promise<void>): Promise<boolean> {
    if (this.closing || this.removing || this.closed) return Promise.resolve(false)
    this.removing = true
    const drain = new Promise<boolean>((resolve) => {
      this.removalWaiter = { resolve }
    })
    this.startDrain()
    return drain.then(async (ready) => {
      if (!ready) return false
      await action()
      return true
    }).finally(() => {
      this.removing = false
      this.removalWaiter = undefined
      this.notify()
    })
  }

  private maybeFinishDrains(): void {
    const hasFrozen = [...this.entries.values()].some((entry) => entry.frozen !== undefined)
    const hasFailure = [...this.entries.values()].some((entry) => entry.phase === "failed")
    const hasDirtyIdle = [...this.entries.values()].some((entry) =>
      entry.frozen === undefined && entry.phase !== "failed" && !sameDraft(entry.draft, entry.accepted)
    )

    if (this.removalWaiter !== undefined) {
      if (hasFailure) {
        this.removalWaiter.resolve(false)
        this.removalWaiter = undefined
      } else if (!hasFrozen && !hasDirtyIdle) {
        this.removalWaiter.resolve(true)
        this.removalWaiter = undefined
      }
    }

    if (this.closeWaiter === undefined) return
    if (hasFrozen || hasFailure) return
    if (hasDirtyIdle) {
      this.startDrain()
      return
    }
    this.closed = true
    this.closing = false
    const waiter = this.closeWaiter
    this.closeWaiter = undefined
    waiter.resolve(true)
    this.notify()
  }
}

/** Utility used by the UI request builder. It deliberately lives beside the coordinator so tests
 * can assert the value conversion independently from React and Effect runtime wiring. */
export const fieldDraftValue = (valueKind: TagFieldValueKind, draft: FieldDraft): JsonValue => {
  switch (valueKind) {
    case "checkbox":
      return draft.checked
    case "number": {
      const trimmed = draft.raw.trim()
      if (trimmed === "") return null
      const value = Number(trimmed)
      return Number.isNaN(value) ? null : value
    }
    default:
      return draft.raw
  }
}
