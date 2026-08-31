/**
 * Workspace-side, coordinator-independent admission/finalization contract.
 *
 * The future coordinator receives only the immutable admission receipt. This module never accepts
 * OAuth code/state/token/account data and never stores a raw client handle.
 */
import {
  CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
  CalendarOAuthAdmissionReceipt,
  CalendarOAuthAdmissionReceiptV2,
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
  receipt: CalendarOAuthAdmissionReceiptV2
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
const encoder = new TextEncoder()

/**
 * A small synchronous HMAC-SHA-256 implementation for the receipt path.  This is deliberately
 * expressed in terms of the domain's byte-exact SHA-256 primitive so the same code works in the
 * Worker and in the storage-neutral tests; it is the standard HMAC construction, not a
 * `sha256({ secret, payload })` convention.
 */
const hmacSha256Hex = (secret: string, bytes: Uint8Array): string => {
  const secretBytes = encoder.encode(secret)
  const block = new Uint8Array(64)
  if (secretBytes.length > block.length) {
    const compressed = sha256HexSync(secretBytes).match(/../g)!.map((part) => Number.parseInt(part, 16))
    block.set(compressed)
  } else block.set(secretBytes)
  const outer = new Uint8Array(64)
  const inner = new Uint8Array(64)
  for (let index = 0; index < block.length; index++) {
    outer[index] = block[index]! ^ 0x5c
    inner[index] = block[index]! ^ 0x36
  }
  const innerDigest = sha256HexSync(new Uint8Array([...inner, ...bytes])).match(/../g)!.map((part) => Number.parseInt(part, 16))
  return sha256HexSync(new Uint8Array([...outer, ...innerDigest]))
}

const base64Url = (hex: string): string =>
  btoa(String.fromCharCode(...Uint8Array.from(hex.match(/../g)!.map((part) => Number.parseInt(part, 16)))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

/** Parses the active key followed by retained keys. Empty/duplicate values are rejected. */
export const calendarOAuthKeyring = (activeSecret: string, retainedSecrets: readonly string[] = []): readonly string[] => {
  const keys = [activeSecret, ...retainedSecrets].map((secret) => secret.trim())
  if (keys.some((secret) => secret.length === 0) || new Set(keys).size !== keys.length) {
    throw new CalendarOAuthWorkspaceAdmissionError("Calendar OAuth keyring is unavailable.")
  }
  return Object.freeze(keys)
}
const witnessDigest = (value: string): CalendarOAuthAdmissionReceiptV2["admissionWitnessDigest"] =>
  Schema.decodeUnknownSync(CalendarOAuthWitnessDigest)(value)
const opaqueId = (prefix: string): string => `${prefix}${crypto.randomUUID()}`
const requireCurrentAdmission = (receipt: CalendarOAuthAdmissionReceipt): CalendarOAuthAdmissionReceiptV2 => {
  if (receipt.version !== "athenaeum.calendar-oauth-admission.v2") {
    throw new CalendarOAuthWorkspaceAdmissionError("Calendar connection attempt must be restarted after migration.")
  }
  return receipt
}

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
  const material = canonicalJsonBytes({
    version,
    domain: "athenaeum.calendar-oauth.client-attempt-handle.v1",
    workspaceId: input.workspaceId,
    principal: input.principal,
    requestFingerprint: input.requestFingerprint
  })
  // Handle bytes are an actual HMAC-SHA-256. The secret is never serialized into the material.
  const suffix = base64Url(hmacSha256Hex(input.handleSecret, material))
  return `oca_v1_${suffix}`
}

export const calendarOAuthAdmissionWitnessDigest = (
  secret: string,
  receipt: Omit<CalendarOAuthAdmissionReceipt, "admissionWitnessDigest">
): string => hmacSha256Hex(secret, canonicalJsonBytes({
  version: "athenaeum.calendar-oauth-admission-witness.v1",
  receipt
}))

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
  resolveHandle(input: { workspaceId: EntityId; principal: Email; attemptHandle: string }): CalendarOAuthAdmissionReceiptV2 {
    const expectedDigest = witnessDigest(digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: input.attemptHandle }))
    const receipt = [...this.#byRequestIdentity.values()].find((candidate) =>
      candidate.workspaceId === input.workspaceId && candidate.principal === input.principal && candidate.attemptHandleDigest === expectedDigest
    )
    if (receipt === undefined) throw new CalendarOAuthWorkspaceAdmissionError()
    return requireCurrentAdmission(receipt)
  }

  /** Private request lookup for the Workspace ledger only; never an RPC capability. */
  resolveRequest(input: { workspaceId: EntityId; principal: Email; requestId: string }): CalendarOAuthAdmissionReceiptV2 {
    const receipt = this.#byRequestIdentity.get(`${input.workspaceId}:${input.principal}:${input.requestId}`)
    if (receipt === undefined) throw new CalendarOAuthWorkspaceAdmissionError()
    return requireCurrentAdmission(receipt)
  }

  begin(input: {
    workspaceId: EntityId
    principal: Email
    requestId: string
    commitMessage: string
    attribution: MutationAttribution
    calendarId?: string
    mode?: "selected"
    handleSecret: string
    retainedHandleSecrets?: readonly string[]
    now: string
  }): CalendarOAuthWorkspaceAdmission {
    const requestFingerprint = calendarOAuthBeginRequestFingerprint(input)
    const requestIdentity = `${input.workspaceId}:${input.principal}:${input.requestId}`
    const keyring = calendarOAuthKeyring(input.handleSecret, input.retainedHandleSecrets)
    const existing = this.#byRequestIdentity.get(requestIdentity)
    if (existing !== undefined) {
      const current = requireCurrentAdmission(existing)
      if (existing.requestFingerprint !== requestFingerprint) throw new CalendarOAuthWorkspaceAdmissionError("Calendar connection request conflicts with its original intent.")
      for (const handleSecret of keyring) {
        const attemptHandle = deriveCalendarOAuthAttemptHandle({ handleSecret, workspaceId: input.workspaceId, principal: input.principal, requestFingerprint: existing.requestFingerprint, version: existing.handleDerivationVersion })
        if (witnessDigest(digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: attemptHandle })) === existing.attemptHandleDigest) {
          return Object.freeze({ receipt: current, attemptHandle })
        }
      }
      throw new CalendarOAuthWorkspaceAdmissionError("Calendar connection admission key is no longer retained.")
    }
    const attemptHandle = deriveCalendarOAuthAttemptHandle({ handleSecret: input.handleSecret, workspaceId: input.workspaceId, principal: input.principal, requestFingerprint })
    const authorityAttemptId = opaqueId("coa_") as CalendarOAuthAdmissionReceiptV2["authorityAttemptId"]
    const withoutWitness = {
      version: "athenaeum.calendar-oauth-admission.v2" as const,
      workspaceId: input.workspaceId, principal: input.principal, requestId: input.requestId,
      requestFingerprint, handleDerivationVersion: CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
      attemptHandleDigest: witnessDigest(digest({ version: "athenaeum.calendar-oauth-handle-digest.v1", handle: attemptHandle })),
      calendarConnectionId: opaqueId("ccn_") as CalendarOAuthAdmissionReceiptV2["calendarConnectionId"],
      authorityAttemptId,
      providerConnectionId: opaqueId("gpc_") as CalendarOAuthAdmissionReceiptV2["providerConnectionId"],
      // Gatekeeper's opaque attempt namespace is `coa_`; bind it to the coordinator identity.
      gatekeeperAttemptId: authorityAttemptId as never,
      bindingId: crypto.randomUUID() as CalendarOAuthAdmissionReceiptV2["bindingId"],
      calendarId: input.calendarId ?? "primary", mode: input.mode ?? "selected",
      admittedAt: input.now as CalendarOAuthAdmissionReceiptV2["admittedAt"]
    }
    const receipt = new CalendarOAuthAdmissionReceiptV2({ ...withoutWitness, admissionWitnessDigest: witnessDigest(calendarOAuthAdmissionWitnessDigest(input.handleSecret, withoutWitness)) })
    const admission = Object.freeze({ receipt, attemptHandle })
    this.#byRequestIdentity.set(requestIdentity, receipt)
    return admission
  }

  /** Internal coordinator callback: validates exact private facts before local binding custody can commit. */
  finalize(input: {
    admission: CalendarOAuthAdmissionReceiptV2
    completion: CalendarOAuthProviderCompletionWitness
    workspaceCommitWitnessDigest: string
    now: string
  }): CalendarOAuthWorkspaceBindingCommit {
    const { admission, completion } = input
    if (
      completion.admissionWitnessDigest !== admission.admissionWitnessDigest ||
      completion.providerConnectionId !== admission.providerConnectionId ||
      completion.gatekeeperAttemptId !== admission.gatekeeperAttemptId ||
      completion.bindingId !== admission.bindingId
    ) throw new CalendarOAuthWorkspaceAdmissionError()
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
