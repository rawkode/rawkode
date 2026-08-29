// `CalendarService` end-to-end tests — task item 5's "real calendar CRUD/attendee-import logic
// proven against the Decisions stage's `GoogleCalendarClientScripted` double with realistic
// fixture data (recurring event with occurrences, a cancelled occurrence, overlapping attendees
// across two events)". Runs over REAL Cap'n Web RPC against a REAL `WorkspaceDurableObject`
// (`connectToWorkspace`, same harness every other backend test uses), with only the ONE seam this
// task's hard constraint allows swapped: `calendarGatekeeperClientTestHook` installs a
// `CalendarGatekeeperClientApi` built from `@athenaeum/gatekeeper-google-calendar`'s own
// `GoogleCalendarClientScripted` fixture double — see `installScriptedCalendarClient` below —
// exactly mirroring `agent-edit.test.ts`'s identical-shaped `agentEditModelClientTestHook`
// pattern. Every other line (RPC decode/encode, `requireRoleForGovernedWorkspace` gating,
// `CalendarService`'s own merge/attendee-import logic, `typed-storage-effect` writes) runs for
// real.

import { afterEach, describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CreateLoroPageInput, CreateWorkspaceInput, CreateWorkspaceOutput, CreationIntent, Email, EntityId, HumanUiMutationAttribution, LocalDate, LoroMutationIntentV1, PrepareMeetingInDailyNoteInput, PrepareMeetingInDailyNoteOutput, UnexpectedError } from "@athenaeum/domain"
import {
  addObserverStrategyC,
  CalendarAttendee as ScriptedCalendarAttendee,
  CalendarEvent as ScriptedCalendarEvent,
  GoogleCalendarClient,
  makeGoogleCalendarClientScripted,
  ObserverIdentity,
  ObserverLedger,
  ObserverLedgerInMemory,
  onDatasetTouched,
  verifyObserverStrategyB,
  type GoogleCalendarClientScriptedFixtures
} from "@athenaeum/gatekeeper-google-calendar"
import type { CalendarGatekeeperClientApi } from "../src/calendar-gatekeeper-client.js"
import { calendarGatekeeperClientTestHook } from "../src/workspace-durable-object.js"
import {
  connectToUserAs,
  connectToWorkspace,
  connectToWorkspaceWithSocketAs,
  devSignIn,
  freshWorkspaceId,
  freshNodeId,
  rejectionToDomainError,
  workspaceDurableObjectStub
} from "./support.js"

let bookmarkRequestSequence = 0
const bookmarkInput = (workspaceId: string, url: string, title?: string) => ({
  workspaceId,
  url,
  ...(title !== undefined ? { title } : {}),
  requestId: `calendar-bookmark-test-${++bookmarkRequestSequence}`,
  commitMessage: "Capture this bookmark for the calendar test.",
  attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
})

/** Wraps `GoogleCalendarClientScripted` (the Decisions stage's own realistic fixture double) into
 *  this stage's `CalendarGatekeeperClientApi` shape. `email` (this wrapper's `listCalendars`/
 *  `eventsPage` first argument) doubles as the scripted double's own `accessToken` fixture key —
 *  a deliberate test-only simplification (real token resolution is the gatekeeper Worker's own
 *  job, proven separately in `gatekeeper-google-calendar`'s own test suite — this wrapper only
 *  needs to prove `CalendarService`'s merge/attendee-import LOGIC, not token plumbing).
 *
 * **Observer verification (`mintObserverVerifier`/`addObserver`/`notifyCalendarTouched`)** —
 * same "email doubles as accessToken" convention, extended: `mintObserverVerifier` just echoes
 * the observer's own email back as an opaque "token" (real HMAC minting/unwrapping is
 * `gatekeeper-google-calendar`'s own, separately-tested concern — see `observer-verifier.test.ts`
 * in that package); `addObserver`/`notifyCalendarTouched` run the REAL Strategy B/C algorithms
 * (`verifyObserverStrategyB`/`addObserverStrategyC`/`onDatasetTouched`, this SAME package's own
 * `observer-verification.ts`) against the SAME scripted `GoogleCalendarClient` and a fresh
 * in-memory `ObserverLedger` (`ObserverLedgerInMemory`) — exactly the "`GoogleCalendarClientScripted`-
 * backed verifier that can be programmed to return qualifies/doesn't qualify for a test observer"
 * this task asks for. One ledger per `installScriptedCalendarClient` call (module-level state
 * would leak between tests — same reasoning `model-client-scripted.ts`'s own header comment gives
 * for never using a module-level mutable queue). Returns the scripted double's own handle so a
 * test can mutate `fixtures.accounts` mid-run (e.g. simulate a second calendar appearing between
 * two `syncGoogleCalendar` calls, for the Strategy C re-verification test below). */
const installScriptedCalendarClient = (fixtures: GoogleCalendarClientScriptedFixtures) => {
  const scripted = makeGoogleCalendarClientScripted(fixtures)
  const client = Effect.runSync(Effect.provide(GoogleCalendarClient, scripted.layer))
  const ledger = Effect.runSync(Effect.provide(ObserverLedger, ObserverLedgerInMemory))
  const withGatekeeperServices = <A>(effect: Effect.Effect<A, { readonly message: string }, GoogleCalendarClient | ObserverLedger>) =>
    effect.pipe(
      Effect.provideService(GoogleCalendarClient, client),
      Effect.provideService(ObserverLedger, ledger),
      Effect.mapError((cause) => new UnexpectedError({ message: cause.message }))
    )

  const api: CalendarGatekeeperClientApi = {
    buildAuthorizationUrl: (state, redirectUri) =>
      client
        .buildAuthorizationUrl({ state, redirectUri, scopes: ["https://www.googleapis.com/auth/calendar"] })
        .pipe(Effect.orDie),
    exchangeAndConnect: () => Effect.void,
    listCalendars: (email) =>
      client.listCalendars(email).pipe(
        Effect.map((cals) => cals.map((c) => ({ id: c.id, summary: c.summary, ...(c.accessRole ? { accessRole: c.accessRole } : {}) }))),
        Effect.orDie
      ),
    eventsPage: (email, calendarId, query) =>
      client.listEvents(email, calendarId, query as never).pipe(
        Effect.map((page) => ({
          items: page.items.map((e) => ({
            id: e.id,
            title: e.title,
            start: e.start,
            end: e.end,
            status: e.status,
            ...(e.attendees ? { attendees: e.attendees } : {}),
            ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {})
          })),
          ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
          ...(page.nextSyncToken ? { nextSyncToken: page.nextSyncToken } : {})
        })),
        Effect.orDie
      ),
    mintObserverVerifier: (observerEmail) => Effect.succeed({ token: observerEmail }),
    addObserver: (_boundByEmail, bindingId, observerId, verifierToken, mode, calendarId) =>
      withGatekeeperServices(
        mode === "selected"
          ? verifyObserverStrategyB(observerId, verifierToken, calendarId)
          : addObserverStrategyC(
              bindingId,
              observerId,
              new ObserverIdentity({ observerEmail: Schema.decodeUnknownSync(Email)(observerId), connectionId: verifierToken }),
              verifierToken
            )
      ),
    notifyCalendarTouched: (_boundByEmail, bindingId, calendarId) =>
      withGatekeeperServices(onDatasetTouched(bindingId, calendarId, (identity) => Effect.succeed(identity.connectionId)))
  }
  calendarGatekeeperClientTestHook.api = api
  return scripted
}

/** Same real `UserDurableObject#createWorkspace` round trip every governed-workspace test in this suite
 *  needs — hoisted to module scope (rather than redefined per `describe` block) once a second
 *  suite (observer verification) needed it too. */
const createGovernedWorkspace = async (ownerEmail: string): Promise<EntityId> => {
  const { credential } = await devSignIn(ownerEmail)
  const { stub, socket } = await connectToUserAs(credential)
  try {
    const created = Schema.decodeUnknownSync(CreateWorkspaceOutput)(
      await stub.createWorkspace(Schema.encodeSync(CreateWorkspaceInput)(new CreateWorkspaceInput({ title: "Calendar-gated workspace" })))
    )
    return created.workspace.workspaceId
  } finally {
    stub[Symbol.dispose]()
    socket.close()
  }
}

afterEach(() => {
  calendarGatekeeperClientTestHook.api = undefined
})

const ACCOUNT_EMAIL = "owner@example.test"
const CALENDAR_ID = "team@group.calendar.google.com"

describe("CalendarService — connect/callback/disconnect", () => {
  it("connectGoogleCalendar returns a real authorization URL, and the callback finalizes a binding", async () => {
    installScriptedCalendarClient({ accounts: { [ACCOUNT_EMAIL]: { calendars: {}, freeBusyReadableCalendarIds: [], events: {} } } })

    const { credential, email } = await devSignIn(ACCOUNT_EMAIL)
    const workspaceId = freshWorkspaceId()
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const connectResult = (await stub.connectGoogleCalendar({ workspaceId })) as { authorizationUrl: string; state: string }
    expect(connectResult.authorizationUrl).toContain("state=")
    expect(typeof connectResult.state).toBe("string")

    const callbackResult = (await stub.googleCalendarOAuthCallback({
      workspaceId,
      code: "unused-in-scripted-wrapper",
      state: connectResult.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string; gatekeeperKind: string; boundBy: string } }

    expect(callbackResult.binding.gatekeeperKind).toBe("google-calendar")
    expect(callbackResult.binding.boundBy).toBe(email)

    const disconnectResult = (await stub.disconnectGoogleCalendar({
      workspaceId,
      bindingId: callbackResult.binding.id
    })) as { disconnected: boolean }
    expect(disconnectResult.disconnected).toBe(true)
  })

  it("rejects a callback whose state was minted for a different workspace", async () => {
    installScriptedCalendarClient({ accounts: { [ACCOUNT_EMAIL]: { calendars: {}, freeBusyReadableCalendarIds: [], events: {} } } })
    const { credential } = await devSignIn(ACCOUNT_EMAIL)
    const workspaceA = freshWorkspaceId()
    const workspaceB = freshWorkspaceId()
    const { stub: stubA } = await connectToWorkspaceWithSocketAs(workspaceA, credential)
    const { stub: stubB } = await connectToWorkspaceWithSocketAs(workspaceB, credential)

    const connectResult = (await stubA.connectGoogleCalendar({ workspaceId: workspaceA })) as { state: string }

    const error = await rejectionToDomainError(
      stubB.googleCalendarOAuthCallback({
        workspaceId: workspaceB,
        code: "code",
        state: connectResult.state,
        calendarId: CALENDAR_ID,
        mode: "selected"
      })
    )
    expect(error._tag).toBe("ValidationError")
  })
})

describe("CalendarService — sync + attendee import (realistic fixtures)", () => {
  const alice = "alice@example.test"
  const bob = "bob@example.test"

  /** Fixture: a standalone event and a two-occurrence recurring series (one confirmed, one
   *  cancelled), with overlapping attendees (alice + bob on both). */
  const buildFixtures = (): GoogleCalendarClientScriptedFixtures => ({
    accounts: {
      [ACCOUNT_EMAIL]: {
        calendars: { [CALENDAR_ID]: "owner" },
        freeBusyReadableCalendarIds: [],
        events: {
          [CALENDAR_ID]: [
            new ScriptedCalendarEvent({
              id: "standup-1",
              title: "Daily Standup",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed",
              attendees: [
                new ScriptedCalendarAttendee({ email: alice, displayName: "Alice" }),
                new ScriptedCalendarAttendee({ email: bob, displayName: "Bob" })
              ]
            }),
            new ScriptedCalendarEvent({
              id: "series-1_20260901T090000Z",
              title: "Weekly Planning",
              start: { kind: "dateTime", dateTime: "2026-09-01T09:00:00.000Z" },
              end: { kind: "dateTime", dateTime: "2026-09-01T09:30:00.000Z" },
              status: "confirmed",
              attendees: [new ScriptedCalendarAttendee({ email: alice, displayName: "Alice" })],
              recurringEventId: "series-1"
            }),
            new ScriptedCalendarEvent({
              id: "series-1_20260908T090000Z",
              title: "Weekly Planning",
              start: { kind: "dateTime", dateTime: "2026-09-08T09:00:00.000Z" },
              end: { kind: "dateTime", dateTime: "2026-09-08T09:30:00.000Z" },
              status: "cancelled",
              attendees: [
                new ScriptedCalendarAttendee({ email: alice, displayName: "Alice" }),
                new ScriptedCalendarAttendee({ email: bob, displayName: "Bob" })
              ],
              recurringEventId: "series-1"
            })
          ]
        }
      }
    }
  })

  const setUpConnectedWorkspace = async (): Promise<{ workspaceId: EntityId; bindingId: EntityId; stub: Awaited<ReturnType<typeof connectToWorkspaceWithSocketAs>>["stub"] }> => {
    installScriptedCalendarClient(buildFixtures())
    const { credential } = await devSignIn(ACCOUNT_EMAIL)
    const workspaceId = freshWorkspaceId()
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)
    const connectResult = (await stub.connectGoogleCalendar({ workspaceId })) as { state: string }
    const callbackResult = (await stub.googleCalendarOAuthCallback({
      workspaceId,
      code: "code",
      state: connectResult.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string } }
    const bindingId = Schema.decodeUnknownSync(EntityId)(callbackResult.binding.id)
    return { workspaceId, bindingId, stub }
  }

  it("syncs a standalone event and a recurring series, synthesizing a stable master row for occurrences", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()

    const syncResult = (await stub.syncGoogleCalendar({ workspaceId, bindingId })) as { triggered: boolean }
    expect(syncResult.triggered).toBe(true)

    const listResult = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{
        id: string
        providerEventId: string
        seriesId?: string
        occurrenceId?: string
        masterRecordId?: string
        status: string
        title: string
      }>
    }

    // Standalone event: no series identity.
    const standup = listResult.events.find((e) => e.providerEventId === "standup-1")
    expect(standup).toBeDefined()
    expect(standup?.seriesId).toBeUndefined()

    // Synthesized master row, one per series.
    const master = listResult.events.find((e) => e.providerEventId === "series-1")
    expect(master).toBeDefined()
    expect(master?.seriesId).toBe("series-1")
    expect(master?.masterRecordId).toBeUndefined()

    // Both occurrences exist, point at the SAME synthesized master, and the cancelled one is
    // tombstoned (status: "cancelled") rather than absent.
    const occurrences = listResult.events.filter((e) => e.seriesId === "series-1" && e.masterRecordId !== undefined)
    expect(occurrences).toHaveLength(2)
    expect(new Set(occurrences.map((o) => o.masterRecordId))).toEqual(new Set([master?.id]))
    const cancelled = occurrences.find((o) => o.status === "cancelled")
    expect(cancelled).toBeDefined()
    expect(cancelled?.providerEventId).toBe("series-1_20260908T090000Z")

    // Total rows: 1 standalone + 1 synthesized master + 2 occurrences = 4.
    expect(listResult.events).toHaveLength(4)
  })

  it("imports attendees as deduplicated Person nodes, shared across overlapping events", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const nodesResult = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ id: string; title: string }> }
    // Exactly two Person nodes — alice (attendee on all 3 events) and bob (attendee on 2 of 3) —
    // never duplicated despite appearing on multiple events/occurrences within one sync pass.
    const alicelike = nodesResult.nodes.filter((n) => n.title === "Alice")
    const boblike = nodesResult.nodes.filter((n) => n.title === "Bob")
    expect(alicelike).toHaveLength(1)
    expect(boblike).toHaveLength(1)
  })

  it("re-syncing does not duplicate calendar events or Person nodes, and preserves a linked node", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const firstList = (await stub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<{ id: string; providerEventId: string }> }
    const standup = firstList.events.find((e) => e.providerEventId === "standup-1")!

    const nodeId = freshNodeId()
    await stub.createNode({ workspaceId, id: nodeId, title: "My annotation" })
    const linkResult = (await stub.linkCalendarEventToNode({
      workspaceId,
      calendarEventId: standup.id,
      nodeId
    })) as { calendarEvent: { linkedNodeId?: string } }
    expect(linkResult.calendarEvent.linkedNodeId).toBe(nodeId)

    // Re-sync (same fixtures) — every provider row already exists, so `sync` upserts in place.
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const secondList = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ id: string; providerEventId: string; linkedNodeId?: string }>
    }
    expect(secondList.events).toHaveLength(firstList.events.length)
    const standupAfterResync = secondList.events.find((e) => e.providerEventId === "standup-1")
    // Provider apply never touches the linked node — it must survive an unrelated re-sync.
    expect(standupAfterResync?.linkedNodeId).toBe(nodeId)

    const nodesResult = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(nodesResult.nodes.filter((n) => n.title === "Alice")).toHaveLength(1)
    expect(nodesResult.nodes.filter((n) => n.title === "Bob")).toHaveLength(1)
  })

  it("prepares the deterministic daily note through the ledger and rejects stale page/date claims", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    const localDate = Schema.decodeUnknownSync(LocalDate)(new Date().toISOString().slice(0, 10))
    const brief = (await stub.getTodayBrief({ workspaceId, localDate, timeZone: "UTC" })) as {
      events: ReadonlyArray<{ title: string; occurrenceKey: string }>
    }
    const meeting = brief.events.find((event) => event.title === "Daily Standup")
    expect(meeting).toBeDefined()
    const dailyNoteId = Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-0000${localDate.replaceAll("-", "")}`)
    await stub.createNode({ workspaceId, id: dailyNoteId, title: `Daily Note — ${localDate}` })
    await stub.createLoroPage(Schema.encodeSync(CreateLoroPageInput)(new CreateLoroPageInput({
      workspaceId,
      nodeId: dailyNoteId,
      creationIntent: new CreationIntent({
        requestId: `prepare-page-${crypto.randomUUID()}`,
        commitMessage: "Create the daily note for meeting preparation.",
        attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "rich-text-editor" })
      })
    })))
    const makeInput = (
      requestId: string,
      dailyNoteIdOverride: typeof dailyNoteId = dailyNoteId,
      localDateOverride: typeof localDate = localDate,
      commitMessage = "Prepare the meeting in the daily note.",
      surface: "rich-text-editor" | "macos" = "rich-text-editor"
    ) => Schema.encodeSync(PrepareMeetingInDailyNoteInput)(new PrepareMeetingInDailyNoteInput({
      workspaceId,
      dailyNoteId: dailyNoteIdOverride,
      localDate: localDateOverride,
      timeZone: "UTC",
      occurrenceKey: meeting!.occurrenceKey,
      intent: new LoroMutationIntentV1({
        requestId,
        commitMessage,
        attribution: new HumanUiMutationAttribution({ version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface })
      })
    }))
    const first = Schema.decodeUnknownSync(PrepareMeetingInDailyNoteOutput)(await stub.prepareMeetingInDailyNote(makeInput("prepare-meeting-first")))
    expect(first.status).toBe("created")
    // A new transport request id replays the stable event/date/page operation rather than adding
    // a second preparation block.
    const replay = Schema.decodeUnknownSync(PrepareMeetingInDailyNoteOutput)(await stub.prepareMeetingInDailyNote(makeInput("prepare-meeting-retry")))
    expect(replay).toEqual(first)
    const identity = `prepare-meeting-in-daily-note:${workspaceId}:${dailyNoteId}:${localDate}:UTC:${meeting!.occurrenceKey}`
    const command = await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(identity)
    expect(command).toMatchObject({ type: "prepareMeetingInDailyNote", payload: { nodeId: dailyNoteId, localDate, timeZone: "UTC", occurrenceKey: meeting!.occurrenceKey } })

    // Native and web use different copy/surfaces, but the server-owned operation is still the
    // same event/date/page/time-zone mutation and must replay instead of conflicting.
    const crossClientReplay = await stub.prepareMeetingInDailyNote(makeInput(
      "prepare-meeting-native-retry",
      dailyNoteId,
      localDate,
      "Prepare meeting context in daily note.",
      "macos"
    ))
    expect(crossClientReplay).toEqual(first)

    const wrongPage = await rejectionToDomainError(stub.prepareMeetingInDailyNote(makeInput(
      "prepare-meeting-wrong-page",
      Schema.decodeUnknownSync(EntityId)("00000000-0000-4000-8000-000000000099")
    )))
    expect(wrongPage._tag).toBe("ValidationError")
    const wrongDate = await rejectionToDomainError(stub.prepareMeetingInDailyNote(makeInput(
      "prepare-meeting-wrong-date",
      dailyNoteId,
      Schema.decodeUnknownSync(LocalDate)("2026-01-01")
    )))
    expect(wrongDate._tag).toBe("ValidationError")
  })
})

describe("CalendarService — bookmarks", () => {
  it("creates and lists bookmarks", async () => {
    const { credential } = await devSignIn("bookmarker@example.test")
    const workspaceId = freshWorkspaceId()
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const created = (await stub.createBookmark(bookmarkInput(
      workspaceId, "https://example.test/article", "An article"
    ))) as { bookmark: { id: string; url: string; title?: string } }
    expect(created.bookmark.url).toBe("https://example.test/article")
    expect(created.bookmark.title).toBe("An article")

    const listed = (await stub.listBookmarks({ workspaceId })) as { bookmarks: ReadonlyArray<{ id: string }> }
    expect(listed.bookmarks.map((b) => b.id)).toContain(created.bookmark.id)
  })
})

// Observer-verification wiring (task: "wire the observer verification mechanism into the REAL
// Phase 4 SharingService — when a new collaborator is added... to a workspace that has a
// google-calendar GatekeeperBinding, trigger observer verification per the Decisions stage's
// Strategy B/C design"). Every test below adds a REAL collaborator via `SharingService#
// addCollaborator` (the real `AddCollaboratorInput`/`requireAuthenticatedUser`/`resolveCaller`
// path — no shortcut into `CalendarService#verifyObserver` directly), then proves the READ-SIDE
// enforcement is a real filter, not a comment, by driving `listCalendarEvents`/`listNodes` as
// that SAME newly-added collaborator over a fresh Cap'n Web connection.

describe("CalendarService — observer verification (Strategy B, selected-mode binding)", () => {
  const alice = "alice@example.test"
  const grantedObserver = "granted-observer@example.test"
  const deniedObserver = "denied-observer@example.test"

  const buildFixtures = (): GoogleCalendarClientScriptedFixtures => ({
    accounts: {
      [ACCOUNT_EMAIL]: {
        calendars: { [CALENDAR_ID]: "owner" },
        freeBusyReadableCalendarIds: [],
        events: {
          [CALENDAR_ID]: [
            new ScriptedCalendarEvent({
              id: "1-1-meeting",
              title: "1:1 with Alice",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed",
              attendees: [new ScriptedCalendarAttendee({ email: alice, displayName: "Alice" })]
            })
          ]
        }
      },
      // Has `writer` on the SAME calendar the binding is bound to — Strategy B's own bar
      // ("writer"/"owner", never "reader" — see `observer-verification.ts`'s own doc comment).
      [grantedObserver]: { calendars: { [CALENDAR_ID]: "writer" }, freeBusyReadableCalendarIds: [], events: {} },
      // Has no access to the calendar at all — `getCalendar` 404s, exactly the "never connected
      // an account with real access" case every reviewer of this stage hits for real.
      [deniedObserver]: { calendars: {}, freeBusyReadableCalendarIds: [], events: {} }
    }
  })

  it("a qualifying observer sees calendar events and attendee-imported Person nodes; a non-qualifying one is excluded from BOTH while still seeing other workspace content", async () => {
    installScriptedCalendarClient(buildFixtures())
    const workspaceId = await createGovernedWorkspace(ACCOUNT_EMAIL)
    const { credential: ownerCred } = await devSignIn(ACCOUNT_EMAIL)
    const { stub: ownerStub } = await connectToWorkspaceWithSocketAs(workspaceId, ownerCred)

    const connectResult = (await ownerStub.connectGoogleCalendar({ workspaceId })) as { state: string }
    const callbackResult = (await ownerStub.googleCalendarOAuthCallback({
      workspaceId,
      code: "code",
      state: connectResult.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string } }
    const bindingId = Schema.decodeUnknownSync(EntityId)(callbackResult.binding.id)
    await ownerStub.syncGoogleCalendar({ workspaceId, bindingId })

    // Non-calendar content — must stay visible to EVERY viewer with workspace access, regardless of
    // their calendar-observer status (task: "sharing a workspace doesn't gate on this — only the
    // calendar-sourced subset does").
    const manualNodeId = freshNodeId()
    await ownerStub.createNode({ workspaceId, id: manualNodeId, title: "Plain workspace note" })

    // The real trigger under test: `addCollaborator` (not a direct `verifyObserver` call).
    await ownerStub.addCollaborator({ workspaceId, profileId: grantedObserver, role: "use" })
    await ownerStub.addCollaborator({ workspaceId, profileId: deniedObserver, role: "use" })

    const { credential: grantedCred } = await devSignIn(grantedObserver)
    const { stub: grantedStub } = await connectToWorkspaceWithSocketAs(workspaceId, grantedCred)
    const grantedEvents = (await grantedStub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ title: string }>
    }
    expect(grantedEvents.events.map((e) => e.title)).toContain("1:1 with Alice")
    const localDate = new Date().toISOString().slice(0, 10)
    const ownerBrief = (await ownerStub.getTodayBrief({ workspaceId, localDate, timeZone: "UTC" })) as {
      calendarHistory: { status: string }
      events: ReadonlyArray<{ title: string; people: ReadonlyArray<{ displayName?: string }> }>
    }
    expect(ownerBrief.calendarHistory.status).toBe("found")
    expect(ownerBrief.events).toEqual(expect.arrayContaining([expect.objectContaining({ title: "1:1 with Alice" })]))
    expect(JSON.stringify(ownerBrief)).not.toContain("alice@example.test")
    const grantedNodes = (await grantedStub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(grantedNodes.nodes.some((n) => n.title === "Alice")).toBe(true)
    expect(grantedNodes.nodes.some((n) => n.title === "Plain workspace note")).toBe(true)

    const { credential: deniedCred } = await devSignIn(deniedObserver)
    const { stub: deniedStub } = await connectToWorkspaceWithSocketAs(workspaceId, deniedCred)
    const deniedEvents = (await deniedStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(deniedEvents.events).toHaveLength(0)
    const deniedBrief = (await deniedStub.getTodayBrief({ workspaceId, localDate, timeZone: "UTC" })) as {
      calendarHistory: { status: string }
      events: ReadonlyArray<unknown>
    }
    // A calendar-policy denial is intentionally identical to a workspace with no matching
    // Athenaeum-retained events: neither the binding nor observer state is exposed.
    expect(deniedBrief).toMatchObject({ calendarHistory: { status: "noneInRetainedData" }, events: [] })
    const deniedNodes = (await deniedStub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    // Excluded specifically: the attendee-imported Person node is gone...
    expect(deniedNodes.nodes.some((n) => n.title === "Alice")).toBe(false)
    // ...but the plain, non-calendar node is still there.
    expect(deniedNodes.nodes.some((n) => n.title === "Plain workspace note")).toBe(true)

    // `getNode` enforces the identical gate on the single-node read, reporting a hidden
    // calendar-derived node exactly as "not found" — never distinguishable from a node that
    // simply doesn't exist.
    const aliceNodeId = grantedNodes.nodes.find((n) => n.title === "Alice")
    expect(aliceNodeId).toBeDefined()

    // Adversarial-review fix probe: the exact live probe that demonstrated the pre-fix leak —
    // `runView("graph_node_tags", {visibleColumns:["nodeId","tagId"]})` used to let a denied
    // observer recover the hidden node's raw id even though `listNodes`/`getNode` correctly
    // excluded it (`views-service-live.ts`'s own header comment has the full story). Resolve
    // Alice's real node id off the GRANTED observer's own (correctly visible) `listNodes` result.
    const grantedNodesWithIds = grantedNodes.nodes as unknown as ReadonlyArray<{ id: string; title: string }>
    const aliceNode = grantedNodesWithIds.find((n) => n.title === "Alice")
    expect(aliceNode).toBeDefined()
    const realAliceNodeId = aliceNode!.id

    const nodeTagsViewSpec = { view: "table", visibleColumns: ["nodeId", "tagId"], rowLimit: 200 }

    const grantedTagRows = (await grantedStub.runView({
      workspaceId,
      viewName: "graph_node_tags",
      viewSpec: nodeTagsViewSpec
    })) as { rows: ReadonlyArray<{ nodeId: string; tagId: string }> }
    // Sanity check the fixture actually produced a row to hide in the first place — a vacuous
    // pass here (denied sees nothing because there was nothing to see) would prove nothing.
    expect(grantedTagRows.rows.some((r) => r.nodeId === realAliceNodeId)).toBe(true)

    const deniedTagRows = (await deniedStub.runView({
      workspaceId,
      viewName: "graph_node_tags",
      viewSpec: nodeTagsViewSpec
    })) as { rows: ReadonlyArray<{ nodeId: string; tagId: string }> }
    expect(deniedTagRows.rows.some((r) => r.nodeId === realAliceNodeId)).toBe(false)

    // `searchNodes` gets the identical filter applied — defense in depth: this specific node
    // isn't indexed for search at all today (a separate, real completeness gap documented in
    // `calendar-service-live.ts`'s `findOrCreatePersonNode` doc comment), so this assertion is
    // currently vacuous, but it locks in the contract so a future fix to THAT gap can never
    // silently reintroduce a search-based leak of the same shape.
    const deniedSearch = (await deniedStub.searchNodes({ workspaceId, query: "Alice", limit: 50 })) as {
      results: ReadonlyArray<{ nodeId: string }>
    }
    expect(deniedSearch.results.some((r) => r.nodeId === realAliceNodeId)).toBe(false)
  })
})

describe("CalendarService — observer verification (Strategy C, allVisible-mode binding, re-verification on new calendar touch)", () => {
  const primaryCalendarId = "primary@group.calendar.google.test"
  const secondaryCalendarId = "secondary@group.calendar.google.test"
  const observerEmail = "strategy-c-observer@example.test"

  const buildFixtures = (): GoogleCalendarClientScriptedFixtures => ({
    accounts: {
      [ACCOUNT_EMAIL]: {
        calendars: { [primaryCalendarId]: "owner" },
        freeBusyReadableCalendarIds: [],
        events: {
          [primaryCalendarId]: [
            new ScriptedCalendarEvent({
              id: "team-sync",
              title: "Team Sync",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed"
            })
          ]
        }
      },
      // Can read free/busy for the PRIMARY calendar (the one the binding is bound to) but NOT
      // the secondary one — which does not exist in the ACCOUNT's fixture yet, so `sync()`'s
      // `listCalendars` discovery cannot touch it on the first pass either.
      [observerEmail]: { calendars: {}, freeBusyReadableCalendarIds: [primaryCalendarId], events: {} }
    }
  })

  it("stays granted through a sync that only touches the already-covered primary calendar, then gets excluded once a genuinely new calendar is discovered and touched", async () => {
    const handle = installScriptedCalendarClient(buildFixtures())
    const workspaceId = await createGovernedWorkspace(ACCOUNT_EMAIL)
    const { credential: ownerCred } = await devSignIn(ACCOUNT_EMAIL)
    const { stub: ownerStub } = await connectToWorkspaceWithSocketAs(workspaceId, ownerCred)

    const connectResult = (await ownerStub.connectGoogleCalendar({ workspaceId })) as { state: string }
    const callbackResult = (await ownerStub.googleCalendarOAuthCallback({
      workspaceId,
      code: "code",
      state: connectResult.state,
      calendarId: primaryCalendarId,
      mode: "allVisible"
    })) as { binding: { id: string } }
    const bindingId = Schema.decodeUnknownSync(EntityId)(callbackResult.binding.id)

    // Added BEFORE any sync — the Strategy C dataset log is empty at this point, so
    // `addObserverStrategyC` trivially grants (nothing yet to verify against) and registers the
    // observer for future re-verification sweeps.
    await ownerStub.addCollaborator({ workspaceId, profileId: observerEmail, role: "use" })

    const { credential: observerCred } = await devSignIn(observerEmail)
    const { stub: observerStub } = await connectToWorkspaceWithSocketAs(workspaceId, observerCred)

    await ownerStub.syncGoogleCalendar({ workspaceId, bindingId })
    // Only the primary calendar exists/was touched so far — the observer's own free/busy access
    // to it holds, so they remain granted and see the real synced event.
    const afterFirstSync = (await observerStub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ title: string }>
    }
    expect(afterFirstSync.events.map((e) => e.title)).toContain("Team Sync")

    // A genuinely new foreign calendar now exists under this SAME binding's bound account —
    // mutating the scripted double's fixtures mid-run (its own documented capability) rather than
    // reinstalling a fresh double, so the NEXT sync call is the one that actually discovers it.
    handle.fixtures.accounts[ACCOUNT_EMAIL] = {
      ...handle.fixtures.accounts[ACCOUNT_EMAIL]!,
      calendars: { ...handle.fixtures.accounts[ACCOUNT_EMAIL]!.calendars, [secondaryCalendarId]: "owner" },
      events: { ...handle.fixtures.accounts[ACCOUNT_EMAIL]!.events, [secondaryCalendarId]: [] }
    }

    await ownerStub.syncGoogleCalendar({ workspaceId, bindingId })
    // This second sync's `listCalendars` discovery finds `secondaryCalendarId` for the first
    // time, touches it, and Strategy C re-verifies every registered observer against it — this
    // observer cannot read ITS free/busy, so `onDatasetTouched` reports them as failed and their
    // stored status flips to denied. The gate is workspace-wide for this binding (task's own
    // documented "one binding, one unit" simplification — see `isCalendarContentVisible`'s doc
    // comment), so even the calendar they COULD independently read is now hidden too.
    const afterSecondSync = (await observerStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(afterSecondSync.events).toHaveLength(0)

    // The owner is completely unaffected — it's their own connected account's data.
    const ownerView = (await ownerStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<{ title: string }> }
    expect(ownerView.events.map((e) => e.title)).toContain("Team Sync")
  })
})

describe("CalendarService — governed-workspace role gating (hard constraint)", () => {
  it("rejects an anonymous caller on a governed (shared) workspace for every gatekeeper method", async () => {
    const workspaceId = await createGovernedWorkspace("gated-owner@example.test")

    const anon = await connectToWorkspace(workspaceId)
    const connectError = await rejectionToDomainError(anon.connectGoogleCalendar({ workspaceId }))
    expect(connectError._tag).toBe("Unauthorized")
    const listError = await rejectionToDomainError(anon.listCalendarEvents({ workspaceId }))
    expect(listError._tag).toBe("Unauthorized")
    const bookmarksError = await rejectionToDomainError(anon.listBookmarks({ workspaceId }))
    expect(bookmarksError._tag).toBe("Unauthorized")
  })

  it("allows the owner (build role) to create a bookmark on a governed workspace", async () => {
    const { credential } = await devSignIn("bookmark-owner@example.test")
    const workspaceId = await createGovernedWorkspace("bookmark-owner@example.test")
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const created = (await stub.createBookmark(bookmarkInput(workspaceId, "https://example.test/x"))) as {
      bookmark: { id: string }
    }
    expect(typeof created.bookmark.id).toBe("string")
  })

  // Task item 4's own explicit ask: "confirm a 'use'-only collaborator can read bookmarks but a
  // role check applies consistent with other mutations — confirm the actual behavior you built,
  // don't assume." `createBookmark`/`listBookmarks`'s role split ("build/"use") was previously
  // only proven by static code reading (`requireRoleForGovernedWorkspace(currentUser, "build" | "use")`
  // in `workspace-durable-object.ts`) — this drives it through a REAL "use"-only collaborator over a
  // real Cap'n Web connection, exactly like the Strategy B/C observer tests above.
  it("a 'use'-only collaborator can list bookmarks but is rejected (Unauthorized) creating one", async () => {
    const ownerEmail = "bookmark-role-owner@example.test"
    const readerEmail = "bookmark-role-reader@example.test"
    const { credential: ownerCred } = await devSignIn(ownerEmail)
    const workspaceId = await createGovernedWorkspace(ownerEmail)
    const { stub: ownerStub } = await connectToWorkspaceWithSocketAs(workspaceId, ownerCred)

    const ownerBookmark = (await ownerStub.createBookmark(bookmarkInput(
      workspaceId, "https://example.test/owner-added", "Owner's bookmark"
    ))) as { bookmark: { id: string } }

    await ownerStub.addCollaborator({ workspaceId, profileId: readerEmail, role: "use" })

    const { credential: readerCred } = await devSignIn(readerEmail)
    const { stub: readerStub } = await connectToWorkspaceWithSocketAs(workspaceId, readerCred)

    // Read: a "use" role is exactly the minimum `listBookmarks` requires — must succeed, and see
    // the owner's bookmark (bookmarks are ordinary governed-workspace content, not calendar-gated).
    const listed = (await readerStub.listBookmarks({ workspaceId })) as { bookmarks: ReadonlyArray<{ id: string }> }
    expect(listed.bookmarks.map((b) => b.id)).toContain(ownerBookmark.bookmark.id)

    // Mutate: `createBookmark` requires "build" — a "use"-only collaborator is one rank short and
    // must be rejected the same way every other under-privileged mutation is (Unauthorized), not
    // silently allowed and not a different error shape.
    const createError = await rejectionToDomainError(
      readerStub.createBookmark(bookmarkInput(workspaceId, "https://example.test/reader-attempt"))
    )
    expect(createError._tag).toBe("Unauthorized")

    // The rejected create must not have landed — the reader's own attempted URL never appears.
    const listedAfterRejection = (await readerStub.listBookmarks({ workspaceId })) as {
      bookmarks: ReadonlyArray<{ url: string }>
    }
    expect(listedAfterRejection.bookmarks.map((b) => b.url)).not.toContain("https://example.test/reader-attempt")
  })
})

describe("CalendarService/MeetingsService — Meeting/Bookmark.linkedNodeId observer-visibility (adversarial-review fix, Phase 6)", () => {
  const owner = "linkednode-owner@example.test"
  const grantedObserver = "linkednode-granted@example.test"
  const deniedObserver = "linkednode-denied@example.test"

  const buildFixtures = (): GoogleCalendarClientScriptedFixtures => ({
    accounts: {
      [owner]: {
        calendars: { [CALENDAR_ID]: "owner" },
        freeBusyReadableCalendarIds: [],
        events: {
          [CALENDAR_ID]: [
            new ScriptedCalendarEvent({
              id: "linkednode-meeting",
              title: "Roadmap sync",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed",
              attendees: [new ScriptedCalendarAttendee({ email: "attendee@example.test", displayName: "Attendee" })]
            })
          ]
        }
      },
      // Writer on the bound calendar — qualifies per Strategy B.
      [grantedObserver]: { calendars: { [CALENDAR_ID]: "writer" }, freeBusyReadableCalendarIds: [], events: {} },
      // No access at all — never qualifies.
      [deniedObserver]: { calendars: {}, freeBusyReadableCalendarIds: [], events: {} }
    }
  })

  /**
   * Proves the fix for real, both halves: (1) a genuinely hidden calendar-derived node id, set as
   * a `Meeting`/`Bookmark`'s `linkedNodeId` via the new debug-only `linkMeetingToNode`/
   * `linkBookmarkToNode` capabilities (see those methods' own doc comments for why no public RPC
   * does this yet), is OMITTED from `getMeeting`/`listMeetings`/`listBookmarks` for the denied
   * observer — not nulled, not left as the raw id (the pre-fix leak `MeetingsPanel.tsx` would have
   * rendered in italics), genuinely absent from the object; (2) the SAME `linkedNodeId` is
   * genuinely visible to a qualifying observer and to the owner, so this isn't a blanket "always
   * hide" regression.
   */
  it("omits a hidden calendar-derived node's id from Meeting/Bookmark.linkedNodeId for a non-qualifying observer, but not for a qualifying one", async () => {
    installScriptedCalendarClient(buildFixtures())
    const workspaceId = await createGovernedWorkspace(owner)
    const { credential: ownerCred } = await devSignIn(owner)
    const { stub: ownerStub } = await connectToWorkspaceWithSocketAs(workspaceId, ownerCred)

    const connectResult = (await ownerStub.connectGoogleCalendar({ workspaceId })) as { state: string }
    const callbackResult = (await ownerStub.googleCalendarOAuthCallback({
      workspaceId,
      code: "code",
      state: connectResult.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string } }
    const bindingId = Schema.decodeUnknownSync(EntityId)(callbackResult.binding.id)
    await ownerStub.syncGoogleCalendar({ workspaceId, bindingId })

    const grantedNodes = (await ownerStub.listNodes({ workspaceId })) as {
      nodes: ReadonlyArray<{ id: string; title: string }>
    }
    const attendeeNode = grantedNodes.nodes.find((n) => n.title === "Attendee")
    expect(attendeeNode).toBeDefined() // sanity check: a real calendar-derived node exists to hide
    const hiddenNodeId = attendeeNode!.id as unknown as EntityId

    const started = (await ownerStub.startMeeting({ workspaceId, title: "Roadmap sync notes", requestId: "calendar-visibility-meeting", commitMessage: "Start the roadmap sync meeting.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" } })) as {
      meeting: { id: string }
    }
    const meetingId = started.meeting.id as unknown as EntityId
    const bookmarkResult = (await ownerStub.createBookmark(bookmarkInput(
      workspaceId, "https://example.test/roadmap-notes"
    ))) as { bookmark: { id: string } }
    const bookmarkId = bookmarkResult.bookmark.id as unknown as EntityId

    const doStub = workspaceDurableObjectStub(workspaceId)
    await doStub.debugLinkMeetingToNode(meetingId, hiddenNodeId)
    await doStub.debugLinkBookmarkToNode(bookmarkId, hiddenNodeId)

    await ownerStub.addCollaborator({ workspaceId, profileId: grantedObserver, role: "use" })
    await ownerStub.addCollaborator({ workspaceId, profileId: deniedObserver, role: "use" })

    // Owner: sees the real linkedNodeId (own data — trivially qualifies).
    const ownerMeeting = (await ownerStub.getMeeting({ workspaceId, meetingId })) as {
      meeting: { linkedNodeId?: string }
    }
    expect(ownerMeeting.meeting.linkedNodeId).toBe(hiddenNodeId)
    const ownerBookmarks = (await ownerStub.listBookmarks({ workspaceId })) as {
      bookmarks: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    expect(ownerBookmarks.bookmarks.find((b) => b.id === bookmarkId)?.linkedNodeId).toBe(hiddenNodeId)

    // Granted observer: independently qualifies (writer on the bound calendar) — sees it too.
    const { credential: grantedCred } = await devSignIn(grantedObserver)
    const { stub: grantedStub } = await connectToWorkspaceWithSocketAs(workspaceId, grantedCred)
    const grantedMeeting = (await grantedStub.getMeeting({ workspaceId, meetingId })) as {
      meeting: { linkedNodeId?: string }
    }
    expect(grantedMeeting.meeting.linkedNodeId).toBe(hiddenNodeId)
    const grantedMeetingsList = (await grantedStub.listMeetings({ workspaceId })) as {
      meetings: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    expect(grantedMeetingsList.meetings.find((m) => m.id === meetingId)?.linkedNodeId).toBe(hiddenNodeId)
    const grantedBookmarks = (await grantedStub.listBookmarks({ workspaceId })) as {
      bookmarks: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    expect(grantedBookmarks.bookmarks.find((b) => b.id === bookmarkId)?.linkedNodeId).toBe(hiddenNodeId)

    // Denied observer: the fix under test. `linkedNodeId` must be genuinely ABSENT (never `null`,
    // never the raw id) from every one of the three read paths.
    const { credential: deniedCred } = await devSignIn(deniedObserver)
    const { stub: deniedStub } = await connectToWorkspaceWithSocketAs(workspaceId, deniedCred)

    const deniedMeeting = (await deniedStub.getMeeting({ workspaceId, meetingId })) as {
      meeting: { linkedNodeId?: string }
    }
    expect("linkedNodeId" in deniedMeeting.meeting).toBe(false)

    const deniedMeetingsList = (await deniedStub.listMeetings({ workspaceId })) as {
      meetings: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    const deniedMeetingRow = deniedMeetingsList.meetings.find((m) => m.id === meetingId)
    expect(deniedMeetingRow).toBeDefined() // the meeting itself is still visible — only the link is hidden
    expect("linkedNodeId" in (deniedMeetingRow as object)).toBe(false)

    const deniedBookmarks = (await deniedStub.listBookmarks({ workspaceId })) as {
      bookmarks: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    const deniedBookmarkRow = deniedBookmarks.bookmarks.find((b) => b.id === bookmarkId)
    expect(deniedBookmarkRow).toBeDefined()
    expect("linkedNodeId" in (deniedBookmarkRow as object)).toBe(false)
  })
})
