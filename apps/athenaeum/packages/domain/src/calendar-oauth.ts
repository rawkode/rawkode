import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import { canonicalJsonBytes, sha256HexSync } from "./canonical-hash.js"
import { EntityId, IsoDateTimeString } from "./node.js"

/** Version is persisted with each admission so HMAC handle-key rotation is explicit and replayable. */
export const CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION = "hmac-sha256.workspace-principal-request-fingerprint.v1" as const
export const CalendarOAuthHandleDerivationVersion = Schema.Literal(CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION)
export type CalendarOAuthHandleDerivationVersion = typeof CalendarOAuthHandleDerivationVersion.Type

const sha256Hex = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
const opaqueUuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

/** Public, stable client handle. v1 is HMAC-derived; legacy UUID-shaped handles remain decodable during migration. */
export const CalendarOAuthClientAttemptHandle = Schema.String.pipe(
  Schema.pattern(new RegExp(`^(?:oca_${opaqueUuid}|oca_v[1-9][0-9]*_[A-Za-z0-9_-]{43})$`)),
  Schema.brand("CalendarOAuthClientAttemptHandle")
)
export type CalendarOAuthClientAttemptHandle = typeof CalendarOAuthClientAttemptHandle.Type

/** Backend-private identities. They may be ledgered only as opaque ids/digests. */
export const CalendarConnectionId = Schema.String.pipe(Schema.pattern(new RegExp(`^ccn_${opaqueUuid}$`)), Schema.brand("CalendarConnectionId"))
export type CalendarConnectionId = typeof CalendarConnectionId.Type
export const CalendarOAuthAuthorityAttemptId = Schema.String.pipe(Schema.pattern(new RegExp(`^coa_${opaqueUuid}$`)), Schema.brand("CalendarOAuthAuthorityAttemptId"))
export type CalendarOAuthAuthorityAttemptId = typeof CalendarOAuthAuthorityAttemptId.Type
/** Gatekeeper-side attempt identity. The deployed Gatekeeper reuses its opaque `coa_` attempt
 * namespace; the field remains separately branded so coordinator and provider identities cannot
 * be substituted accidentally even though their wire shape is compatible. */
export const GoogleCalendarGatekeeperAttemptId = Schema.String.pipe(Schema.pattern(new RegExp(`^coa_${opaqueUuid}$`)), Schema.brand("GoogleCalendarGatekeeperAttemptId"))
export type GoogleCalendarGatekeeperAttemptId = typeof GoogleCalendarGatekeeperAttemptId.Type
export const GoogleCalendarProviderConnectionId = Schema.String.pipe(Schema.pattern(new RegExp(`^gpc_${opaqueUuid}$`)), Schema.brand("GoogleCalendarProviderConnectionId"))
export type GoogleCalendarProviderConnectionId = typeof GoogleCalendarProviderConnectionId.Type

export const CalendarOAuthRequestFingerprint = sha256Hex.pipe(Schema.brand("CalendarOAuthRequestFingerprint"))
export type CalendarOAuthRequestFingerprint = typeof CalendarOAuthRequestFingerprint.Type
export const CalendarOAuthWitnessDigest = sha256Hex.pipe(Schema.brand("CalendarOAuthWitnessDigest"))
export type CalendarOAuthWitnessDigest = typeof CalendarOAuthWitnessDigest.Type

/** Explicit domain targets: admission is a connection target; final custody is a binding target. */
export class CalendarConnectionLedgerTarget extends Schema.Class<CalendarConnectionLedgerTarget>("CalendarConnectionLedgerTarget")({
  kind: Schema.Literal("calendarConnection"),
  id: CalendarConnectionId
}) {}
export class GatekeeperBindingLedgerTarget extends Schema.Class<GatekeeperBindingLedgerTarget>("GatekeeperBindingLedgerTarget")({
  kind: Schema.Literal("gatekeeperBinding"),
  id: EntityId
}) {}
export const CalendarOAuthLedgerTarget = Schema.Union(CalendarConnectionLedgerTarget, GatekeeperBindingLedgerTarget)
export type CalendarOAuthLedgerTarget = typeof CalendarOAuthLedgerTarget.Type

/** Readable historical receipt. It lacks exchange identities and must be restarted, never activated. */
export class CalendarOAuthAdmissionReceiptV1 extends Schema.Class<CalendarOAuthAdmissionReceiptV1>("CalendarOAuthAdmissionReceiptV1")({
  version: Schema.Literal("athenaeum.calendar-oauth-admission.v1"),
  workspaceId: EntityId,
  principal: Email,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  requestFingerprint: CalendarOAuthRequestFingerprint,
  handleDerivationVersion: CalendarOAuthHandleDerivationVersion,
  attemptHandleDigest: CalendarOAuthWitnessDigest,
  calendarConnectionId: CalendarConnectionId,
  authorityAttemptId: CalendarOAuthAuthorityAttemptId,
  admissionWitnessDigest: CalendarOAuthWitnessDigest,
  admittedAt: IsoDateTimeString
}) {}

/** Immutable current receipt. Exchange identities are allocated before launch. */
export class CalendarOAuthAdmissionReceiptV2 extends Schema.Class<CalendarOAuthAdmissionReceiptV2>("CalendarOAuthAdmissionReceiptV2")({
  version: Schema.Literal("athenaeum.calendar-oauth-admission.v2"),
  workspaceId: EntityId,
  principal: Email,
  requestId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  requestFingerprint: CalendarOAuthRequestFingerprint,
  handleDerivationVersion: CalendarOAuthHandleDerivationVersion,
  attemptHandleDigest: CalendarOAuthWitnessDigest,
  calendarConnectionId: CalendarConnectionId,
  authorityAttemptId: CalendarOAuthAuthorityAttemptId,
  /** Allocated before launch, so callback exchange cannot choose a different opaque account. */
  providerConnectionId: GoogleCalendarProviderConnectionId,
  /** The deployed Gatekeeper accepts the coordinator's `coa_` attempt namespace. */
  gatekeeperAttemptId: GoogleCalendarGatekeeperAttemptId,
  /** Workspace-owned binding identity is fixed before the provider is contacted. */
  bindingId: EntityId,
  calendarId: Schema.Literal("primary"),
  /** The opaque first-flow contract binds only Google's primary/selected calendar. */
  mode: Schema.Literal("selected"),
  admissionWitnessDigest: CalendarOAuthWitnessDigest,
  admittedAt: IsoDateTimeString
}) {}
export const CalendarOAuthAdmissionReceipt = Schema.Union(CalendarOAuthAdmissionReceiptV1, CalendarOAuthAdmissionReceiptV2)
export type CalendarOAuthAdmissionReceipt = typeof CalendarOAuthAdmissionReceipt.Type

/** Exact immutable facts required before a Workspace may commit a connected calendar binding. */
export class CalendarOAuthProviderCompletionWitness extends Schema.Class<CalendarOAuthProviderCompletionWitness>("CalendarOAuthProviderCompletionWitness")({
  version: Schema.Literal("athenaeum.calendar-oauth-provider-completion.v1"),
  providerConnectionId: GoogleCalendarProviderConnectionId,
  gatekeeperAttemptId: GoogleCalendarGatekeeperAttemptId,
  bindingId: EntityId,
  providerReceiptDigest: CalendarOAuthWitnessDigest,
  completionFactDigest: CalendarOAuthWitnessDigest,
  admissionWitnessDigest: CalendarOAuthWitnessDigest
}) {}

export class CalendarOAuthBindingCommitReceipt extends Schema.Class<CalendarOAuthBindingCommitReceipt>("CalendarOAuthBindingCommitReceipt")({
  version: Schema.Literal("athenaeum.calendar-oauth-binding-commit.v1"),
  target: GatekeeperBindingLedgerTarget,
  calendarConnectionId: CalendarConnectionId,
  completion: CalendarOAuthProviderCompletionWitness,
  workspaceCommitWitnessDigest: CalendarOAuthWitnessDigest,
  committedAt: IsoDateTimeString
}) {}

/** Public display alias: intentionally no provider email, subject, token, or receipt material. */
export const GoogleCalendarAccountAlias = Schema.String.pipe(
  Schema.pattern(/^Google account ••[A-F0-9]{6,16}$/),
  Schema.brand("GoogleCalendarAccountAlias")
)
export type GoogleCalendarAccountAlias = typeof GoogleCalendarAccountAlias.Type

/** Canonical Begin material. Handle derivation binds principal/workspace to this exact intent digest. */
export const calendarOAuthBeginRequestFingerprint = (input: {
  workspaceId: EntityId
  principal: Email
  requestId: string
  commitMessage: string
  attribution: unknown
  calendarId?: "primary"
  mode?: "selected"
}): CalendarOAuthRequestFingerprint =>
  Schema.decodeUnknownSync(CalendarOAuthRequestFingerprint)(sha256HexSync(canonicalJsonBytes({
    version: "athenaeum.calendar-oauth-begin-request.v1",
    workspaceId: input.workspaceId,
    principal: input.principal,
    requestId: input.requestId,
    commitMessage: input.commitMessage,
    attribution: input.attribution,
    calendarId: input.calendarId ?? "primary",
    mode: input.mode ?? "selected"
  })))

/** Public deterministic failure contract for callers of the disabled raw-state endpoints. */
export const LEGACY_GOOGLE_CALENDAR_OAUTH_DISABLED_CODE = "legacy-google-calendar-oauth-disabled" as const
export class LegacyGoogleCalendarOAuthDisabled extends Schema.Class<LegacyGoogleCalendarOAuthDisabled>("LegacyGoogleCalendarOAuthDisabled")({
  code: Schema.Literal(LEGACY_GOOGLE_CALENDAR_OAUTH_DISABLED_CODE),
  message: Schema.Literal("Legacy Google Calendar OAuth is disabled. Start a new calendar connection.")
}) {}
