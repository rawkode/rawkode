import { describe, expect, it } from "vitest"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import {
  Email,
  EntityId,
  GatekeeperBinding,
  GatekeeperBindingSummary,
  GoogleCalendarBindingConfig,
  IsoDateTimeString
} from "@athenaeum/domain"
import {
  BindingConnectionRecord,
  CalendarConnectionIdentityError,
  ProviderConnectionRecord,
  preparePendingCalendarOAuthAdmission,
  resolveGatekeeperConnectionLocator
} from "../src/calendar-connection-identity.js"
import type { CalendarObserverRecord } from "../src/calendar-collections.js"

const bindingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const otherWorkspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const createdAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())
const principal = Schema.decodeUnknownSync(Email)("alice@example.com")
const otherPrincipal = Schema.decodeUnknownSync(Email)("bob@example.com")
const connectionId = "gpc_3fa85f64-5717-4562-b3fc-2c963f66afa9"
const nonceDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const binding = new GatekeeperBinding({
  id: bindingId,
  workspaceId,
  gatekeeperKind: "google-calendar",
  boundBy: principal,
  config: new GoogleCalendarBindingConfig({ kind: "google-calendar", calendarId: "primary", mode: "selected" }),
  createdAt
})

const mapping = (overrides: Partial<ConstructorParameters<typeof BindingConnectionRecord>[0]> = {}) =>
  new BindingConnectionRecord({ bindingId, workspaceId, providerConnectionId: connectionId, createdAt, ...overrides })

const connection = (overrides: Partial<ConstructorParameters<typeof ProviderConnectionRecord>[0]> = {}) =>
  new ProviderConnectionRecord({
    providerConnectionId: connectionId,
    workspaceId,
    principal,
    provider: "google-calendar",
    status: "active",
    createdAt,
    updatedAt: createdAt,
    ...overrides
  })

describe("calendar connection identity migration adapter", () => {
  it("decodes an unchanged legacy binding and resolves it through the read-only email adapter", () => {
    const legacyDecoded = Schema.decodeUnknownSync(GatekeeperBinding)({
      id: bindingId,
      workspaceId,
      gatekeeperKind: "google-calendar",
      boundBy: "alice@example.com",
      config: { kind: "google-calendar", calendarId: "primary", mode: "selected" },
      createdAt
    })

    expect(resolveGatekeeperConnectionLocator(legacyDecoded, [], [])).toEqual({
      locator: { kind: "legacy-email", email: principal },
      identityStatus: "legacy-unverified"
    })
  })

  it("leaves the public binding summary sanitized", () => {
    const encoded = Schema.encodeSync(GatekeeperBindingSummary)(
      new GatekeeperBindingSummary({
        id: bindingId,
        workspaceId,
        gatekeeperKind: "google-calendar",
        mode: "selected",
        createdAt
      })
    )
    expect(encoded).not.toHaveProperty("boundBy")
    expect(encoded).not.toHaveProperty("calendarId")
    expect(encoded).not.toHaveProperty("providerConnectionId")
    expect(encoded).not.toHaveProperty("providerSubjectFingerprint")
  })

  it("uses an active private mapping without exposing provider identity in the result", () => {
    expect(resolveGatekeeperConnectionLocator(binding, [mapping()], [connection()])).toEqual({
      locator: { kind: "provider-connection", providerConnectionId: connectionId },
      identityStatus: "active"
    })
  })

  it("fails closed for duplicate maps, cross-workspace rows, missing records, and detached connections", () => {
    const cases = [
      resolveGatekeeperConnectionLocator(binding, [mapping(), mapping()], [connection()]),
      resolveGatekeeperConnectionLocator(binding, [mapping({ workspaceId: otherWorkspaceId })], [connection()]),
      resolveGatekeeperConnectionLocator(binding, [mapping()], []),
      resolveGatekeeperConnectionLocator(binding, [mapping()], [connection({ principal: otherPrincipal })]),
      resolveGatekeeperConnectionLocator(binding, [mapping()], [connection({ status: "detached" })])
    ]

    for (const result of cases) {
      expect(result).toBeInstanceOf(CalendarConnectionIdentityError)
      if (result instanceof CalendarConnectionIdentityError) {
        expect(result.message).not.toContain("alice@example.com")
        expect(result.message).not.toContain(connectionId)
      }
    }
    expect((cases[3] as CalendarConnectionIdentityError).code).toBe("principal-mismatch")
  })

  it("rejects malformed opaque ids, statuses, and workspace ids before they become private records", () => {
    const valid = {
      providerConnectionId: connectionId,
      workspaceId,
      principal: "alice@example.com",
      provider: "google-calendar",
      status: "active",
      createdAt,
      updatedAt: createdAt
    }
    expect(Either.isLeft(Schema.decodeUnknownEither(ProviderConnectionRecord)({ ...valid, providerConnectionId: "alice@example.com" }))).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(ProviderConnectionRecord)({ ...valid, status: "unknown" }))).toBe(true)
    expect(Either.isLeft(Schema.decodeUnknownEither(ProviderConnectionRecord)({ ...valid, workspaceId: "not-an-id" }))).toBe(true)
  })

  it("prepares isolated pending connection, binding, mapping, and attempt records for one atomic admission", () => {
    const first = preparePendingCalendarOAuthAdmission({
      workspaceId,
      principal,
      calendarId: "primary",
      mode: "selected",
      stateNonceDigest: nonceDigest,
      rowHash: nonceDigest,
      issuedAt: createdAt,
      expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(60_000).toISOString())
    })
    const second = preparePendingCalendarOAuthAdmission({
      workspaceId,
      principal,
      calendarId: "work",
      mode: "allVisible",
      stateNonceDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rowHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      issuedAt: createdAt,
      expiresAt: Schema.decodeUnknownSync(IsoDateTimeString)(new Date(60_000).toISOString())
    })

    expect(first.connection.status).toBe("pending")
    expect(first.attempt.lifecycle).toBe("pending")
    expect(first.bindingConnection.bindingId).toBe(first.binding.id)
    expect(first.bindingConnection.providerConnectionId).toBe(first.connection.providerConnectionId)
    expect(first.attempt.bindingId).toBe(first.binding.id)
    expect(first.attempt.providerConnectionId).toBe(first.connection.providerConnectionId)
    expect(second.connection.providerConnectionId).not.toBe(first.connection.providerConnectionId)
    expect(second.binding.id).not.toBe(first.binding.id)
    expect(second.attempt.attemptId).not.toBe(first.attempt.attemptId)
  })

  it("requires an explicit opaque observer connection while keeping legacy observer rows representable", () => {
    const legacy: CalendarObserverRecord = {
      id: "legacy-observer",
      workspaceId,
      bindingId,
      observerEmail: "observer@example.com",
      status: "denied",
      verifiedAt: createdAt
    }
    const opaque: CalendarObserverRecord = { ...legacy, id: "opaque-observer", observerConnectionId: connectionId }

    expect(legacy.observerConnectionId).toBeUndefined()
    expect(opaque.observerConnectionId).toBe(connectionId)
  })
})
