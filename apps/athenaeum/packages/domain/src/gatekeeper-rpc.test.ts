import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Email } from "./auth.js"
import { Bookmark, BookmarkUrl } from "./bookmark.js"
import { CalendarEvent, CalendarEventTime } from "./calendar-event.js"
import { GatekeeperBinding, GatekeeperBindingSummary, GoogleCalendarBindingConfig } from "./gatekeeper-binding.js"
import {
  ConnectGoogleCalendarInput,
  ConnectGoogleCalendarOutput,
  CreateBookmarkInput,
  CreateBookmarkOutput,
  DisconnectGoogleCalendarInput,
  DisconnectGoogleCalendarOutput,
  GoogleCalendarOAuthCallbackInput,
  GoogleCalendarOAuthCallbackOutput,
  LinkCalendarEventToNodeInput,
  LinkCalendarEventToNodeOutput,
  ListBookmarksInput,
  ListBookmarksOutput,
  ListCalendarEventsInput,
  ListCalendarEventsOutput,
  ListGatekeeperBindingsInput,
  ListGatekeeperBindingsOutput,
  SyncGoogleCalendarInput,
  SyncGoogleCalendarOutput
} from "./gatekeeper-rpc.js"
import { EntityId, IsoDateTimeString } from "./node.js"
import { HumanUiMutationAttribution } from "./ledger.js"

const roundTrip = <A, I>(schema: Schema.Schema<A, I>, value: A) => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

const workspaceId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa6")
const bindingId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa7")
const calendarEventId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa8")
const nodeId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afa9")
const bookmarkId = EntityId.make("3fa85f64-5717-4562-b3fc-2c963f66afaa")
const email = (value: string) => Schema.decodeUnknownSync(Email)(value)
const iso = (value: number) => Schema.decodeUnknownSync(IsoDateTimeString)(new Date(value).toISOString())
const dateTime = (value: string) =>
  Schema.decodeUnknownSync(CalendarEventTime)({ kind: "dateTime", dateTime: value })

const sampleBinding = new GatekeeperBinding({
  id: bindingId,
  workspaceId,
  gatekeeperKind: "google-calendar",
  boundBy: email("alice@example.com"),
  config: new GoogleCalendarBindingConfig({
    kind: "google-calendar",
    calendarId: "primary",
    mode: "selected"
  }),
  createdAt: iso(0)
})

const sampleEvent = new CalendarEvent({
  id: calendarEventId,
  workspaceId,
  providerEventId: "google-event-1",
  title: "1:1",
  start: dateTime("2026-06-09T10:00:00Z"),
  end: dateTime("2026-06-09T10:30:00Z"),
  attendees: [],
  status: "confirmed",
  syncedAt: iso(0)
})

describe("Google Calendar connect/disconnect/sync RPC schemas", () => {
  it("round-trips ConnectGoogleCalendarInput/Output", () => {
    roundTrip(ConnectGoogleCalendarInput, new ConnectGoogleCalendarInput({ workspaceId }))
    roundTrip(
      ConnectGoogleCalendarOutput,
      new ConnectGoogleCalendarOutput({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=...",
        state: "opaque-csrf-nonce"
      })
    )
  })

  it("round-trips GoogleCalendarOAuthCallbackInput/Output, state round-tripping verbatim", () => {
    const input = new GoogleCalendarOAuthCallbackInput({
      workspaceId,
      code: "4/0Adeu5B...",
      state: "opaque-csrf-nonce",
      calendarId: "primary",
      mode: "selected"
    })
    roundTrip(GoogleCalendarOAuthCallbackInput, input)
    expect(Schema.encodeSync(GoogleCalendarOAuthCallbackInput)(input).state).toBe("opaque-csrf-nonce")

    roundTrip(GoogleCalendarOAuthCallbackOutput, new GoogleCalendarOAuthCallbackOutput({ binding: sampleBinding }))
  })

  it("round-trips DisconnectGoogleCalendarInput/Output", () => {
    roundTrip(DisconnectGoogleCalendarInput, new DisconnectGoogleCalendarInput({ workspaceId, bindingId }))
    roundTrip(DisconnectGoogleCalendarOutput, new DisconnectGoogleCalendarOutput({ disconnected: true }))
  })

  it("round-trips SyncGoogleCalendarInput/Output", () => {
    roundTrip(SyncGoogleCalendarInput, new SyncGoogleCalendarInput({ workspaceId, bindingId }))
    roundTrip(SyncGoogleCalendarOutput, new SyncGoogleCalendarOutput({ triggered: true }))
  })
})

describe("Calendar event read/link RPC schemas", () => {
  it("round-trips ListCalendarEventsInput/Output with and without from/to", () => {
    roundTrip(ListCalendarEventsInput, new ListCalendarEventsInput({ workspaceId }))
    roundTrip(
      ListCalendarEventsInput,
      new ListCalendarEventsInput({ workspaceId, from: iso(0), to: iso(86_400_000) })
    )
    roundTrip(ListCalendarEventsOutput, new ListCalendarEventsOutput({ events: [sampleEvent] }))
  })

  it("omits from/to from the encoded shape when absent", () => {
    const encoded = Schema.encodeSync(ListCalendarEventsInput)(new ListCalendarEventsInput({ workspaceId }))
    expect("from" in encoded).toBe(false)
    expect("to" in encoded).toBe(false)
  })

  it("round-trips LinkCalendarEventToNodeInput/Output", () => {
    roundTrip(
      LinkCalendarEventToNodeInput,
      new LinkCalendarEventToNodeInput({ workspaceId, calendarEventId, nodeId })
    )
    roundTrip(
      LinkCalendarEventToNodeOutput,
      new LinkCalendarEventToNodeOutput({
        calendarEvent: new CalendarEvent({
          id: calendarEventId,
          workspaceId,
          providerEventId: "google-event-1",
          title: "1:1",
          start: dateTime("2026-06-09T10:00:00Z"),
          end: dateTime("2026-06-09T10:30:00Z"),
          attendees: [],
          status: "confirmed",
          linkedNodeId: nodeId,
          syncedAt: iso(0)
        })
      })
    )
  })
})

describe("Gatekeeper binding catalog RPC schemas", () => {
  it("round-trips the workspace input and sanitized binding summaries", () => {
    roundTrip(ListGatekeeperBindingsInput, new ListGatekeeperBindingsInput({ workspaceId }))
    roundTrip(
      ListGatekeeperBindingsOutput,
      new ListGatekeeperBindingsOutput({
        bindings: [new GatekeeperBindingSummary({
          id: bindingId,
          workspaceId,
          gatekeeperKind: "google-calendar",
          mode: "selected",
          createdAt: iso(0)
        })]
      })
    )
  })
})

describe("Bookmark RPC schemas", () => {
  it("round-trips CreateBookmarkInput/Output with and without title", () => {
    const url = Schema.decodeUnknownSync(BookmarkUrl)("https://example.com/article")
    const attribution = new HumanUiMutationAttribution({
      version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "web-bookmarks"
    })
    roundTrip(CreateBookmarkInput, new CreateBookmarkInput({ workspaceId, url, title: "An article", requestId: "bookmark-fixture-with-title", commitMessage: "Capture the article.", attribution }))
    roundTrip(CreateBookmarkInput, new CreateBookmarkInput({ workspaceId, url, requestId: "bookmark-fixture-without-title", commitMessage: "Capture the URL.", attribution }))

    const bookmark = new Bookmark({ id: bookmarkId, workspaceId, url, capturedAt: iso(0) })
    roundTrip(CreateBookmarkOutput, new CreateBookmarkOutput({ bookmark }))
  })

  it("round-trips ListBookmarksInput/Output", () => {
    roundTrip(ListBookmarksInput, new ListBookmarksInput({ workspaceId }))
    const url = Schema.decodeUnknownSync(BookmarkUrl)("https://example.com")
    roundTrip(
      ListBookmarksOutput,
      new ListBookmarksOutput({
        bookmarks: [new Bookmark({ id: bookmarkId, workspaceId, url, capturedAt: iso(0) })]
      })
    )
  })
})
