/**
 * Storage-neutral implementation of the global Calendar OAuth coordinator DO.
 *
 * OCM-03 deliberately leaves Worker export/migration wiring to the HTTP package. The map is a
 * test adapter for the same one-owner records that the Durable Object storage adapter will persist.
 * Raw OAuth code/state/tokens/account data are neither accepted nor retained here.
 */
import { DurableObject } from "cloudflare:workers"
import {
  CalendarOAuthAdmissionReceipt,
  CalendarOAuthAdmissionReceiptV2,
  CalendarOAuthProviderCompletionWitness,
  canonicalJsonBytes,
  sha256HexSync,
  type Email,
  type EntityId
} from "@athenaeum/domain"
import type { Env } from "./index.js"
import { calendarOAuthAdmissionWitnessDigest, calendarOAuthKeyring } from "./calendar-oauth-workspace-admission.js"
import {
  allocateCalendarOAuthAuthorityAttempt,
  activateCalendarOAuthAuthorityAttempt,
  calendarOAuthCompletionView,
  claimCalendarOAuthCallback,
  issueCalendarOAuthLaunch,
  markCalendarOAuthWorkspaceCommitted,
  recordCalendarOAuthProviderCompletion,
  redeemCalendarOAuthLaunch,
  type CalendarOAuthAuthorityAttempt,
  type CalendarOAuthCompletionView
} from "./calendar-oauth-authority.js"

export class CalendarOAuthCoordinatorError extends Error {
  readonly name = "CalendarOAuthCoordinatorError"
  constructor(message = "Calendar connection is unavailable.") { super(message) }
}

export type CalendarOAuthCoordinatorRecord = Readonly<{
  admission: CalendarOAuthAdmissionReceiptV2
  attempt: CalendarOAuthAuthorityAttempt
  completion?: CalendarOAuthProviderCompletionWitness
}>

const digest = (value: unknown): string => sha256HexSync(canonicalJsonBytes(value))
const handleDigest = (value: string): string => digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: value })
const nonceDigest = (value: string): string => digest({ version: "athenaeum.calendar-oauth-state-nonce.v1", nonce: value })
const launchCapabilityDigest = (value: string): string => digest({ version: "athenaeum.calendar-oauth-secret.v1", value })
const opaque = (prefix: string): string => `${prefix}${crypto.randomUUID()}`

/** Copy schema-defined fields before persistence so extra transport properties cannot become records. */
const privateAdmission = (receipt: CalendarOAuthAdmissionReceipt): CalendarOAuthAdmissionReceiptV2 => {
  if (receipt.version !== "athenaeum.calendar-oauth-admission.v2") throw new CalendarOAuthCoordinatorError("Calendar connection attempt must be restarted after migration.")
  return new CalendarOAuthAdmissionReceiptV2({
  version: receipt.version, workspaceId: receipt.workspaceId, principal: receipt.principal,
  requestId: receipt.requestId, requestFingerprint: receipt.requestFingerprint,
  handleDerivationVersion: receipt.handleDerivationVersion, attemptHandleDigest: receipt.attemptHandleDigest,
  calendarConnectionId: receipt.calendarConnectionId, authorityAttemptId: receipt.authorityAttemptId,
  providerConnectionId: receipt.providerConnectionId, gatekeeperAttemptId: receipt.gatekeeperAttemptId,
  bindingId: receipt.bindingId,
  calendarId: receipt.calendarId, mode: receipt.mode,
  admissionWitnessDigest: receipt.admissionWitnessDigest, admittedAt: receipt.admittedAt
  })
}
const privateCompletion = (completion: CalendarOAuthProviderCompletionWitness): CalendarOAuthProviderCompletionWitness => new CalendarOAuthProviderCompletionWitness({
  version: completion.version, providerConnectionId: completion.providerConnectionId,
  gatekeeperAttemptId: completion.gatekeeperAttemptId, bindingId: completion.bindingId,
  providerReceiptDigest: completion.providerReceiptDigest, completionFactDigest: completion.completionFactDigest,
  admissionWitnessDigest: completion.admissionWitnessDigest
})

export class CalendarOAuthCoordinator {
  readonly #byAttempt = new Map<string, CalendarOAuthCoordinatorRecord>()
  readonly #byHandleDigest = new Map<string, string>()
  readonly #byLaunchCapabilityDigest = new Map<string, string>()
  readonly #byStateNonceDigest = new Map<string, string>()

  constructor(
    private readonly admissionWitnessSecret: string,
    records: readonly CalendarOAuthCoordinatorRecord[] = [],
    private readonly retainedAdmissionWitnessSecrets: readonly string[] = []
  ) {
    for (const record of records) this.#put(Object.freeze({ admission: privateAdmission(record.admission), attempt: record.attempt, completion: record.completion === undefined ? undefined : privateCompletion(record.completion) }))
  }

  /** The durable adapter persists only private receipt-bearing records, never transport secrets. */
  snapshot(): readonly CalendarOAuthCoordinatorRecord[] { return [...this.#byAttempt.values()] }

  /** Idempotently allocates and activates the coordinator record from a Workspace-authentic receipt. */
  allocateActivate(input: { admission: CalendarOAuthAdmissionReceipt; now: string }): CalendarOAuthCoordinatorRecord {
    const admission = privateAdmission(input.admission)
    this.#assertAdmission(admission)
    const existing = this.#byAttempt.get(admission.authorityAttemptId)
    if (existing !== undefined) {
      if (existing.admission.admissionWitnessDigest !== admission.admissionWitnessDigest || existing.admission.requestFingerprint !== admission.requestFingerprint) throw new CalendarOAuthCoordinatorError()
      return existing
    }
    const allocated = allocateCalendarOAuthAuthorityAttempt({
      workspaceId: admission.workspaceId, principal: admission.principal, now: input.now,
      expiresAt: new Date(Date.parse(input.now) + 10 * 60_000).toISOString(), authorityAttemptId: admission.authorityAttemptId,
      clientHandleDigest: admission.attemptHandleDigest, allocationWitnessDigest: admission.admissionWitnessDigest
    })
    const attempt = activateCalendarOAuthAuthorityAttempt({ attempt: allocated.attempt, workspaceId: admission.workspaceId, principal: admission.principal, allocationWitnessDigest: admission.admissionWitnessDigest, now: input.now })
    const record = Object.freeze({ admission, attempt })
    this.#put(record)
    return record
  }

  issueLaunch(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; now: string; launchCapability?: string }): Readonly<{ launchCapability: string; launchGeneration: number }> {
    const record = this.#requireOwner(input.authorityAttemptId, input.workspaceId, input.principal)
    try {
      const launch = issueCalendarOAuthLaunch({ attempt: record.attempt, workspaceId: input.workspaceId, principal: input.principal, now: input.now, launchCapability: input.launchCapability })
      this.#put({ ...record, attempt: launch.attempt })
      return { launchCapability: launch.launchCapability, launchGeneration: launch.attempt.launchGeneration }
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  /** Called by an explicit POST boundary only. GET must not call this method. */
  redeemLaunch(input: { authorityAttemptId: string; launchCapability: string; expectedLaunchGeneration: number; now: string; stateNonce?: string }): Readonly<{ stateNonce: string; stateGeneration: number }> {
    const record = this.#require(input.authorityAttemptId)
    const stateNonce = input.stateNonce ?? opaque("ocs_")
    try {
      const attempt = redeemCalendarOAuthLaunch({ attempt: record.attempt, launchCapability: input.launchCapability, expectedLaunchGeneration: input.expectedLaunchGeneration, stateNonceDigest: nonceDigest(stateNonce), now: input.now })
      this.#put({ ...record, attempt })
      return { stateNonce, stateGeneration: attempt.stateGeneration }
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  /** Fixed launch URLs carry only the one-time capability; the private registry resolves its attempt. */
  redeemLaunchFromCapability(input: { launchCapability: string; now: string; stateNonce?: string }): Readonly<{ authorityAttemptId: string; stateNonce: string; stateGeneration: number }> {
    const authorityAttemptId = this.#byLaunchCapabilityDigest.get(launchCapabilityDigest(input.launchCapability))
    if (authorityAttemptId === undefined) throw new CalendarOAuthCoordinatorError()
    const record = this.#require(authorityAttemptId)
    const redeemed = this.redeemLaunch({ authorityAttemptId, launchCapability: input.launchCapability, expectedLaunchGeneration: record.attempt.launchGeneration, stateNonce: input.stateNonce, now: input.now })
    return { authorityAttemptId, ...redeemed }
  }

  claimCallback(input: { authorityAttemptId: string; stateNonce: string; stateGeneration: number; now: string; leaseExpiresAt: string; callbackLease?: string }): Readonly<{ callbackLease: string; callbackFence: number }> {
    const record = this.#require(input.authorityAttemptId)
    if (record.attempt.stateGeneration !== input.stateGeneration) throw new CalendarOAuthCoordinatorError()
    try {
      const claim = claimCalendarOAuthCallback({ attempt: record.attempt, stateNonceDigest: nonceDigest(input.stateNonce), now: input.now, leaseExpiresAt: input.leaseExpiresAt, callbackLease: input.callbackLease })
      this.#put({ ...record, attempt: claim.attempt })
      return { callbackLease: claim.callbackLease, callbackFence: claim.attempt.callbackFence }
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  /** Callback authority comes only from the one-time nonce; returns private, exact exchange facts. */
  claimCallbackByState(input: { stateNonce: string; now: string; leaseExpiresAt: string }):
    | Readonly<{ kind: "lease"; authorityAttemptId: string; callbackLease: string; callbackFence: number; admission: CalendarOAuthAdmissionReceiptV2 }>
    | Readonly<{ kind: "terminal"; authorityAttemptId: string; admission: CalendarOAuthAdmissionReceiptV2; completion: CalendarOAuthProviderCompletionWitness; committed: boolean }> {
    const authorityAttemptId = this.#byStateNonceDigest.get(nonceDigest(input.stateNonce))
    if (authorityAttemptId === undefined) throw new CalendarOAuthCoordinatorError()
    const record = this.#require(authorityAttemptId)
    if ((record.attempt.phase === "providerCompleted" || record.attempt.phase === "workspaceCommitted") && record.completion !== undefined) {
      return { kind: "terminal", authorityAttemptId, admission: record.admission, completion: record.completion, committed: record.attempt.phase === "workspaceCommitted" }
    }
    const claim = this.claimCallback({ authorityAttemptId, stateNonce: input.stateNonce, stateGeneration: record.attempt.stateGeneration, now: input.now, leaseExpiresAt: input.leaseExpiresAt })
    return { kind: "lease", authorityAttemptId, callbackLease: claim.callbackLease, callbackFence: claim.callbackFence, admission: record.admission }
  }

  /** Owner-fenced private context consumed by the Workspace finalizer, never exposed to clients. */
  completionContext(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email }): CalendarOAuthCoordinatorRecord {
    return this.#requireOwner(input.authorityAttemptId, input.workspaceId, input.principal)
  }

  /** Provider exchange occurs outside this contract; only its opaque immutable witness is admitted. */
  recordCompletion(input: { authorityAttemptId: string; callbackLease: string; callbackFence: number; completion: CalendarOAuthProviderCompletionWitness; now: string }): CalendarOAuthCoordinatorRecord {
    const record = this.#require(input.authorityAttemptId)
    const completion = privateCompletion(input.completion)
    if (
      completion.admissionWitnessDigest !== record.admission.admissionWitnessDigest ||
      completion.providerConnectionId !== record.admission.providerConnectionId ||
      completion.gatekeeperAttemptId !== record.admission.gatekeeperAttemptId ||
      completion.bindingId !== record.admission.bindingId
    ) throw new CalendarOAuthCoordinatorError()
    try {
      const attempt = recordCalendarOAuthProviderCompletion({ attempt: record.attempt, callbackLease: input.callbackLease, callbackFence: input.callbackFence, providerReceiptDigest: completion.providerReceiptDigest, completionFactDigest: completion.completionFactDigest, now: input.now })
      const updated = Object.freeze({ ...record, attempt, completion })
      this.#put(updated)
      return updated
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  /** Coordinator accepts Workspace's separate atomic commit acknowledgement only when facts exactly match. */
  reconcileWorkspaceCommit(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; completion: CalendarOAuthProviderCompletionWitness; workspaceCommitWitnessDigest: string; now: string }): CalendarOAuthCoordinatorRecord {
    const record = this.#requireOwner(input.authorityAttemptId, input.workspaceId, input.principal)
    if (record.completion === undefined || !sameCompletion(record.completion, input.completion)) throw new CalendarOAuthCoordinatorError()
    try {
      const attempt = markCalendarOAuthWorkspaceCommitted({ attempt: record.attempt, workspaceId: input.workspaceId, principal: input.principal, providerReceiptDigest: input.completion.providerReceiptDigest, completionFactDigest: input.completion.completionFactDigest, workspaceCommitWitnessDigest: input.workspaceCommitWitnessDigest, now: input.now })
      const updated = Object.freeze({ ...record, attempt })
      this.#put(updated)
      return updated
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  completionView(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; attemptHandle: string; now: string }): CalendarOAuthCompletionView {
    const record = this.#requireOwner(input.authorityAttemptId, input.workspaceId, input.principal)
    if (this.#byHandleDigest.get(handleDigest(input.attemptHandle)) !== input.authorityAttemptId) throw new CalendarOAuthCoordinatorError()
    try { return calendarOAuthCompletionView(record.attempt, input.now) } catch { throw new CalendarOAuthCoordinatorError() }
  }

  #assertAdmission(receipt: CalendarOAuthAdmissionReceipt): void {
    const { admissionWitnessDigest: _witness, ...material } = receipt
    let keyring: readonly string[]
    try { keyring = calendarOAuthKeyring(this.admissionWitnessSecret, this.retainedAdmissionWitnessSecrets) } catch { throw new CalendarOAuthCoordinatorError() }
    if (!keyring.some((secret) => calendarOAuthAdmissionWitnessDigest(secret, material) === receipt.admissionWitnessDigest)) {
      throw new CalendarOAuthCoordinatorError()
    }
  }
  #require(authorityAttemptId: string): CalendarOAuthCoordinatorRecord {
    const record = this.#byAttempt.get(authorityAttemptId)
    if (record === undefined) throw new CalendarOAuthCoordinatorError()
    return record
  }
  #requireOwner(authorityAttemptId: string, workspaceId: EntityId, principal: Email): CalendarOAuthCoordinatorRecord {
    const record = this.#require(authorityAttemptId)
    if (record.admission.workspaceId !== workspaceId || record.admission.principal !== principal) throw new CalendarOAuthCoordinatorError()
    return record
  }
  #put(record: CalendarOAuthCoordinatorRecord): void {
    const handleOwner = this.#byHandleDigest.get(record.admission.attemptHandleDigest)
    if (handleOwner !== undefined && handleOwner !== record.admission.authorityAttemptId) throw new CalendarOAuthCoordinatorError()
    if (record.attempt.stateNonceDigest !== undefined) {
      const nonceOwner = this.#byStateNonceDigest.get(record.attempt.stateNonceDigest)
      if (nonceOwner !== undefined && nonceOwner !== record.admission.authorityAttemptId) throw new CalendarOAuthCoordinatorError()
    }
    this.#byAttempt.set(record.admission.authorityAttemptId, record)
    this.#byHandleDigest.set(record.admission.attemptHandleDigest, record.admission.authorityAttemptId)
    for (const [digest, owner] of this.#byLaunchCapabilityDigest) if (owner === record.admission.authorityAttemptId) this.#byLaunchCapabilityDigest.delete(digest)
    if (record.attempt.launchCapabilityDigest !== undefined) this.#byLaunchCapabilityDigest.set(record.attempt.launchCapabilityDigest, record.admission.authorityAttemptId)
    for (const [digest, owner] of this.#byStateNonceDigest) if (owner === record.admission.authorityAttemptId) this.#byStateNonceDigest.delete(digest)
    if (record.attempt.stateNonceDigest !== undefined) this.#byStateNonceDigest.set(record.attempt.stateNonceDigest, record.admission.authorityAttemptId)
  }
}

const sameCompletion = (left: CalendarOAuthProviderCompletionWitness, right: CalendarOAuthProviderCompletionWitness): boolean =>
  left.providerConnectionId === right.providerConnectionId && left.gatekeeperAttemptId === right.gatekeeperAttemptId && left.bindingId === right.bindingId && left.providerReceiptDigest === right.providerReceiptDigest && left.completionFactDigest === right.completionFactDigest && left.admissionWitnessDigest === right.admissionWitnessDigest

type CoordinatorEnv = Env & Readonly<{
  CALENDAR_OAUTH_ADMISSION_WITNESS_SECRET?: string
  CALENDAR_OAUTH_ADMISSION_WITNESS_RETAINED_SECRETS?: string
}>
type CoordinatorSnapshot = Readonly<{ version: "athenaeum.calendar-oauth-coordinator.v1"; records: readonly CalendarOAuthCoordinatorRecord[] }>
const COORDINATOR_SNAPSHOT_KEY = "calendar-oauth-coordinator.private.v1"

/**
 * One global coordinator Durable Object. Its upcoming Worker binding must address exactly one
 * named instance; this class deliberately exposes only trusted internal methods, not HTTP/RPC.
 */
export class CalendarOAuthCoordinatorDurableObject extends DurableObject<CoordinatorEnv> {
  readonly #secret: string
  #coordinator!: CalendarOAuthCoordinator
  readonly #ready: Promise<void>
  #tail: Promise<void> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: CoordinatorEnv) {
    super(ctx, env)
    this.#secret = env.CALENDAR_OAUTH_ADMISSION_WITNESS_SECRET ?? ""
    this.#ready = ctx.blockConcurrencyWhile(async () => { await this.#reload() })
  }

  allocateActivate(input: { admission: CalendarOAuthAdmissionReceipt; now: string }): Promise<CalendarOAuthCoordinatorRecord> {
    return this.#mutate((coordinator) => coordinator.allocateActivate(input))
  }
  issueLaunch(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; now: string; launchCapability?: string }): Promise<Readonly<{ launchCapability: string; launchGeneration: number }>> {
    return this.#mutate((coordinator) => coordinator.issueLaunch(input))
  }
  redeemLaunch(input: { authorityAttemptId: string; launchCapability: string; expectedLaunchGeneration: number; now: string; stateNonce?: string }): Promise<Readonly<{ stateNonce: string; stateGeneration: number }>> {
    return this.#mutate((coordinator) => coordinator.redeemLaunch(input))
  }
  redeemLaunchFromCapability(input: { launchCapability: string; now: string; stateNonce?: string }): Promise<Readonly<{ authorityAttemptId: string; stateNonce: string; stateGeneration: number }>> {
    return this.#mutate((coordinator) => coordinator.redeemLaunchFromCapability(input))
  }
  claimCallback(input: { authorityAttemptId: string; stateNonce: string; stateGeneration: number; now: string; leaseExpiresAt: string; callbackLease?: string }): Promise<Readonly<{ callbackLease: string; callbackFence: number }>> {
    return this.#mutate((coordinator) => coordinator.claimCallback(input))
  }
  claimCallbackByState(input: { stateNonce: string; now: string; leaseExpiresAt: string }): Promise<
    | Readonly<{ kind: "lease"; authorityAttemptId: string; callbackLease: string; callbackFence: number; admission: CalendarOAuthAdmissionReceiptV2 }>
    | Readonly<{ kind: "terminal"; authorityAttemptId: string; admission: CalendarOAuthAdmissionReceiptV2; completion: CalendarOAuthProviderCompletionWitness; committed: boolean }>
  > {
    return this.#mutate((coordinator) => coordinator.claimCallbackByState(input))
  }
  recordCompletion(input: { authorityAttemptId: string; callbackLease: string; callbackFence: number; completion: CalendarOAuthProviderCompletionWitness; now: string }): Promise<CalendarOAuthCoordinatorRecord> {
    return this.#mutate((coordinator) => coordinator.recordCompletion(input))
  }
  reconcileWorkspaceCommit(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; completion: CalendarOAuthProviderCompletionWitness; workspaceCommitWitnessDigest: string; now: string }): Promise<CalendarOAuthCoordinatorRecord> {
    return this.#mutate((coordinator) => coordinator.reconcileWorkspaceCommit(input))
  }
  completionView(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; attemptHandle: string; now: string }): Promise<CalendarOAuthCompletionView> {
    return this.#serial(async () => {
      await this.#ready
      return this.#coordinator.completionView(input)
    })
  }
  completionContext(input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email }): Promise<CalendarOAuthCoordinatorRecord> {
    return this.#serial(async () => { await this.#ready; return this.#coordinator.completionContext(input) })
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
  #mutate<T>(operation: (coordinator: CalendarOAuthCoordinator) => T): Promise<T> {
    return this.#serial(async () => {
      await this.#ready
      try {
        return await this.ctx.storage.transaction(async (transaction) => {
          const result = operation(this.#coordinator)
          await transaction.put(COORDINATOR_SNAPSHOT_KEY, { version: "athenaeum.calendar-oauth-coordinator.v1", records: this.#coordinator.snapshot() } satisfies CoordinatorSnapshot)
          return result
        })
      } catch (error) {
        await this.#reload()
        throw error
      }
    })
  }
  async #reload(): Promise<void> {
    const snapshot = await this.ctx.storage.get<CoordinatorSnapshot>(COORDINATOR_SNAPSHOT_KEY)
    const retained = (this.env.CALENDAR_OAUTH_ADMISSION_WITNESS_RETAINED_SECRETS ?? "").split(",").filter(Boolean)
    this.#coordinator = new CalendarOAuthCoordinator(this.#secret, snapshot?.records ?? [], retained)
  }
}
