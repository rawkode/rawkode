/**
 * Storage-neutral implementation of the global Calendar OAuth coordinator DO.
 *
 * OCM-03 deliberately leaves Worker export/migration wiring to the HTTP package. The map is a
 * test adapter for the same one-owner records that the Durable Object storage adapter will persist.
 * Raw OAuth code/state/tokens/account data are neither accepted nor retained here.
 */
import {
  CalendarOAuthAdmissionReceipt,
  CalendarOAuthProviderCompletionWitness,
  canonicalJsonBytes,
  sha256HexSync,
  type Email,
  type EntityId
} from "@athenaeum/domain"
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
  admission: CalendarOAuthAdmissionReceipt
  attempt: CalendarOAuthAuthorityAttempt
  completion?: CalendarOAuthProviderCompletionWitness
}>

const digest = (value: unknown): string => sha256HexSync(canonicalJsonBytes(value))
const handleDigest = (value: string): string => digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: value })
const nonceDigest = (value: string): string => digest({ version: "athenaeum.calendar-oauth-state-nonce.v1", nonce: value })
const opaque = (prefix: string): string => `${prefix}${crypto.randomUUID()}`

/** Exact, versioned MAC-compatible verifier shared by trusted Workspace internal callers. */
export const calendarOAuthAdmissionWitnessDigest = (secret: string, receipt: CalendarOAuthAdmissionReceipt): string => {
  const { admissionWitnessDigest: _witness, ...material } = receipt
  return digest({ version: "athenaeum.calendar-oauth-admission-witness.v1", secret, receipt: material })
}

export class CalendarOAuthCoordinator {
  readonly #byAttempt = new Map<string, CalendarOAuthCoordinatorRecord>()
  readonly #byHandleDigest = new Map<string, string>()

  constructor(private readonly admissionWitnessSecret: string) {}

  /** Idempotently allocates and activates the coordinator record from a Workspace-authentic receipt. */
  allocateActivate(input: { admission: CalendarOAuthAdmissionReceipt; now: string }): CalendarOAuthCoordinatorRecord {
    this.#assertAdmission(input.admission)
    const existing = this.#byAttempt.get(input.admission.authorityAttemptId)
    if (existing !== undefined) {
      if (existing.admission.admissionWitnessDigest !== input.admission.admissionWitnessDigest || existing.admission.requestFingerprint !== input.admission.requestFingerprint) throw new CalendarOAuthCoordinatorError()
      return existing
    }
    const allocated = allocateCalendarOAuthAuthorityAttempt({
      workspaceId: input.admission.workspaceId, principal: input.admission.principal, now: input.now,
      expiresAt: new Date(Date.parse(input.now) + 10 * 60_000).toISOString(), authorityAttemptId: input.admission.authorityAttemptId,
      clientHandleDigest: input.admission.attemptHandleDigest, allocationWitnessDigest: input.admission.admissionWitnessDigest
    })
    const attempt = activateCalendarOAuthAuthorityAttempt({ attempt: allocated.attempt, workspaceId: input.admission.workspaceId, principal: input.admission.principal, allocationWitnessDigest: input.admission.admissionWitnessDigest, now: input.now })
    const record = Object.freeze({ admission: input.admission, attempt })
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

  claimCallback(input: { authorityAttemptId: string; stateNonce: string; stateGeneration: number; now: string; leaseExpiresAt: string; callbackLease?: string }): Readonly<{ callbackLease: string; callbackFence: number }> {
    const record = this.#require(input.authorityAttemptId)
    if (record.attempt.stateGeneration !== input.stateGeneration) throw new CalendarOAuthCoordinatorError()
    try {
      const claim = claimCalendarOAuthCallback({ attempt: record.attempt, stateNonceDigest: nonceDigest(input.stateNonce), now: input.now, leaseExpiresAt: input.leaseExpiresAt, callbackLease: input.callbackLease })
      this.#put({ ...record, attempt: claim.attempt })
      return { callbackLease: claim.callbackLease, callbackFence: claim.attempt.callbackFence }
    } catch { throw new CalendarOAuthCoordinatorError() }
  }

  /** Provider exchange occurs outside this contract; only its opaque immutable witness is admitted. */
  recordCompletion(input: { authorityAttemptId: string; callbackLease: string; callbackFence: number; completion: CalendarOAuthProviderCompletionWitness; now: string }): CalendarOAuthCoordinatorRecord {
    const record = this.#require(input.authorityAttemptId)
    const completion = input.completion
    if (completion.admissionWitnessDigest !== record.admission.admissionWitnessDigest || completion.gatekeeperAttemptId.length === 0) throw new CalendarOAuthCoordinatorError()
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
    if (this.admissionWitnessSecret.length === 0 || calendarOAuthAdmissionWitnessDigest(this.admissionWitnessSecret, receipt) !== receipt.admissionWitnessDigest) throw new CalendarOAuthCoordinatorError()
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
    this.#byAttempt.set(record.admission.authorityAttemptId, record)
    this.#byHandleDigest.set(record.admission.attemptHandleDigest, record.admission.authorityAttemptId)
  }
}

const sameCompletion = (left: CalendarOAuthProviderCompletionWitness, right: CalendarOAuthProviderCompletionWitness): boolean =>
  left.providerConnectionId === right.providerConnectionId && left.gatekeeperAttemptId === right.gatekeeperAttemptId && left.bindingId === right.bindingId && left.providerReceiptDigest === right.providerReceiptDigest && left.completionFactDigest === right.completionFactDigest && left.admissionWitnessDigest === right.admissionWitnessDigest
