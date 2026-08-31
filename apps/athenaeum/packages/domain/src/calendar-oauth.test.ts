import { describe, expect, it } from "vitest"
import * as Schema from "effect/Schema"
import { Email } from "./auth.js"
import {
  CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
  CalendarConnectionId,
  CalendarConnectionLedgerTarget,
  CalendarOAuthAuthorityAttemptId,
  CalendarOAuthAdmissionReceipt,
  CalendarOAuthClientAttemptHandle,
  CalendarOAuthProviderCompletionWitness,
  CalendarOAuthRequestFingerprint,
  CalendarOAuthWitnessDigest,
  GatekeeperBindingLedgerTarget,
  GoogleCalendarAccountAlias,
  LegacyGoogleCalendarOAuthDisabled,
  calendarOAuthBeginRequestFingerprint
} from "./calendar-oauth.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const bindingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const principal = Schema.decodeUnknownSync(Email)("owner@example.test")
const digest = "a".repeat(64)
const iso = "2026-08-31T10:00:00.000Z"
const requestFingerprint = Schema.decodeUnknownSync(CalendarOAuthRequestFingerprint)(digest)
const witnessDigest = Schema.decodeUnknownSync(CalendarOAuthWitnessDigest)(digest)
const calendarConnectionId = Schema.decodeUnknownSync(CalendarConnectionId)("ccn_3fa85f64-5717-4562-b3fc-2c963f66afa5")
const authorityAttemptId = Schema.decodeUnknownSync(CalendarOAuthAuthorityAttemptId)("coa_3fa85f64-5717-4562-b3fc-2c963f66afa4")
const admittedAt = Schema.decodeUnknownSync(IsoDateTimeString)(iso)

describe("opaque calendar OAuth contracts", () => {
  it("decodes legacy and versioned stable handles without accepting arbitrary client strings", () => {
    expect(Schema.decodeUnknownSync(CalendarOAuthClientAttemptHandle)("oca_3fa85f64-5717-4562-b3fc-2c963f66afa0")).toBeDefined()
    expect(Schema.decodeUnknownSync(CalendarOAuthClientAttemptHandle)(`oca_v1_${"A".repeat(43)}`)).toBeDefined()
    expect(() => Schema.decodeUnknownSync(CalendarOAuthClientAttemptHandle)("oca_unbound")).toThrow()
  })

  it("binds the canonical Begin fingerprint to workspace, principal, and exact request material", () => {
    const base = { workspaceId, principal, requestId: "calendar-connect-1", commitMessage: "Connect my work calendar.", attribution: { kind: "humanUi", surface: "web-calendar" } }
    const same = calendarOAuthBeginRequestFingerprint(base)
    const changedIntent = calendarOAuthBeginRequestFingerprint({ ...base, commitMessage: "Connect another calendar." })
    const otherPrincipal = Schema.decodeUnknownSync(Email)("other@example.test")
    const changedPrincipal = calendarOAuthBeginRequestFingerprint({ ...base, principal: otherPrincipal })

    expect(same).not.toBe(changedIntent)
    expect(same).not.toBe(changedPrincipal)
  })

  it("requires the versioned admission witness and explicit connection/binding targets", () => {
    const receipt = new CalendarOAuthAdmissionReceipt({
      version: "athenaeum.calendar-oauth-admission.v1", workspaceId, principal, requestId: "calendar-connect-1",
      requestFingerprint, handleDerivationVersion: CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION,
      attemptHandleDigest: witnessDigest, calendarConnectionId,
      authorityAttemptId, admissionWitnessDigest: witnessDigest, admittedAt
    })
    expect(Schema.encodeSync(CalendarOAuthAdmissionReceipt)(receipt).handleDerivationVersion).toBe(CALENDAR_OAUTH_HANDLE_DERIVATION_VERSION)
    expect(Schema.decodeUnknownSync(CalendarConnectionLedgerTarget)({ kind: "calendarConnection", id: receipt.calendarConnectionId })).toBeDefined()
    expect(Schema.decodeUnknownSync(GatekeeperBindingLedgerTarget)({ kind: "gatekeeperBinding", id: bindingId })).toBeDefined()
    expect(Schema.decodeUnknownSync(CalendarOAuthProviderCompletionWitness)({ version: "athenaeum.calendar-oauth-provider-completion.v1", providerConnectionId: "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa3", gatekeeperAttemptId: "gka_3fa85f64-5717-4562-b3fc-2c963f66afa2", bindingId, providerReceiptDigest: digest, completionFactDigest: digest, admissionWitnessDigest: digest })).toBeDefined()
  })

  it("projects only bounded opaque account aliases and a deterministic legacy-disable message", () => {
    expect(Schema.decodeUnknownSync(GoogleCalendarAccountAlias)("Google account ••A91E73")).toBeDefined()
    expect(() => Schema.decodeUnknownSync(GoogleCalendarAccountAlias)("owner@example.test")).toThrow()
    expect(Schema.encodeSync(LegacyGoogleCalendarOAuthDisabled)(new LegacyGoogleCalendarOAuthDisabled({ code: "legacy-google-calendar-oauth-disabled", message: "Legacy Google Calendar OAuth is disabled. Start a new calendar connection." }))).toEqual({ code: "legacy-google-calendar-oauth-disabled", message: "Legacy Google Calendar OAuth is disabled. Start a new calendar connection." })
  })
})
