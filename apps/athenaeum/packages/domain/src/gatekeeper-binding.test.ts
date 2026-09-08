import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Email } from "./auth.js"
import {
  GatekeeperBinding,
  GatekeeperBindingSummary,
  GatekeeperBindingConfig,
  GatekeeperKind,
  GoogleCalendarBindingConfig
} from "./gatekeeper-binding.js"
import { EntityId, IsoDateTimeString } from "./node.js"

const id = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const boundBy = Schema.decodeUnknownSync(Email)("alice@example.com")
const createdAt = Schema.decodeUnknownSync(IsoDateTimeString)(new Date(0).toISOString())

describe("GatekeeperKind", () => {
  it("accepts google-calendar", () => {
    expect(Schema.decodeUnknownSync(GatekeeperKind)("google-calendar")).toBe("google-calendar")
  })

  it("rejects an unrecognized kind", () => {
    const result = Schema.decodeUnknownEither(GatekeeperKind)("google-drive")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("GoogleCalendarBindingConfig / GatekeeperBindingConfig", () => {
  it("round-trips a selected-calendar (Strategy B) config", () => {
    const config = new GoogleCalendarBindingConfig({
      kind: "google-calendar",
      calendarId: "primary",
      mode: "selected"
    })
    const encoded = Schema.encodeSync(GatekeeperBindingConfig)(config)
    expect(Schema.decodeUnknownSync(GatekeeperBindingConfig)(encoded)).toEqual(config)
  })

  it("round-trips an allVisible (Strategy C) config", () => {
    const config = new GoogleCalendarBindingConfig({
      kind: "google-calendar",
      calendarId: "work@example.com",
      mode: "allVisible"
    })
    const encoded = Schema.encodeSync(GatekeeperBindingConfig)(config)
    expect(Schema.decodeUnknownSync(GatekeeperBindingConfig)(encoded)).toEqual(config)
  })

  it("rejects an empty calendarId", () => {
    const result = Schema.decodeUnknownEither(GoogleCalendarBindingConfig)({
      kind: "google-calendar",
      calendarId: "",
      mode: "selected"
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("rejects an unrecognized mode", () => {
    const result = Schema.decodeUnknownEither(GoogleCalendarBindingConfig)({
      kind: "google-calendar",
      calendarId: "primary",
      mode: "everything"
    })
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("GatekeeperBinding", () => {
  it("round-trips a selected-calendar binding, with gatekeeperKind mirroring config.kind", () => {
    const binding = new GatekeeperBinding({
      id,
      workspaceId,
      gatekeeperKind: "google-calendar",
      boundBy,
      config: new GoogleCalendarBindingConfig({
        kind: "google-calendar",
        calendarId: "primary",
        mode: "selected"
      }),
      createdAt
    })
    const encoded = Schema.encodeSync(GatekeeperBinding)(binding)
    expect(Schema.decodeUnknownSync(GatekeeperBinding)(encoded)).toEqual(binding)
    expect(encoded.gatekeeperKind).toBe(encoded.config.kind)
  })

  it("round-trips a sanitized management summary without account identity", () => {
    const summary = new GatekeeperBindingSummary({
      id,
      workspaceId,
      gatekeeperKind: "google-calendar",
      mode: "selected",
      createdAt
    })
    const encoded = Schema.encodeSync(GatekeeperBindingSummary)(summary)
    expect(Schema.decodeUnknownSync(GatekeeperBindingSummary)(encoded)).toEqual(summary)
    expect(encoded).not.toHaveProperty("boundBy")
    expect(encoded).not.toHaveProperty("config")
  })
})
