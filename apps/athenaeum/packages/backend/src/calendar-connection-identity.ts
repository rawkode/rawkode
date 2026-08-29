// Backend-private calendar provider-connection identity. This deliberately sits beside, rather
// than inside, the public GatekeeperBinding schema: old bindings remain readable and no provider
// connection identifier, provider subject, or account address becomes part of an RPC projection.

import * as Schema from "effect/Schema"
import { Email, EntityId, IsoDateTimeString, type GatekeeperBinding } from "@athenaeum/domain"

const opaqueConnectionIdPattern = /^gpc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const sha256FingerprintPattern = /^[a-f0-9]{64}$/

/** Random, opaque backend key. It is not an email-derived identifier and is never an RPC value. */
export const ProviderConnectionId = Schema.String.pipe(
  Schema.filter((value) => opaqueConnectionIdPattern.test(value), {
    message: () => "ProviderConnectionId must be an opaque gpc_ UUID"
  }),
  Schema.brand("ProviderConnectionId")
)
export type ProviderConnectionId = typeof ProviderConnectionId.Type

export const ProviderSubjectFingerprint = Schema.String.pipe(
  Schema.filter((value) => sha256FingerprintPattern.test(value), {
    message: () => "ProviderSubjectFingerprint must be a SHA-256 hex digest"
  }),
  Schema.brand("ProviderSubjectFingerprint")
)
export type ProviderSubjectFingerprint = typeof ProviderSubjectFingerprint.Type

export const CalendarProviderConnectionStatus = Schema.Literal("legacy-unverified", "active", "detached")
export type CalendarProviderConnectionStatus = typeof CalendarProviderConnectionStatus.Type

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
