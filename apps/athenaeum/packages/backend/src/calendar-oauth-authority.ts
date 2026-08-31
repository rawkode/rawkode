/**
 * Private, server-only state machine for the opaque Google Calendar OAuth handoff.
 *
 * No client or provider secret is persisted here. A future authority Durable Object stores this
 * record atomically; the Workspace DO owns binding/custody and acknowledges its immutable witness.
 */
import { canonicalJsonBytes, sha256HexSync, type Email, type EntityId } from "@athenaeum/domain"

export type CalendarOAuthAuthorityPhase =
  | "allocated" | "activated" | "launchIssued" | "launchConsumed" | "callbackClaimed"
  | "providerCompleted" | "workspaceCommitted" | "failed" | "expired"

export type CalendarOAuthAuthorityAttempt = Readonly<{
  authorityAttemptId: string
  workspaceId: EntityId
  principal: Email
  /** SHA-256 only: the stable client handle is never persisted. */
  clientHandleDigest: string
  /** Immutable allocation witness persisted by Workspace before activation. */
  allocationWitnessDigest: string
  stateNonceDigest?: string
  /** SHA-256 only: cleared as soon as a fixed launch URL is redeemed. */
  launchCapabilityDigest?: string
  launchGeneration: number
  phase: CalendarOAuthAuthorityPhase
  callbackFence: number
  callbackLeaseDigest?: string
  callbackLeaseExpiresAt?: string
  /** Rolling private state receipt; never put it in a client response. */
  privateAuthorityReceiptDigest: string
  providerReceiptDigest?: string
  completionFactDigest?: string
  /** Immutable Workspace binding/custody witness required for connected. */
  workspaceCommitWitnessDigest?: string
  createdAt: string
  updatedAt: string
  expiresAt: string
}>

export type CalendarOAuthAuthorityAllocation = Readonly<{ attempt: CalendarOAuthAuthorityAttempt; clientHandle: string }>
export type CalendarOAuthLaunch = Readonly<{ attempt: CalendarOAuthAuthorityAttempt; launchCapability: string }>
export type CalendarOAuthCallbackClaim = Readonly<{ attempt: CalendarOAuthAuthorityAttempt; callbackLease: string }>
export type CalendarOAuthCompletionView =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "connected" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "expired" }>

export class CalendarOAuthAuthorityTransitionError extends Error {
  readonly name = "CalendarOAuthAuthorityTransitionError"
  constructor(message = "Calendar connection is unavailable.") { super(message) }
}

const HANDLE_PREFIX = "oca_"
const ATTEMPT_PREFIX = "coa_"
const LAUNCH_PREFIX = "ocl_"
const LEASE_PREFIX = "oclse_"
const digestPattern = /^[a-f0-9]{64}$/

const opaque = (prefix: string): string => `${prefix}${crypto.randomUUID()}`
const opaqueDigest = (value: string): string => sha256HexSync(canonicalJsonBytes({ version: "athenaeum.calendar-oauth-secret.v1", value }))
const allocationWitnessDigest = (input: { authorityAttemptId: string; workspaceId: EntityId; principal: Email; clientHandleDigest: string; createdAt: string; expiresAt: string }): string =>
  sha256HexSync(canonicalJsonBytes({ version: "athenaeum.calendar-oauth-allocation-witness.v1", ...input }))
const receiptDigest = (input: Omit<CalendarOAuthAuthorityAttempt, "privateAuthorityReceiptDigest">): string =>
  sha256HexSync(canonicalJsonBytes({
    version: "athenaeum.calendar-oauth-authority-receipt.v2",
    authorityAttemptId: input.authorityAttemptId,
    workspaceId: input.workspaceId,
    principal: input.principal,
    clientHandleDigest: input.clientHandleDigest,
    allocationWitnessDigest: input.allocationWitnessDigest,
    stateNonceDigest: input.stateNonceDigest,
    launchCapabilityDigest: input.launchCapabilityDigest,
    launchGeneration: input.launchGeneration,
    phase: input.phase,
    callbackFence: input.callbackFence,
    providerReceiptDigest: input.providerReceiptDigest,
    completionFactDigest: input.completionFactDigest,
    workspaceCommitWitnessDigest: input.workspaceCommitWitnessDigest,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    expiresAt: input.expiresAt
  }))
const withReceipt = (input: Omit<CalendarOAuthAuthorityAttempt, "privateAuthorityReceiptDigest">): CalendarOAuthAuthorityAttempt =>
  Object.freeze({ ...input, privateAuthorityReceiptDigest: receiptDigest(input) })
const timestamp = (value: string): number => {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new CalendarOAuthAuthorityTransitionError("Calendar connection timestamp is invalid.")
  return milliseconds
}
const assertDigest = (digest: string): void => { if (!digestPattern.test(digest)) throw new CalendarOAuthAuthorityTransitionError() }
const assertLive = (attempt: CalendarOAuthAuthorityAttempt, now: string): void => {
  if (timestamp(now) >= timestamp(attempt.expiresAt)) throw new CalendarOAuthAuthorityTransitionError("Calendar connection has expired.")
}
const assertOwner = (attempt: CalendarOAuthAuthorityAttempt, workspaceId: EntityId, principal: Email): void => {
  if (attempt.workspaceId !== workspaceId || attempt.principal !== principal) throw new CalendarOAuthAuthorityTransitionError()
}
const assertTerminalWitnesses = (attempt: CalendarOAuthAuthorityAttempt): void => {
  if (!attempt.providerReceiptDigest || !attempt.completionFactDigest || !attempt.workspaceCommitWitnessDigest) throw new CalendarOAuthAuthorityTransitionError()
}

/** Allocate the authority record; its allocation witness survives rolling receipt changes. */
export const allocateCalendarOAuthAuthorityAttempt = (input: {
  workspaceId: EntityId; principal: Email; now: string; expiresAt: string; authorityAttemptId?: string; clientHandle?: string
}): CalendarOAuthAuthorityAllocation => {
  if (timestamp(input.now) >= timestamp(input.expiresAt)) throw new CalendarOAuthAuthorityTransitionError("Calendar connection expiry is invalid.")
  const clientHandle = input.clientHandle ?? opaque(HANDLE_PREFIX)
  const authorityAttemptId = input.authorityAttemptId ?? opaque(ATTEMPT_PREFIX)
  const clientHandleDigest = opaqueDigest(clientHandle)
  const provisional = {
    authorityAttemptId, workspaceId: input.workspaceId, principal: input.principal, clientHandleDigest,
    allocationWitnessDigest: allocationWitnessDigest({ authorityAttemptId, workspaceId: input.workspaceId, principal: input.principal, clientHandleDigest, createdAt: input.now, expiresAt: input.expiresAt }),
    launchGeneration: 0, phase: "allocated" as const, callbackFence: 0, createdAt: input.now, updatedAt: input.now, expiresAt: input.expiresAt
  }
  return { attempt: withReceipt(provisional), clientHandle }
}

/** Idempotent Workspace-to-authority activation using the immutable allocation witness. */
export const activateCalendarOAuthAuthorityAttempt = (input: {
  attempt: CalendarOAuthAuthorityAttempt; workspaceId: EntityId; principal: Email; allocationWitnessDigest: string; stateNonceDigest: string; now: string
}): CalendarOAuthAuthorityAttempt => {
  const { attempt } = input
  assertOwner(attempt, input.workspaceId, input.principal)
  assertLive(attempt, input.now)
  assertDigest(input.allocationWitnessDigest)
  assertDigest(input.stateNonceDigest)
  if (attempt.allocationWitnessDigest !== input.allocationWitnessDigest) throw new CalendarOAuthAuthorityTransitionError()
  if (["activated", "launchIssued", "launchConsumed", "callbackClaimed", "providerCompleted", "workspaceCommitted"].includes(attempt.phase)) {
    if (attempt.stateNonceDigest !== input.stateNonceDigest) throw new CalendarOAuthAuthorityTransitionError()
    return attempt
  }
  if (attempt.phase !== "allocated") throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, stateNonceDigest: input.stateNonceDigest, phase: "activated", updatedAt: input.now })
}

/** Minting a replacement launch capability invalidates all earlier URLs without changing the client handle. */
export const issueCalendarOAuthLaunch = (input: {
  attempt: CalendarOAuthAuthorityAttempt; workspaceId: EntityId; principal: Email; now: string; launchCapability?: string
}): CalendarOAuthLaunch => {
  const { attempt } = input
  assertOwner(attempt, input.workspaceId, input.principal)
  assertLive(attempt, input.now)
  if (attempt.phase !== "activated" && attempt.phase !== "launchIssued") throw new CalendarOAuthAuthorityTransitionError()
  const launchCapability = input.launchCapability ?? opaque(LAUNCH_PREFIX)
  return { attempt: withReceipt({ ...attempt, launchCapabilityDigest: opaqueDigest(launchCapability), launchGeneration: attempt.launchGeneration + 1, phase: "launchIssued", updatedAt: input.now }), launchCapability }
}

/** Fixed launch endpoint redemption: verify digest+generation and consume the capability before redirecting. */
export const redeemCalendarOAuthLaunch = (input: {
  attempt: CalendarOAuthAuthorityAttempt; launchCapability: string; expectedLaunchGeneration: number; now: string
}): CalendarOAuthAuthorityAttempt => {
  const { attempt } = input
  assertLive(attempt, input.now)
  if (attempt.phase !== "launchIssued" || attempt.launchCapabilityDigest === undefined || attempt.launchGeneration !== input.expectedLaunchGeneration || attempt.launchCapabilityDigest !== opaqueDigest(input.launchCapability)) throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, launchCapabilityDigest: undefined, phase: "launchConsumed", updatedAt: input.now })
}

/** Claim callback execution; an expired lease is reclaimable, but a live one is not. */
export const claimCalendarOAuthCallback = (input: {
  attempt: CalendarOAuthAuthorityAttempt; stateNonceDigest: string; now: string; leaseExpiresAt: string; callbackLease?: string
}): CalendarOAuthCallbackClaim => {
  const { attempt } = input
  assertLive(attempt, input.now)
  assertDigest(input.stateNonceDigest)
  if (timestamp(input.leaseExpiresAt) <= timestamp(input.now)) throw new CalendarOAuthAuthorityTransitionError("Calendar callback lease is invalid.")
  if (attempt.stateNonceDigest !== input.stateNonceDigest) throw new CalendarOAuthAuthorityTransitionError()
  if (attempt.phase === "providerCompleted" || attempt.phase === "workspaceCommitted") throw new CalendarOAuthAuthorityTransitionError("Calendar connection callback is already complete.")
  const leaseStillLive = attempt.phase === "callbackClaimed" && attempt.callbackLeaseExpiresAt !== undefined && timestamp(attempt.callbackLeaseExpiresAt) > timestamp(input.now)
  if (leaseStillLive) throw new CalendarOAuthAuthorityTransitionError("Calendar connection callback is in progress.")
  if (attempt.phase !== "launchConsumed" && attempt.phase !== "callbackClaimed") throw new CalendarOAuthAuthorityTransitionError()
  const callbackLease = input.callbackLease ?? opaque(LEASE_PREFIX)
  return { attempt: withReceipt({ ...attempt, phase: "callbackClaimed", callbackFence: attempt.callbackFence + 1, callbackLeaseDigest: opaqueDigest(callbackLease), callbackLeaseExpiresAt: input.leaseExpiresAt, updatedAt: input.now }), callbackLease }
}

/** Store only Gatekeeper immutable digest receipts, never provider code/state/account data. */
export const recordCalendarOAuthProviderCompletion = (input: {
  attempt: CalendarOAuthAuthorityAttempt; callbackLease: string; callbackFence: number; providerReceiptDigest: string; completionFactDigest: string; now: string
}): CalendarOAuthAuthorityAttempt => {
  const { attempt } = input
  assertDigest(input.providerReceiptDigest)
  assertDigest(input.completionFactDigest)
  if (attempt.phase === "providerCompleted" || attempt.phase === "workspaceCommitted") {
    if (attempt.providerReceiptDigest !== input.providerReceiptDigest || attempt.completionFactDigest !== input.completionFactDigest) throw new CalendarOAuthAuthorityTransitionError()
    return attempt
  }
  assertLive(attempt, input.now)
  if (attempt.phase !== "callbackClaimed" || attempt.callbackFence !== input.callbackFence || attempt.callbackLeaseDigest !== opaqueDigest(input.callbackLease)) throw new CalendarOAuthAuthorityTransitionError()
  if (attempt.callbackLeaseExpiresAt === undefined || timestamp(attempt.callbackLeaseExpiresAt) <= timestamp(input.now)) throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, phase: "providerCompleted", callbackLeaseDigest: undefined, callbackLeaseExpiresAt: undefined, providerReceiptDigest: input.providerReceiptDigest, completionFactDigest: input.completionFactDigest, updatedAt: input.now })
}

/** Workspace acknowledges only after its own atomic binding/custody commit. Terminal replay validates every immutable witness. */
export const markCalendarOAuthWorkspaceCommitted = (input: {
  attempt: CalendarOAuthAuthorityAttempt; workspaceId: EntityId; principal: Email; providerReceiptDigest: string; completionFactDigest: string; workspaceCommitWitnessDigest: string; now: string
}): CalendarOAuthAuthorityAttempt => {
  const { attempt } = input
  assertOwner(attempt, input.workspaceId, input.principal)
  assertDigest(input.providerReceiptDigest)
  assertDigest(input.completionFactDigest)
  assertDigest(input.workspaceCommitWitnessDigest)
  if (attempt.phase === "workspaceCommitted") {
    if (attempt.providerReceiptDigest !== input.providerReceiptDigest || attempt.completionFactDigest !== input.completionFactDigest || attempt.workspaceCommitWitnessDigest !== input.workspaceCommitWitnessDigest) throw new CalendarOAuthAuthorityTransitionError()
    return attempt
  }
  if (attempt.phase !== "providerCompleted" || attempt.providerReceiptDigest !== input.providerReceiptDigest || attempt.completionFactDigest !== input.completionFactDigest) throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, phase: "workspaceCommitted", workspaceCommitWitnessDigest: input.workspaceCommitWitnessDigest, updatedAt: input.now })
}

/** Controlled terminal transitions; neither can overwrite a connected authority record. */
export const failCalendarOAuthAuthorityAttempt = (attempt: CalendarOAuthAuthorityAttempt, now: string): CalendarOAuthAuthorityAttempt => {
  timestamp(now)
  if (attempt.phase === "failed") return attempt
  if (attempt.phase === "providerCompleted" || attempt.phase === "workspaceCommitted" || attempt.phase === "expired") throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, launchCapabilityDigest: undefined, callbackLeaseDigest: undefined, callbackLeaseExpiresAt: undefined, phase: "failed", updatedAt: now })
}
export const expireCalendarOAuthAuthorityAttempt = (attempt: CalendarOAuthAuthorityAttempt, now: string): CalendarOAuthAuthorityAttempt => {
  if (timestamp(now) < timestamp(attempt.expiresAt)) throw new CalendarOAuthAuthorityTransitionError("Calendar connection has not expired.")
  if (attempt.phase === "expired") return attempt
  if (attempt.phase === "providerCompleted" || attempt.phase === "workspaceCommitted" || attempt.phase === "failed") throw new CalendarOAuthAuthorityTransitionError()
  return withReceipt({ ...attempt, launchCapabilityDigest: undefined, callbackLeaseDigest: undefined, callbackLeaseExpiresAt: undefined, phase: "expired", updatedAt: now })
}

/** Owner-enforcing completion read: handle, workspace, and principal must all match before projection. */
export const resolveCalendarOAuthCompletion = (input: {
  attempt: CalendarOAuthAuthorityAttempt; workspaceId: EntityId; principal: Email; clientHandle: string; now: string
}): CalendarOAuthCompletionView => {
  assertOwner(input.attempt, input.workspaceId, input.principal)
  if (input.attempt.clientHandleDigest !== opaqueDigest(input.clientHandle)) throw new CalendarOAuthAuthorityTransitionError()
  return calendarOAuthCompletionView(input.attempt, input.now)
}

/** Terminal committed connections remain connected after attempt TTL. */
export const calendarOAuthCompletionView = (attempt: CalendarOAuthAuthorityAttempt, now: string): CalendarOAuthCompletionView => {
  timestamp(now)
  if (attempt.phase === "workspaceCommitted") { assertTerminalWitnesses(attempt); return { status: "connected" } }
  // Provider facts are durable and recoverable even if the Workspace acknowledgement response was lost.
  if (attempt.phase === "providerCompleted") return { status: "pending" }
  if (attempt.phase === "failed") return { status: "failed" }
  if (attempt.phase === "expired" || timestamp(now) >= timestamp(attempt.expiresAt)) return { status: "expired" }
  return { status: "pending" }
}
