/**
 * Workspace-side, coordinator-independent admission/finalization contract.
 *
 * The future coordinator receives only the immutable admission receipt. This module never accepts
 * OAuth code/state/token/account data and never stores a raw client handle.
 */
import {
  CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
  CalendarOAuthAdmissionReceipt,
  CalendarOAuthBindingCommitReceipt,
  CalendarOAuthWitnessDigest,
  GatekeeperBindingLedgerTarget,
  CalendarOAuthProviderCompletionWitness,
  calendarOAuthBeginRequestFingerprint,
  canonicalJsonBytes,
  sha256HexSync,
  type Email,
  type EntityId,
  type MutationAttribution
} from "@athenaeum/domain"
import * as Schema from "effect/Schema"

export class CalendarOAuthWorkspaceAdmissionError extends Error {
  readonly name = "CalendarOAuthWorkspaceAdmissionError"
  constructor(message = "Calendar connection admission is unavailable.") { super(message) }
}

export type CalendarOAuthWorkspaceAdmission = Readonly<{
  receipt: CalendarOAuthAdmissionReceipt
  /** Returned to the authenticated caller only; never persisted by this store. */
  attemptHandle: string
}>

export type CalendarOAuthWorkspaceBindingCommit = Readonly<{
  receipt: CalendarOAuthBindingCommitReceipt
  bindingId: EntityId
}>

export type CalendarOAuthWorkspaceAdmissionsSnapshot = Readonly<{
  readonly admissions: readonly CalendarOAuthAdmissionReceipt[]
  readonly commits: readonly CalendarOAuthBindingCommitReceipt[]
}>

const digest = (value: unknown): string => sha256HexSync(canonicalJsonBytes(value))
const witnessDigest = (value: string): CalendarOAuthAdmissionReceipt["admissionWitnessDigest"] =>
  Schema.decodeUnknownSync(CalendarOAuthWitnessDigest)(value)
const opaqueId = (prefix: string): string => `${prefix}${crypto.randomUUID()}`

/**
 * Versioned key material is supplied by Workspace configuration. Rotation is supported by
 * retaining an entry's `handleDerivationVersion`; this helper never silently changes it.
 */
export const deriveCalendarOAuthAttemptHandle = (input: {
  readonly handleSecret: string
  readonly workspaceId: EntityId
  readonly principal: Email
  readonly requestFingerprint: string
  readonly version?: typeof CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION
}): string => {
  if (input.handleSecret.length === 0) throw new CalendarOAuthWorkspaceAdmissionError()
  const version = input.version ?? CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION
  const material = digest({ version, secret: input.handleSecret, workspaceId: input.workspaceId, principal: input.principal, requestFingerprint: input.requestFingerprint })
  // SHA-256 hex -> URL-safe 43-char base64-like opaque suffix. The secret remains server-only.
  const suffix = btoa(String.fromCharCode(...Uint8Array.from(material.match(/../g)!.map((part) => Number.parseInt(part, 16))))).replaceAll("+", "-").replaceAll("/", "_").replace(/=$/, "")
  return `oca_v1_${suffix}`
}

const admissionWitness = (secret: string, receipt: Omit<CalendarOAuthAdmissionReceipt, "admissionWitnessDigest">): string =>
  digest({ version: "athenaeum.calendar-oauth-admission-witness.v1", secret, receipt })

/** Small persistence-neutral state owner; Workspace DO persists these rows in OCM-03. */
export class CalendarOAuthWorkspaceAdmissions {
  readonly #byRequestIdentity = new Map<string, CalendarOAuthAdmissionReceipt>()
  readonly #commits = new Map<string, CalendarOAuthWorkspaceBindingCommit>()

  constructor(snapshot?: CalendarOAuthWorkspaceAdmissionsSnapshot) {
    this.restore(snapshot)
  }

  /** Rehydrates only private receipts after the owning Workspace DO's readiness barrier. */
  restore(snapshot?: CalendarOAuthWorkspaceAdmissionsSnapshot): void {
    this.#byRequestIdentity.clear()
    this.#commits.clear()
    for (const receipt of snapshot?.admissions ?? []) this.#byRequestIdentity.set(`${receipt.workspaceId}:${receipt.principal}:${receipt.requestId}`, receipt)
    for (const receipt of snapshot?.commits ?? []) this.#commits.set(`${receipt.calendarConnectionId}:${receipt.completion.bindingId}`, Object.freeze({ receipt, bindingId: receipt.completion.bindingId }))
  }

  /** Durable Workspace snapshots contain receipts only; stable handles are re-derived on replay. */
  snapshot(): CalendarOAuthWorkspaceAdmissionsSnapshot {
    return Object.freeze({ admissions: [...this.#byRequestIdentity.values()], commits: [...this.#commits.values()].map((commit) => commit.receipt) })
  }

  /** Owner-fenced lookup without persisting the client-visible stable handle. */
  resolveHandle(input: { workspaceId: EntityId; principal: Email; attemptHandle: string }): CalendarOAuthAdmissionReceipt {
    const expectedDigest = witnessDigest(digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: input.attemptHandle }))
    const receipt = [...this.#byRequestIdentity.values()].find((candidate) =>
      candidate.workspaceId === input.workspaceId && candidate.principal === input.principal && candidate.attemptHandleDigest === expectedDigest
    )
    if (receipt === undefined) throw new CalendarOAuthWorkspaceAdmissionError()
    return receipt
  }

  begin(input: {
    workspaceId: EntityId
    principal: Email
    requestId: string
    commitMessage: string
    attribution: MutationAttribution
    handleSecret: string
    now: string
  }): CalendarOAuthWorkspaceAdmission {
    const requestFingerprint = calendarOAuthBeginRequestFingerprint(input)
    const requestIdentity = `${input.workspaceId}:${input.principal}:${input.requestId}`
    const existing = this.#byRequestIdentity.get(requestIdentity)
    if (existing !== undefined) {
      if (existing.requestFingerprint !== requestFingerprint) throw new CalendarOAuthWorkspaceAdmissionError("Calendar connection request conflicts with its original intent.")
      const attemptHandle = deriveCalendarOAuthAttemptHandle({ handleSecret: input.handleSecret, workspaceId: input.workspaceId, principal: input.principal, requestFingerprint: existing.requestFingerprint, version: existing.handleDerivationVersion })
      return Object.freeze({ receipt: existing, attemptHandle })
    }
    const attemptHandle = deriveCalendarOAuthAttemptHandle({ handleSecret: input.handleSecret, workspaceId: input.workspaceId, principal: input.principal, requestFingerprint })
    const withoutWitness = {
      version: "athenaeum.calendar-oauth-admission.v1" as const,
      workspaceId: input.workspaceId, principal: input.principal, requestId: input.requestId,
      requestFingerprint, handleDerivationVersion: CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
      attemptHandleDigest: witnessDigest(digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: attemptHandle })),
      calendarConnectionId: opaqueId("ccn_") as CalendarOAuthAdmissionReceipt["calendarConnectionId"],
      authorityAttemptId: opaqueId("coa_") as CalendarOAuthAdmissionReceipt["authorityAttemptId"],
      admittedAt: input.now as CalendarOAuthAdmissionReceipt["admittedAt"]
    }
    const receipt = new CalendarOAuthAdmissionReceipt({ ...withoutWitness, admissionWitnessDigest: witnessDigest(admissionWitness(input.handleSecret, withoutWitness)) })
    const admission = Object.freeze({ receipt, attemptHandle })
    this.#byRequestIdentity.set(requestIdentity, receipt)
    return admission
  }

  /** Internal coordinator callback: validates exact private facts before local binding custody can commit. */
  finalize(input: {
    admission: CalendarOAuthAdmissionReceipt
    completion: CalendarOAuthProviderCompletionWitness
    workspaceCommitWitnessDigest: string
    now: string
  }): CalendarOAuthWorkspaceBindingCommit {
    const { admission, completion } = input
    if (completion.admissionWitnessDigest !== admission.admissionWitnessDigest || completion.bindingId === undefined) throw new CalendarOAuthWorkspaceAdmissionError()
    const key = `${admission.calendarConnectionId}:${completion.bindingId}`
    const existing = this.#commits.get(key)
    if (existing !== undefined) {
      if (existing.receipt.completion.providerConnectionId !== completion.providerConnectionId || existing.receipt.completion.gatekeeperAttemptId !== completion.gatekeeperAttemptId || existing.receipt.completion.bindingId !== completion.bindingId || existing.receipt.completion.providerReceiptDigest !== completion.providerReceiptDigest || existing.receipt.completion.completionFactDigest !== completion.completionFactDigest || existing.receipt.workspaceCommitWitnessDigest !== input.workspaceCommitWitnessDigest) throw new CalendarOAuthWorkspaceAdmissionError()
      return existing
    }
    const receipt = new CalendarOAuthBindingCommitReceipt({ version: "athenaeum.calendar-oauth-binding-commit.v1", target: new GatekeeperBindingLedgerTarget({ kind: "gatekeeperBinding", id: completion.bindingId }), calendarConnectionId: admission.calendarConnectionId, completion, workspaceCommitWitnessDigest: witnessDigest(input.workspaceCommitWitnessDigest), committedAt: input.now as CalendarOAuthBindingCommitReceipt["committedAt"] })
    const committed = Object.freeze({ receipt, bindingId: completion.bindingId })
    this.#commits.set(key, committed)
    return committed
  }
}
