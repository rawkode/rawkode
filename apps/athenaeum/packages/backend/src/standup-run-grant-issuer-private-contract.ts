import type { ResolvedStandupRunGrantV1 } from "./standup-publication-private-contract.js"

/**
 * Dormant, server-only preparation contract for a future workforce run-grant issuer.
 *
 * This is intentionally neither an RPC DTO nor a persistence contract. A trusted future run
 * attester owns the opaque attestation, and a separately approved bearer lifecycle owns token
 * recovery across process crashes. This package only prepares an immutable grant for that future
 * boundary.
 */
export const STANDUP_RUN_GRANT_ISSUER_VERSION = "athenaeum.standup-run-grant-issuer.v1" as const
export const STANDUP_RUN_GRANT_ATTESTATION_VERSION = "athenaeum.standup-run-attestation.v1" as const
export const STANDUP_RUN_GRANT_MAX_TTL_MS = 15 * 60 * 1000

declare const trustedStandupRunAttestation: unique symbol

/**
 * A capability minted only by a future trusted run attester. There is deliberately no production
 * constructor, decoder, Worker route, or `ctx.exports` entrypoint for this value.
 */
export type TrustedStandupRunAttestation = Readonly<{
  readonly [trustedStandupRunAttestation]: "athenaeum.trusted-standup-run-attestation"
}>

/**
 * The attester may supply only immutable run facts and snapshot labels. Issuer identity, subject,
 * replay audience, generation/revocation/policy state, grant identity, and timestamps are all
 * supplied by server-owned dependencies instead.
 */
export type AttestedStandupRunMaterialV1 = Readonly<{
  readonly version: typeof STANDUP_RUN_GRANT_ATTESTATION_VERSION
  readonly workspaceId: string
  readonly civilDate: string
  readonly runIdentityVersion: string
  readonly microEmployee: Readonly<{ readonly kind: "microEmployee"; readonly id: string; readonly version: string }>
  readonly job: Readonly<{ readonly kind: "job"; readonly id: string; readonly version: string }>
  readonly workflow: Readonly<{ readonly kind: "workflow"; readonly id: string; readonly version: string }>
  readonly schedule: Readonly<{ readonly kind: "schedule"; readonly id: string; readonly version: string }>
  readonly councilRefs: readonly Readonly<{ readonly kind: "council"; readonly id: string; readonly version: string }>[]
  readonly runId: string
  readonly occurrenceId: string
  readonly microEmployeeLabel: string
  readonly jobLabel: string
  readonly workflowLabel: string
  readonly scheduleLabel: string
}>

/** The only source of run facts; it receives an opaque capability and returns untrusted data. */
export interface StandupRunAttesterPort {
  readonly resolve: (attestation: TrustedStandupRunAttestation) => unknown
}

/** Server-owned custody fields. None are accepted from an attestation or external request. */
export type StandupRunGrantIssuerIdentityV1 = Readonly<{
  readonly issuerId: string
  readonly grantRecordVersion: string
  readonly subject: string
  readonly replayAudience: string
  readonly authorityGeneration: string
  readonly revocationId: string
  readonly revocationGeneration: string
  readonly policyVersion: string
}>

export interface StandupRunGrantIssuerClock {
  /** Must return a canonical UTC ISO instant with millisecond precision. */
  readonly now: () => unknown
}

export interface StandupRunGrantIssuerIdentityPort {
  readonly identity: () => unknown
  readonly nextGrantId: () => unknown
}

/**
 * A transient, immutable preparation result. It creates no durable row, receipt, event, outbox,
 * publication, companion page, or idempotency claim.
 */
export type PreparedStandupRunGrantDraftV1 = Readonly<{
  readonly version: typeof STANDUP_RUN_GRANT_ISSUER_VERSION
  readonly grant: ResolvedStandupRunGrantV1
  readonly grantRecordDigest: string
}>

export interface StandupRunGrantIssuerDependencies {
  readonly attester: StandupRunAttesterPort
  readonly identity: StandupRunGrantIssuerIdentityPort
  readonly clock: StandupRunGrantIssuerClock
  readonly ttlMs: number
}
