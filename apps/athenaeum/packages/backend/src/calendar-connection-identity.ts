// Backend-private calendar provider-connection identity. This deliberately sits beside, rather
// than inside, the public GatekeeperBinding schema: old bindings remain readable and no provider
// connection identifier, provider subject, or account address becomes part of an RPC projection.

import * as Schema from "effect/Schema"
import {
  Email,
  EntityId,
  GatekeeperBinding,
  GoogleCalendarBindingConfig,
  IsoDateTimeString
} from "@athenaeum/domain"

const opaqueConnectionIdPattern = /^gpc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const opaqueAttemptIdPattern = /^coa_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sha256FingerprintPattern = /^[a-f0-9]{64}$/

/** Random, opaque backend key. It is not an email-derived identifier and is never an RPC value. */
export const ProviderConnectionId = Schema.String.pipe(
  Schema.filter((value) => opaqueConnectionIdPattern.test(value), {
    message: () => "ProviderConnectionId must be an opaque gpc_ UUID"
  }),
  Schema.brand("ProviderConnectionId")
)
export type ProviderConnectionId = typeof ProviderConnectionId.Type

/** Backend-private OAuth attempt key. It never crosses the OAuth redirect boundary. */
export const CalendarOAuthAttemptId = Schema.String.pipe(
  Schema.filter((value) => opaqueAttemptIdPattern.test(value), {
    message: () => "CalendarOAuthAttemptId must be an opaque coa_ UUID"
  }),
  Schema.brand("CalendarOAuthAttemptId")
)
export type CalendarOAuthAttemptId = typeof CalendarOAuthAttemptId.Type

/** A SHA-256 digest of the redirect nonce, never the nonce itself. */
export const CalendarOAuthStateNonceDigest = Schema.String.pipe(
  Schema.filter((value) => sha256FingerprintPattern.test(value), {
    message: () => "CalendarOAuthStateNonceDigest must be a SHA-256 hex digest"
  }),
  Schema.brand("CalendarOAuthStateNonceDigest")
)
export type CalendarOAuthStateNonceDigest = typeof CalendarOAuthStateNonceDigest.Type

export const ProviderSubjectFingerprint = Schema.String.pipe(
  Schema.filter((value) => sha256FingerprintPattern.test(value), {
    message: () => "ProviderSubjectFingerprint must be a SHA-256 hex digest"
  }),
  Schema.brand("ProviderSubjectFingerprint")
)
export type ProviderSubjectFingerprint = typeof ProviderSubjectFingerprint.Type

export const CalendarProviderConnectionStatus = Schema.Literal(
  "legacy-unverified",
  "pending",
  "active",
  "cleanupPending",
  "detached"
)
export type CalendarProviderConnectionStatus = typeof CalendarProviderConnectionStatus.Type

export const CalendarOAuthAttemptLifecycle = Schema.Literal(
  "pending",
  "exchanging",
  "provider-completed",
  "committed",
  "cleanupPending",
  "detached",
  "failed",
  "expired"
)
export type CalendarOAuthAttemptLifecycle = typeof CalendarOAuthAttemptLifecycle.Type

/**
 * Private record for a credential-bearing provider connection. `principal` is Athenaeum's
 * authenticated principal, not a provider subject; a subject fingerprint is intentionally absent
 * until a future OIDC verification flow has proved one.
 */
export class ProviderConnectionRecord extends Schema.Class<ProviderConnectionRecord>("ProviderConnectionRecord")({
  providerConnectionId: ProviderConnectionId,
  workspaceId: EntityId,
  principal: Email,
  provider: Schema.Literal("google-calendar"),
  status: CalendarProviderConnectionStatus,
  createdAt: IsoDateTimeString,
  updatedAt: IsoDateTimeString,
  providerSubjectFingerprint: Schema.optional(ProviderSubjectFingerprint)
}) {}

/** Private one-to-one binding map. It is separate from GatekeeperBinding for legacy decode safety. */
export class BindingConnectionRecord extends Schema.Class<BindingConnectionRecord>("BindingConnectionRecord")({
  bindingId: EntityId,
  workspaceId: EntityId,
  providerConnectionId: ProviderConnectionId,
  createdAt: IsoDateTimeString
}) {}

/**
 * Private callback state. The redirect's signed state contains only an independently generated
 * nonce; this row is found by its digest and carries every durable identity needed after the
 * authenticated callback reaches the workspace DO. `fence`/`revision`/`rowHash` are present now
 * so the later callback worker can use a leased compare-and-swap without changing stored shape.
 */
export class CalendarOAuthAttemptRecord extends Schema.Class<CalendarOAuthAttemptRecord>("CalendarOAuthAttemptRecord")({
  attemptId: CalendarOAuthAttemptId,
  stateNonceDigest: CalendarOAuthStateNonceDigest,
  workspaceId: EntityId,
  principal: Email,
  providerConnectionId: ProviderConnectionId,
  bindingId: EntityId,
  calendarId: Schema.String,
  mode: Schema.Literal("selected", "allVisible"),
  lifecycle: CalendarOAuthAttemptLifecycle,
  issuedAt: IsoDateTimeString,
  expiresAt: IsoDateTimeString,
  fence: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  rowHash: CalendarOAuthStateNonceDigest,
  leaseToken: Schema.optional(Schema.String),
  leaseExpiresAt: Schema.optional(IsoDateTimeString),
  failureKind: Schema.optional(Schema.Literal("oauth-exchange", "missing-refresh-token", "expired", "unknown"))
}) {}

export interface PendingCalendarOAuthAdmission {
  readonly connection: ProviderConnectionRecord
  readonly binding: GatekeeperBinding
  readonly bindingConnection: BindingConnectionRecord
  readonly attempt: CalendarOAuthAttemptRecord
}

/**
 * The only identity handed to the gatekeeper transport. Existing records use the legacy email
 * adapter; opaque identifiers are deliberately unsupported until the token-store migration lands.
 */
export type GatekeeperConnectionLocator =
  | { readonly kind: "legacy-email"; readonly email: Email }
  | { readonly kind: "provider-connection"; readonly providerConnectionId: ProviderConnectionId }

export type CalendarConnectionIdentityErrorCode =
  | "duplicate-binding-mapping"
  | "workspace-mismatch"
  | "principal-mismatch"
  | "missing-provider-connection"
  | "unsupported-provider-connection"

/** Error text deliberately contains neither email, binding id, nor opaque connection id. */
export class CalendarConnectionIdentityError extends Error {
  readonly name = "CalendarConnectionIdentityError"

  constructor(readonly code: CalendarConnectionIdentityErrorCode) {
    super("Calendar provider connection is unavailable.")
  }
}

export const makeProviderConnectionId = (): ProviderConnectionId =>
  Schema.decodeUnknownSync(ProviderConnectionId)(`gpc_${crypto.randomUUID()}`)

export const makeCalendarOAuthAttemptId = (): CalendarOAuthAttemptId =>
  Schema.decodeUnknownSync(CalendarOAuthAttemptId)(`coa_${crypto.randomUUID()}`)

/** Build the four private records that the later CalendarService admission transaction persists together. */
export const preparePendingCalendarOAuthAdmission = (input: {
  readonly workspaceId: EntityId
  readonly principal: Email
  readonly calendarId: string
  readonly mode: "selected" | "allVisible"
  readonly stateNonceDigest: CalendarOAuthStateNonceDigest
  readonly rowHash: CalendarOAuthStateNonceDigest
  readonly issuedAt: IsoDateTimeString
  readonly expiresAt: IsoDateTimeString
  readonly providerConnectionId?: ProviderConnectionId
  readonly attemptId?: CalendarOAuthAttemptId
  readonly bindingId?: EntityId
}): PendingCalendarOAuthAdmission => {
  const providerConnectionId = input.providerConnectionId ?? makeProviderConnectionId()
  const attemptId = input.attemptId ?? makeCalendarOAuthAttemptId()
  const bindingId = input.bindingId ?? (crypto.randomUUID() as EntityId)
  const connection = new ProviderConnectionRecord({
    providerConnectionId,
    workspaceId: input.workspaceId,
    principal: input.principal,
    provider: "google-calendar",
    status: "pending",
    createdAt: input.issuedAt,
    updatedAt: input.issuedAt
  })
  const binding = new GatekeeperBinding({
    id: bindingId,
    workspaceId: input.workspaceId,
    gatekeeperKind: "google-calendar",
    // Compatibility-only private owner metadata. Active routing will use bindingConnection.
    boundBy: input.principal,
    config: new GoogleCalendarBindingConfig({ kind: "google-calendar", calendarId: input.calendarId, mode: input.mode }),
    createdAt: input.issuedAt
  })
  const bindingConnection = new BindingConnectionRecord({
    bindingId,
    workspaceId: input.workspaceId,
    providerConnectionId,
    createdAt: input.issuedAt
  })
  const attempt = new CalendarOAuthAttemptRecord({
    attemptId,
    stateNonceDigest: input.stateNonceDigest,
    workspaceId: input.workspaceId,
    principal: input.principal,
    providerConnectionId,
    bindingId,
    calendarId: input.calendarId,
    mode: input.mode,
    lifecycle: "pending",
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    fence: 0,
    revision: 0,
    rowHash: input.rowHash
  })
  return { connection, binding, bindingConnection, attempt }
}

/** Reject malformed migration input before it can become a persisted duplicate mapping. */
export const assertUniqueBindingConnectionMappings = (
  mappings: ReadonlyArray<BindingConnectionRecord>
): void => {
  const bindingIds = new Set<string>()
  for (const mapping of mappings) {
    if (bindingIds.has(mapping.bindingId)) {
      throw new CalendarConnectionIdentityError("duplicate-binding-mapping")
    }
    bindingIds.add(mapping.bindingId)
  }
}

export type GatekeeperConnectionResolution =
  | { readonly locator: GatekeeperConnectionLocator; readonly identityStatus: "legacy-unverified" | "active" }
  | CalendarConnectionIdentityError

/**
 * Resolves only an already-decoded binding. Absence of a private mapping is the migration-safe
 * path: retain the binding's historical email locator without writing a synthetic opaque record.
 */
export const resolveGatekeeperConnectionLocator = (
  binding: GatekeeperBinding,
  mappings: ReadonlyArray<BindingConnectionRecord>,
  connections: ReadonlyArray<ProviderConnectionRecord>
): GatekeeperConnectionResolution => {
  try {
    assertUniqueBindingConnectionMappings(mappings)
  } catch (error) {
    return error as CalendarConnectionIdentityError
  }

  const mapping = mappings.find((candidate) => candidate.bindingId === binding.id)
  if (mapping === undefined) {
    return { locator: { kind: "legacy-email", email: binding.boundBy }, identityStatus: "legacy-unverified" }
  }
  if (mapping.workspaceId !== binding.workspaceId) return new CalendarConnectionIdentityError("workspace-mismatch")

  const connection = connections.find((candidate) => candidate.providerConnectionId === mapping.providerConnectionId)
  if (connection === undefined) return new CalendarConnectionIdentityError("missing-provider-connection")
  if (connection.workspaceId !== binding.workspaceId) return new CalendarConnectionIdentityError("workspace-mismatch")
  if (connection.principal !== binding.boundBy) return new CalendarConnectionIdentityError("principal-mismatch")
  if (connection.provider !== binding.gatekeeperKind || connection.status !== "active") {
    return new CalendarConnectionIdentityError("unsupported-provider-connection")
  }

  return {
    locator: { kind: "provider-connection", providerConnectionId: connection.providerConnectionId },
    identityStatus: "active"
  }
}
