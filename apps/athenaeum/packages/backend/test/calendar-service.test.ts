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
import { runDurableObjectAlarm } from "cloudflare:test"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CreateLoroPageInput, CreateWorkspaceInput, CreateWorkspaceOutput, CreationIntent, Email, EntityId, HumanUiMutationAttribution, LinkCalendarEventToNodeLedgerCommand, LocalDate, LoroMutationIntentV1, PrepareMeetingInDailyNoteInput, PrepareMeetingInDailyNoteOutput, UnexpectedError } from "@athenaeum/domain"
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
import { calendarConciergeAdmissionTestHook, calendarGatekeeperClientTestHook } from "../src/workspace-durable-object.js"
import { calendarProjectionGatewayTestHook } from "../src/calendar-projection-gateway.js"
import { ledgerExecuteTestHook } from "../src/ledger-service.js"
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
type ScriptedCalendarClientOptions = {
  readonly legacy?: boolean
  /**
   * Explicit provider-code -> fixture mapping for opaque admissions.  This is intentionally not a
   * queue: callback arrival order must not decide which account a connection owns.
   */
  readonly opaqueAccountByCode?: Readonly<Record<string, string>>
  /** Simulates provider success followed by a lost response; status recovery must return receipt. */
  readonly responseLossCodes?: ReadonlySet<string>
}

const installScriptedCalendarClient = (fixtures: GoogleCalendarClientScriptedFixtures, options: ScriptedCalendarClientOptions = {}) => {
  const scripted = makeGoogleCalendarClientScripted(fixtures)
  const client = Effect.runSync(Effect.provide(GoogleCalendarClient, scripted.layer))
  const ledger = Effect.runSync(Effect.provide(ObserverLedger, ObserverLedgerInMemory))
  const opaqueAccountByConnection = new Map<string, string>()
  const opaqueRouteCalls: Array<string> = []
  const legacyRouteCalls: Array<string> = []
  const opaqueExchangeCalls: Array<{ readonly providerConnectionId: string; readonly attemptId: string; readonly code: string }> = []
  const opaqueReceiptByAttempt = new Map<string, { readonly receiptDigest: string; readonly completionFactDigest: string; readonly completedAt: string }>()
  const opaqueAttemptByConnection = new Map<string, string>()
  const resolveOpaqueAccount = (locator: { readonly kind: string; readonly providerConnectionId?: string }, code?: string) => {
    if (locator.kind !== "provider-connection" || locator.providerConnectionId === undefined) {
      return Effect.fail(new UnexpectedError({ message: "scripted opaque route requires a provider connection locator" }))
    }
    const existing = opaqueAccountByConnection.get(locator.providerConnectionId)
    if (existing !== undefined) return Effect.succeed(existing)
    const selected = code === undefined ? undefined : options.opaqueAccountByCode?.[code]
    const fallback = Object.keys(fixtures.accounts)[0]
    const account = selected ?? fallback
    if (account === undefined || scripted.fixtures.accounts[account] === undefined) {
      return Effect.fail(new UnexpectedError({ message: "scripted opaque route has no account fixture" }))
    }
    opaqueAccountByConnection.set(locator.providerConnectionId, account)
    return Effect.succeed(account)
  }
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
      (legacyRouteCalls.push(email),
      client.listCalendars(email).pipe(
        Effect.map((cals) => cals.map((c) => ({ id: c.id, summary: c.summary, ...(c.accessRole ? { accessRole: c.accessRole } : {}) }))),
        Effect.orDie
      )),
    eventsPage: (email, calendarId, query) =>
      (legacyRouteCalls.push(email),
      client.listEvents(email, calendarId, query as never).pipe(
        Effect.map((page) => ({
          items: page.items.map((e) => ({
            id: e.id,
            title: e.title,
            ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
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
      )),
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
      withGatekeeperServices(onDatasetTouched(bindingId, calendarId, (identity) => Effect.succeed(identity.connectionId))),
    ...(options.legacy ? {} : { byConnection: {
      // The scripted provider fixture is intentionally token-keyed. Opaque production routing is
      // exercised by CalendarService; this fixture deterministically selects its sole scripted
      // account without exposing a real provider identity.
      completeOAuth: (locator, attemptId, code) =>
        resolveOpaqueAccount(locator, code).pipe(
          Effect.flatMap(() => {
            const priorAttempt = opaqueAttemptByConnection.get(locator.providerConnectionId)
            if (priorAttempt !== undefined && priorAttempt !== attemptId) {
              return Effect.fail(new UnexpectedError({ message: "scripted opaque route rejected a competing completion" }))
            }
            opaqueAttemptByConnection.set(locator.providerConnectionId, attemptId)
            const receiptKey = `${locator.providerConnectionId}:${attemptId}`
            const receipt = opaqueReceiptByAttempt.get(receiptKey) ?? {
              receiptDigest: `${opaqueReceiptByAttempt.size + 1}`.padStart(64, "a"),
              completionFactDigest: `${opaqueReceiptByAttempt.size + 1}`.padStart(64, "b"),
              completedAt: new Date().toISOString()
            }
            if (!opaqueReceiptByAttempt.has(receiptKey)) opaqueExchangeCalls.push({ providerConnectionId: locator.providerConnectionId, attemptId, code })
            opaqueReceiptByAttempt.set(receiptKey, receipt)
            opaqueRouteCalls.push(locator.providerConnectionId)
            return options.responseLossCodes?.has(code) === true
              ? Effect.fail(new UnexpectedError({ message: "scripted provider response lost after completion" }))
              : Effect.succeed(receipt)
          })
        ),
      getOAuthCompletion: (locator, attemptId) => {
        const receipt = opaqueReceiptByAttempt.get(`${locator.providerConnectionId}:${attemptId}`)
        return receipt === undefined
          ? Effect.fail(new UnexpectedError({ message: "scripted opaque completion is unavailable" }))
          : Effect.succeed(receipt)
      },
      isConnected: () => Effect.succeed({ connected: true }),
      disconnect: (locator) => resolveOpaqueAccount(locator).pipe(Effect.tap(() => opaqueRouteCalls.push(locator.providerConnectionId)), Effect.asVoid),
      listCalendars: (locator) =>
        resolveOpaqueAccount(locator).pipe(
          Effect.tap(() => opaqueRouteCalls.push(locator.providerConnectionId)),
          Effect.flatMap((account) => client.listCalendars(account)),
          Effect.map((cals) => cals.map((c) => ({ id: c.id, summary: c.summary, ...(c.accessRole ? { accessRole: c.accessRole } : {}) }))),
          Effect.mapError((error) => new UnexpectedError({ message: error.message }))
        ),
      eventsPage: (locator, calendarId, query) =>
        resolveOpaqueAccount(locator).pipe(
          Effect.tap(() => opaqueRouteCalls.push(locator.providerConnectionId)),
          Effect.flatMap((account) => client.listEvents(account, calendarId, query as never)),
          Effect.map((page) => ({
            items: page.items.map((e) => ({
              id: e.id,
              title: e.title,
              ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
              start: e.start,
              end: e.end,
              status: e.status,
              ...(e.attendees ? { attendees: e.attendees } : {}),
              ...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {})
            })),
            ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
            ...(page.nextSyncToken ? { nextSyncToken: page.nextSyncToken } : {})
          })),
          Effect.mapError((error) => new UnexpectedError({ message: error.message }))
        ),
      createEvent: () => Effect.die("not used by calendar service tests"),
      updateEvent: () => Effect.die("not used by calendar service tests"),
      deleteEvent: () => Effect.die("not used by calendar service tests"),
      freeBusy: () => Effect.succeed([]),
      mintObserverVerifier: () => Effect.succeed({ token: "opaque-observer" }),
      addObserver: () => Effect.void,
      removeObserver: () => Effect.void,
      notifyCalendarTouched: (locator) => resolveOpaqueAccount(locator).pipe(Effect.tap(() => opaqueRouteCalls.push(locator.providerConnectionId)), Effect.as({ failedObserverIds: [] }))
    } })
  }
  calendarGatekeeperClientTestHook.api = api
  return Object.assign(scripted, { opaqueRouteCalls, legacyRouteCalls, opaqueExchangeCalls, opaqueAccountByConnection })
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
  calendarConciergeAdmissionTestHook.beforeAdmission = undefined
})

const drainWorkforceRuns = async (workspaceId: EntityId): Promise<void> => {
  const native = workspaceDurableObjectStub(workspaceId)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runs = await native.debugGetWorkforceRuntimeRuns()
    if (runs.length === 0 || runs.every((run) => ["completed", "blocked", "failed", "skipped"].includes(run.state))) return
    await runDurableObjectAlarm(native)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const ACCOUNT_EMAIL = "owner@example.test"
const CALENDAR_ID = "team@group.calendar.google.com"

describe("CalendarService — connect/callback/disconnect", () => {
  it("connectGoogleCalendar returns a real authorization URL, and the callback finalizes a binding", async () => {
    installScriptedCalendarClient({ accounts: { [ACCOUNT_EMAIL]: { calendars: {}, freeBusyReadableCalendarIds: [], events: {} } } })

    const { credential, email } = await devSignIn(ACCOUNT_EMAIL)
    const workspaceId = freshWorkspaceId()
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const beforeCallback = (await stub.listGatekeeperBindings({ workspaceId })) as { bindings: ReadonlyArray<unknown> }
    expect(beforeCallback.bindings).toEqual([])

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

    const catalog = (await stub.listGatekeeperBindings({ workspaceId })) as {
      bindings: ReadonlyArray<Record<string, unknown>>
    }
    expect(catalog.bindings).toHaveLength(1)
    expect(catalog.bindings[0]).toEqual({
      id: callbackResult.binding.id,
      workspaceId,
      gatekeeperKind: "google-calendar",
      mode: "selected",
      createdAt: expect.any(String)
    })
    expect(Object.keys(catalog.bindings[0]!).sort()).toEqual([
      "createdAt",
      "gatekeeperKind",
      "id",
      "mode",
      "workspaceId"
    ])
    expect(catalog.bindings[0]).not.toHaveProperty("boundBy")
    expect(catalog.bindings[0]).not.toHaveProperty("config")

    const disconnectResult = (await stub.disconnectGoogleCalendar({
      workspaceId,
      bindingId: callbackResult.binding.id
    })) as { disconnected: boolean }
    expect(disconnectResult.disconnected).toBe(true)

    const afterDisconnect = (await stub.listGatekeeperBindings({ workspaceId })) as { bindings: ReadonlyArray<unknown> }
    expect(afterDisconnect.bindings).toEqual([])

    const otherWorkspace = freshWorkspaceId()
    const { stub: otherStub } = await connectToWorkspaceWithSocketAs(otherWorkspace, credential)
    const otherWorkspaceCatalog = (await otherStub.listGatekeeperBindings({ workspaceId: otherWorkspace })) as {
      bindings: ReadonlyArray<unknown>
    }
    expect(otherWorkspaceCatalog.bindings).toEqual([])
  })

  it("routes each opaque binding to its admitted account and never uses the legacy email adapter", async () => {
    const secondAccount = "second@example.test"
    const scripted = installScriptedCalendarClient(
      {
        accounts: {
          [ACCOUNT_EMAIL]: { calendars: { [CALENDAR_ID]: "owner" }, freeBusyReadableCalendarIds: [], events: { [CALENDAR_ID]: [] } },
          [secondAccount]: { calendars: { [CALENDAR_ID]: "owner" }, freeBusyReadableCalendarIds: [], events: { [CALENDAR_ID]: [] } }
        }
      },
      { opaqueAccountByCode: { "first-code": ACCOUNT_EMAIL, "second-code": secondAccount } }
    )

    const firstWorkspace = freshWorkspaceId()
    const { credential: firstCredential } = await devSignIn(ACCOUNT_EMAIL)
    const { stub: firstStub } = await connectToWorkspaceWithSocketAs(firstWorkspace, firstCredential)
    const firstConnect = (await firstStub.connectGoogleCalendar({ workspaceId: firstWorkspace })) as { state: string }
    const firstCallback = (await firstStub.googleCalendarOAuthCallback({
      workspaceId: firstWorkspace,
      code: "first-code",
      state: firstConnect.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string } }
    await firstStub.syncGoogleCalendar({ workspaceId: firstWorkspace, bindingId: firstCallback.binding.id })

    const secondWorkspace = freshWorkspaceId()
    const { credential: secondCredential } = await devSignIn(secondAccount)
    const { stub: secondStub } = await connectToWorkspaceWithSocketAs(secondWorkspace, secondCredential)
    const secondConnect = (await secondStub.connectGoogleCalendar({ workspaceId: secondWorkspace })) as { state: string }
    const secondCallback = (await secondStub.googleCalendarOAuthCallback({
      workspaceId: secondWorkspace,
      code: "second-code",
      state: secondConnect.state,
      calendarId: CALENDAR_ID,
      mode: "selected"
    })) as { binding: { id: string } }
    await secondStub.syncGoogleCalendar({ workspaceId: secondWorkspace, bindingId: secondCallback.binding.id })

    const providerReads = scripted.calls
      .filter((call) => call.method === "listEvents")
      .map((call) => call.args[0])
    expect(providerReads).toEqual([ACCOUNT_EMAIL, secondAccount])
    expect(scripted.legacyRouteCalls).toEqual([])
    expect(scripted.opaqueRouteCalls).toHaveLength(4)
    expect(new Set(scripted.opaqueRouteCalls).size).toBe(2)
  })

  it("keeps two opaque accounts for one principal isolated across reverse callbacks, response recovery, sync, replay, and disconnect", async () => {
    const accountA = "google-a@example.test"
    const accountB = "google-b@example.test"
    const calendarA = "calendar-a@group.calendar.google.test"
    const calendarB = "calendar-b@group.calendar.google.test"
    const codeA = "code-account-a"
    const codeB = "code-account-b-response-lost"
    const scripted = installScriptedCalendarClient(
      {
        accounts: {
          [accountA]: {
            calendars: { [calendarA]: "owner" },
            freeBusyReadableCalendarIds: [],
            events: {
              [calendarA]: [
                new ScriptedCalendarEvent({
                  id: "event-account-a",
                  title: "Account A only",
                  start: { kind: "dateTime", dateTime: new Date().toISOString() },
                  end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
                  status: "confirmed"
                })
              ]
            }
          },
          [accountB]: {
            calendars: { [calendarB]: "owner" },
            freeBusyReadableCalendarIds: [],
            events: {
              [calendarB]: [
                new ScriptedCalendarEvent({
                  id: "event-account-b",
                  title: "Account B only",
                  start: { kind: "dateTime", dateTime: new Date().toISOString() },
                  end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
                  status: "confirmed"
                })
              ]
            }
          }
        }
      },
      {
        opaqueAccountByCode: { [codeA]: accountA, [codeB]: accountB },
        responseLossCodes: new Set([codeB])
      }
    )
    const workspaceId = freshWorkspaceId()
    const { credential } = await devSignIn(ACCOUNT_EMAIL)
    const { stub } = await connectToWorkspaceWithSocketAs(workspaceId, credential)

    const pendingA = (await stub.connectGoogleCalendar({ workspaceId })) as { state: string }
    const pendingB = (await stub.connectGoogleCalendar({ workspaceId })) as { state: string }

    // B completes first and deliberately loses its exchange response. CalendarService must recover
    // exactly B's durable receipt instead of retrying A/B by queue order or another provider call.
    const bindingB = (await stub.googleCalendarOAuthCallback({
      workspaceId,
      code: codeB,
      state: pendingB.state,
      calendarId: calendarB,
      mode: "selected"
    })) as { binding: { id: string } }
    const bindingA = (await stub.googleCalendarOAuthCallback({
      workspaceId,
      code: codeA,
      state: pendingA.state,
      calendarId: calendarA,
      mode: "selected"
    })) as { binding: { id: string } }

    const replayB = (await stub.googleCalendarOAuthCallback({
      workspaceId,
      code: codeB,
      state: pendingB.state,
      calendarId: calendarB,
      mode: "selected"
    })) as { binding: { id: string } }
    expect(replayB.binding.id).toBe(bindingB.binding.id)
    expect(scripted.opaqueExchangeCalls.map((call) => call.code).sort()).toEqual([codeA, codeB].sort())
    expect(new Set(scripted.opaqueExchangeCalls.map((call) => call.providerConnectionId)).size).toBe(2)

    await stub.syncGoogleCalendar({ workspaceId, bindingId: bindingA.binding.id })
    await stub.syncGoogleCalendar({ workspaceId, bindingId: bindingB.binding.id })
    const events = (await stub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<{ title: string }> }
    expect(events.events.map((event) => event.title).sort()).toEqual(["Account A only", "Account B only"])

    const connectionA = scripted.opaqueExchangeCalls.find((call) => call.code === codeA)!.providerConnectionId
    const connectionB = scripted.opaqueExchangeCalls.find((call) => call.code === codeB)!.providerConnectionId
    expect(scripted.opaqueAccountByConnection.get(connectionA)).toBe(accountA)
    expect(scripted.opaqueAccountByConnection.get(connectionB)).toBe(accountB)
    expect(scripted.legacyRouteCalls).toEqual([])

    await stub.disconnectGoogleCalendar({ workspaceId, bindingId: bindingA.binding.id })
    const bCallsBeforeResync = scripted.opaqueRouteCalls.filter((connectionId) => connectionId === connectionB).length
    const aCallsBeforeResync = scripted.opaqueRouteCalls.filter((connectionId) => connectionId === connectionA).length
    await stub.syncGoogleCalendar({ workspaceId, bindingId: bindingB.binding.id })
    expect(scripted.opaqueRouteCalls.filter((connectionId) => connectionId === connectionB).length).toBeGreaterThan(bCallsBeforeResync)
    expect(scripted.opaqueRouteCalls.filter((connectionId) => connectionId === connectionA).length).toBe(aCallsBeforeResync)
    expect(scripted.legacyRouteCalls).toEqual([])
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
    installScriptedCalendarClient(buildFixtures(), { legacy: true })
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
    const projectionCommand = (await workspaceDurableObjectStub(workspaceId).debugListLedgerCommandIdentities()).find((command) => command.type === "calendarProjection")
    expect(projectionCommand).toBeDefined()
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCommand(projectionCommand!.requestIdentity)).toMatchObject({
      principal: ACCOUNT_EMAIL,
      payload: { attribution: { kind: "humanUi", surface: "web-calendar" } }
    })
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCustody(projectionCommand!.requestIdentity)).toMatchObject({
      actorKind: "user",
      targetKind: "calendarEvent"
    })

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
    await drainWorkforceRuns(workspaceId)

    const nodesResult = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ id: string; title: string }> }
    // Exactly two Person nodes — alice (attendee on all 3 events) and bob (attendee on 2 of 3) —
    // never duplicated despite appearing on multiple events/occurrences within one sync pass.
    const alicelike = nodesResult.nodes.filter((n) => n.title === "Alice")
    const boblike = nodesResult.nodes.filter((n) => n.title === "Bob")
    expect(alicelike).toHaveLength(1)
    expect(boblike).toHaveLength(1)
  })

  it("drains calendar concierge runs through the durable alarm and publishes employee standups", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const localDate = new Date().toISOString().slice(0, 10)
    const dailyNoteId = Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-0000${localDate.replaceAll("-", "")}`)
    const readPublications = async () => (await stub.listStandupPublications({ workspaceId, dailyNoteId })) as {
      publications: ReadonlyArray<{
        resultKind?: string
        companionStatus: string
        microEmployeeLabel: string
        jobLabel: string
        originalText: string
      }>
    }
    // The sync transaction enqueues one run per first-seen attendee observation and rearms the
    // DO alarm. `runDurableObjectAlarm` is Miniflare's test-only trigger for that reserved
    // lifecycle method; it exercises the same durable wakeup path production uses without trying
    // to call `alarm()` over RPC.
    const native = workspaceDurableObjectStub(workspaceId)
    const queuedRuns = await native.debugGetWorkforceRuntimeRuns()
    expect(queuedRuns).toHaveLength(3)
    expect(queuedRuns.every((run) => run.workflowId === "calendar-relationship-concierge" && run.state === "queued")).toBe(true)
    let result = await readPublications()
    for (let attempt = 0; attempt < 8 && result.publications.length < 2; attempt += 1) {
      const ran = await runDurableObjectAlarm(workspaceDurableObjectStub(workspaceId))
      if (!ran) await new Promise((resolve) => setTimeout(resolve, 5))
      result = await readPublications()
    }
    await drainWorkforceRuns(workspaceId)
    result = await readPublications()
    const runtimeRuns = await native.debugGetWorkforceRuntimeRuns()
    expect(runtimeRuns).toMatchObject([
      { workflowId: "calendar-relationship-concierge" },
      { workflowId: "calendar-relationship-concierge" },
      { workflowId: "calendar-relationship-concierge" }
    ])
    expect(runtimeRuns.filter((run) => run.state === "completed")).toHaveLength(3)
    expect(runtimeRuns.filter((run) => run.state === "retryable" || run.state === "failed")).toHaveLength(0)

    // The current fixture has two attendees on today's standalone event. The recurring event is
    // outside today's civil date, so exactly two completed employee publications belong here.
    expect(result.publications).toHaveLength(2)
    expect(result.publications.every((publication) => publication.resultKind === "completed")).toBe(true)
    expect(result.publications.every((publication) => publication.companionStatus === "verified-original")).toBe(true)
    expect(result.publications.every((publication) => publication.microEmployeeLabel === "Calendar relationship concierge")).toBe(true)
    expect(result.publications.every((publication) => publication.jobLabel === "Enrich calendar attendees")).toBe(true)
    const summaries = result.publications.map((publication) => publication.originalText)
    const validSummaries = new Set([
      "Calendar relationship concierge reused the existing Person for Alice.",
      "Calendar relationship concierge reused the existing Person for Bob.",
      "Linked calendar attendee Alice to a Person and recorded the relationship.",
      "Linked calendar attendee Bob to a Person and recorded the relationship."
    ])
    // The recurring fixture is drained in the same alarm loop. Depending on which overlapping
    // observation wins the first claim, the standalone event may either create or reuse each
    // deterministic Person; both are valid ledgered outcomes.
    expect(summaries.some((summary) => summary.includes("Alice"))).toBe(true)
    expect(summaries.some((summary) => summary.includes("Bob"))).toBe(true)
    expect(summaries.every((summary) => validSummaries.has(summary))).toBe(true)
  })

  it("rejects an out-of-order provider snapshot after a newer event revision is committed", async () => {
    const fixtures: GoogleCalendarClientScriptedFixtures = {
      accounts: {
        [ACCOUNT_EMAIL]: {
          calendars: { [CALENDAR_ID]: "owner" },
          freeBusyReadableCalendarIds: [],
          events: {
            [CALENDAR_ID]: [new ScriptedCalendarEvent({
              id: "ordered-event",
              title: "Original title",
              start: { kind: "dateTime", dateTime: "2026-08-30T12:00:00.000Z" },
              end: { kind: "dateTime", dateTime: "2026-08-30T12:30:00.000Z" },
              status: "confirmed",
              updatedAt: "2026-08-30T10:00:00.000Z"
            })]
          }
        }
      }
    }
    const scripted = installScriptedCalendarClient(fixtures)
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

    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    scripted.fixtures.accounts[ACCOUNT_EMAIL] = {
      ...scripted.fixtures.accounts[ACCOUNT_EMAIL]!,
      events: {
        ...scripted.fixtures.accounts[ACCOUNT_EMAIL]!.events,
        [CALENDAR_ID]: [new ScriptedCalendarEvent({
          id: "ordered-event",
          title: "Newer title",
          start: { kind: "dateTime", dateTime: "2026-08-30T12:00:00.000Z" },
          end: { kind: "dateTime", dateTime: "2026-08-30T12:30:00.000Z" },
          status: "confirmed",
          updatedAt: "2026-08-30T11:00:00.000Z"
        })]
      }
    }
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    scripted.fixtures.accounts[ACCOUNT_EMAIL] = {
      ...scripted.fixtures.accounts[ACCOUNT_EMAIL]!,
      events: {
        ...scripted.fixtures.accounts[ACCOUNT_EMAIL]!.events,
        [CALENDAR_ID]: [new ScriptedCalendarEvent({
          id: "ordered-event",
          title: "Older title",
          start: { kind: "dateTime", dateTime: "2026-08-30T12:00:00.000Z" },
          end: { kind: "dateTime", dateTime: "2026-08-30T12:30:00.000Z" },
          status: "cancelled",
          updatedAt: "2026-08-30T09:00:00.000Z"
        })]
      }
    }
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const listed = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ providerEventId: string; title: string; status: string }>
    }
    expect(listed.events.find((event) => event.providerEventId === "ordered-event")).toMatchObject({
      title: "Newer title",
      status: "confirmed"
    })
  })

  it("does not import attendees from a first-seen cancelled event", async () => {
    installScriptedCalendarClient({
      accounts: {
        [ACCOUNT_EMAIL]: {
          calendars: { [CALENDAR_ID]: "owner" },
          freeBusyReadableCalendarIds: [],
          events: {
            [CALENDAR_ID]: [new ScriptedCalendarEvent({
              id: "historical-cancelled-event",
              title: "Historical cancellation",
              start: { kind: "dateTime", dateTime: "2026-08-30T14:00:00.000Z" },
              end: { kind: "dateTime", dateTime: "2026-08-30T14:30:00.000Z" },
              status: "cancelled",
              attendees: [new ScriptedCalendarAttendee({ email: "ghost@example.test", displayName: "Ghost" })]
            })]
          }
        }
      }
    })
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

    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    const events = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ providerEventId: string; status: string }>
    }
    expect(events.events).toHaveLength(1)
    expect(events.events[0]).toMatchObject({ providerEventId: "historical-cancelled-event", status: "cancelled" })
    const nodes = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(nodes.nodes.some((node) => node.title === "Ghost")).toBe(false)
    const native = workspaceDurableObjectStub(workspaceId)
    expect(await native.debugGetCalendarStorageCounts()).toMatchObject({
      calendarDerivedNodes: 0,
      calendarAttendeeObservations: 0
    })
    expect(await native.debugGetWorkforceRuntimeRuns()).toEqual([])
  })

  it("skips an attendee job queued before its event is cancelled", async () => {
    const attendeeEmail = "cancelled-before-drain@example.test"
    const confirmed = new ScriptedCalendarEvent({
      id: "cancel-before-drain",
      title: "Cancellation race",
      start: { kind: "dateTime", dateTime: new Date().toISOString() },
      end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
      status: "confirmed",
      updatedAt: "2026-08-30T10:00:00.000Z",
      attendees: [new ScriptedCalendarAttendee({ email: attendeeEmail, displayName: "Race attendee" })]
    })
    const cancelled = new ScriptedCalendarEvent({
      id: "cancel-before-drain",
      title: "Cancellation race",
      start: confirmed.start,
      end: confirmed.end,
      status: "cancelled",
      updatedAt: "2026-08-30T11:00:00.000Z",
      attendees: [new ScriptedCalendarAttendee({ email: attendeeEmail, displayName: "Race attendee" })]
    })
    const scripted = installScriptedCalendarClient({
      accounts: {
        [ACCOUNT_EMAIL]: {
          calendars: { [CALENDAR_ID]: "owner" },
          freeBusyReadableCalendarIds: [],
          events: { [CALENDAR_ID]: [confirmed] }
        }
      }
    })
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

    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    const beforeCancel = await workspaceDurableObjectStub(workspaceId).debugGetWorkforceRuntimeRuns()
    expect(beforeCancel).toHaveLength(1)
    expect(beforeCancel[0]?.state).toBe("queued")

    scripted.fixtures.accounts[ACCOUNT_EMAIL] = {
      ...scripted.fixtures.accounts[ACCOUNT_EMAIL]!,
      events: { [CALENDAR_ID]: [cancelled] }
    }
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    await drainWorkforceRuns(workspaceId)

    const runs = await workspaceDurableObjectStub(workspaceId).debugGetWorkforceRuntimeRuns()
    expect(runs).toMatchObject([{ state: "skipped" }])
    expect(runs.some((run) => run.state === "completed")).toBe(false)
    const localDate = new Date().toISOString().slice(0, 10)
    const dailyNoteId = Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-0000${localDate.replaceAll("-", "")}`)
    const publications = (await stub.listStandupPublications({ workspaceId, dailyNoteId })) as { publications: ReadonlyArray<unknown> }
    expect(publications.publications).toEqual([])
    const nodes = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(nodes.nodes.some((node) => node.title === "Race attendee" || node.title === "Calendar attendee")).toBe(false)
  })

  it("uses a neutral standup and node label when an attendee has no display name", async () => {
    const attendeeEmail = "private-address@example.test"
    const scripted = installScriptedCalendarClient({
      accounts: {
        [ACCOUNT_EMAIL]: {
          calendars: { [CALENDAR_ID]: "owner" },
          freeBusyReadableCalendarIds: [],
          events: {
            [CALENDAR_ID]: [new ScriptedCalendarEvent({
              id: "no-display-name",
              title: "Private attendee event",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed",
              attendees: [new ScriptedCalendarAttendee({ email: attendeeEmail })]
            })]
          }
        }
      }
    })
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
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    await drainWorkforceRuns(workspaceId)

    const localDate = new Date().toISOString().slice(0, 10)
    const dailyNoteId = Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-0000${localDate.replaceAll("-", "")}`)
    const publications = (await stub.listStandupPublications({ workspaceId, dailyNoteId })) as {
      publications: ReadonlyArray<{ originalText: string }>
    }
    expect(publications.publications).toHaveLength(1)
    expect(publications.publications[0]?.originalText).toBe("Linked calendar attendee a newly observed attendee to a Person and recorded the relationship.")
    expect(JSON.stringify(publications.publications)).not.toContain(attendeeEmail)
    const nodes = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(nodes.nodes.filter((node) => node.title === "Calendar attendee")).toHaveLength(1)
    expect(JSON.stringify(nodes.nodes)).not.toContain(attendeeEmail)
  })

  it("cannot admit a staged standup after another worker reclaims the lease", async () => {
    const attendeeEmail = "lease-race@example.test"
    installScriptedCalendarClient({
      accounts: {
        [ACCOUNT_EMAIL]: {
          calendars: { [CALENDAR_ID]: "owner" },
          freeBusyReadableCalendarIds: [],
          events: {
            [CALENDAR_ID]: [new ScriptedCalendarEvent({
              id: "lease-race-event",
              title: "Lease race",
              start: { kind: "dateTime", dateTime: new Date().toISOString() },
              end: { kind: "dateTime", dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
              status: "confirmed",
              attendees: [new ScriptedCalendarAttendee({ email: attendeeEmail, displayName: "Lease race attendee" })]
            })]
          }
        }
      }
    })
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
    await stub.syncGoogleCalendar({ workspaceId, bindingId })

    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      debugGetWorkforceRuntimeRuns(): Promise<ReadonlyArray<{ id: string; state: string; leaseExpiresAt: string | null; attempts: number }>>
    }
    let reclaimed: { id: string; state: string; leaseExpiresAt: string | null; attempts: number } | null = null
    calendarConciergeAdmissionTestHook.beforeAdmission = async ({ leaseExpiresAt, reclaimClaim }) => {
      reclaimed = reclaimClaim(new Date(Date.parse(leaseExpiresAt) + 1), 60_000)
    }

    let alarmRan = false
    for (let attempt = 0; attempt < 8 && !alarmRan; attempt += 1) {
      alarmRan = await runDurableObjectAlarm(workspaceDurableObjectStub(workspaceId))
      if (!alarmRan) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(alarmRan).toBe(true)
    expect(reclaimed).toMatchObject({ state: "claimed", attempts: 2 })
    const runs = await native.debugGetWorkforceRuntimeRuns()
    expect(runs).toMatchObject([{ state: "claimed", attempts: 2 }])

    const localDate = new Date().toISOString().slice(0, 10)
    const dailyNoteId = Schema.decodeUnknownSync(EntityId)(`00000000-0000-4000-8000-0000${localDate.replaceAll("-", "")}`)
    const publications = (await stub.listStandupPublications({ workspaceId, dailyNoteId })) as { publications: ReadonlyArray<unknown> }
    expect(publications.publications).toEqual([])
  })

  it("reclaims a claimed calendar run when its lease expires", async () => {
    const workspaceId = freshWorkspaceId()
    const native = workspaceDurableObjectStub(workspaceId) as unknown as {
      debugEnqueueWorkforceRun(input: { occurrenceId: string; dueAt: string }): Promise<{ id: string; state: string; nextAttemptAt: string }>
      debugClaimWorkforceRun(input: { now: string; leaseMs: number }): Promise<{ attempts: number; state: string; leaseExpiresAt: string | null } | null>
      debugGetWorkforceNextDueAt(): Promise<string | null>
    }
    const queued = await native.debugEnqueueWorkforceRun({ occurrenceId: "lease-recovery", dueAt: "2099-01-01T00:00:00.000Z" })
    expect(queued.state).toBe("queued")
    const claim = await native.debugClaimWorkforceRun({
      now: "2099-01-01T00:00:00.000Z",
      leaseMs: 1_000
    })
    expect(claim).toMatchObject({ state: "claimed", attempts: 1, leaseExpiresAt: expect.any(String) })
    expect(await native.debugGetWorkforceNextDueAt()).toBe(claim!.leaseExpiresAt)

    const reclaimed = await native.debugClaimWorkforceRun({
      now: new Date(Date.parse(claim!.leaseExpiresAt!) + 1).toISOString(),
      leaseMs: 1_000
    })
    expect(reclaimed).toMatchObject({ state: "claimed", attempts: 2, leaseExpiresAt: expect.any(String) })
  })

  it("rolls back the entire provider projection when the ledger boundary fails", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    const native = workspaceDurableObjectStub(workspaceId)
    const beforeCalendar = await native.debugGetCalendarStorageCounts()
    const beforeLedger = await native.debugGetLedgerArtifactCounts()
    calendarProjectionGatewayTestHook.afterProjectionBeforeLedger = () => {
      throw new Error("calendar projection ledger failpoint")
    }
    try {
      const error = await rejectionToDomainError(stub.syncGoogleCalendar({ workspaceId, bindingId }))
      expect(error._tag).toBe("UnexpectedError")
    } finally {
      calendarProjectionGatewayTestHook.afterProjectionBeforeLedger = undefined
    }
    expect(await native.debugGetCalendarStorageCounts()).toEqual(beforeCalendar)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(beforeLedger)
    expect(await native.debugGetWorkforceRuntimeRuns()).toEqual([])
    const nodes = (await stub.listNodes({ workspaceId })) as { nodes: ReadonlyArray<{ title: string }> }
    expect(nodes.nodes.filter((node) => node.title === "Alice" || node.title === "Bob")).toHaveLength(0)
    const events = (await stub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(events.events).toEqual([])
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
      nodeId,
      requestId: "calendar-service-preserved-link",
      commitMessage: "Link the standup to my annotation.",
      attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
    })) as { calendarEvent: { linkedNodeId?: string } }
    expect(linkResult.calendarEvent.linkedNodeId).toBe(nodeId)
    const replay = (await stub.linkCalendarEventToNode({
      workspaceId, calendarEventId: standup.id, nodeId, requestId: "calendar-service-preserved-link",
      commitMessage: "Link the standup to my annotation.",
      attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
    })) as { calendarEvent: { linkedNodeId?: string } }
    expect(replay).toEqual(linkResult)
    const native = workspaceDurableObjectStub(workspaceId)
    const requestIdentity = "link-calendar-event-to-node:calendar-service-preserved-link"
    expect(Schema.decodeUnknownSync(LinkCalendarEventToNodeLedgerCommand)(await native.debugGetLedgerCommand(requestIdentity))).toMatchObject({
      type: "linkCalendarEventToNode", payload: {
        calendarEventId: standup.id, nodeId, commitMessage: "Link the standup to my annotation.", attribution: { kind: "humanUi", surface: "macos" }
      }
    })
    const storedReceipt = await native.debugGetLedgerReceipt(requestIdentity)
    expect(storedReceipt).toMatchObject({
      output: {
        version: "athenaeum.workspace-ledger-receipt.v2",
        type: "linkCalendarEventToNode",
        output: { calendarEventId: standup.id, nodeId }
      }
    })
    expect(storedReceipt).toEqual({
      fingerprint: expect.any(String),
      output: {
        version: "athenaeum.workspace-ledger-receipt.v2",
        type: "linkCalendarEventToNode",
        output: { calendarEventId: standup.id, nodeId }
      }
    })
    // The replay witness is intentionally compact: provider title, attendee addresses, recurrence
    // metadata, and sync timestamps never enter the receipt or either delivery side effect.
    expect(JSON.stringify(storedReceipt)).not.toContain("Daily Standup")
    expect(JSON.stringify(storedReceipt)).not.toContain(ACCOUNT_EMAIL)
    expect(await native.debugGetLedgerEvent(requestIdentity)).toEqual({ kind: "link-calendar-event-to-node", payload: { calendarEventId: standup.id, nodeId } })
    expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toEqual({ kind: "link-calendar-event-to-node", payload: { calendarEventId: standup.id, nodeId } })

    const conflict = await rejectionToDomainError(stub.linkCalendarEventToNode({
      workspaceId, calendarEventId: standup.id, nodeId, requestId: "calendar-service-preserved-link",
      commitMessage: "A changed reason.", attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
    }))
    expect(conflict._tag).toBe("ValidationError")

    // Re-sync (same fixtures) — every provider row already exists, so `sync` replays each
    // calendar-projection receipt rather than appending a second command/event/outbox artifact.
    // This goes through the real scripted provider -> CalendarService -> Workspace DO gateway
    // path; it is intentionally not a unit seam around the gateway itself.
    const drainQueuedRuns = async (): Promise<void> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (!await runDurableObjectAlarm(workspaceDurableObjectStub(workspaceId))) return
      }
    }
    await drainQueuedRuns()
    const artifactsBeforeResync = await native.debugGetLedgerArtifactCounts()
    const commandsBeforeResync = await native.debugListLedgerCommandIdentities()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    await drainQueuedRuns()
    const commandsAfterResync = await native.debugListLedgerCommandIdentities()
    expect(commandsAfterResync).toEqual(commandsBeforeResync)
    expect(await native.debugGetLedgerArtifactCounts()).toEqual(artifactsBeforeResync)

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

  it("rolls back a calendar link and every ledger artifact when command persistence fails", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    const events = (await stub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<{ id: string; providerEventId: string; linkedNodeId?: string }> }
    const standup = events.events.find((event) => event.providerEventId === "standup-1")!
    const nodeId = freshNodeId()
    await stub.createNode({ workspaceId, id: nodeId, title: "Rollback annotation" })
    const requestIdentity = "link-calendar-event-to-node:calendar-link-rollback"
    const native = workspaceDurableObjectStub(workspaceId)
    ledgerExecuteTestHook.afterMutation = () => { throw new Error("calendar link ledger failpoint") }
    try {
      expect((await rejectionToDomainError(stub.linkCalendarEventToNode({
        workspaceId, calendarEventId: standup.id, nodeId, requestId: "calendar-link-rollback",
        commitMessage: "Link this event for rollback testing.",
        attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
      })))._tag).toBe("UnexpectedError")
    } finally {
      ledgerExecuteTestHook.afterMutation = undefined
    }
    const after = (await stub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<{ id: string; linkedNodeId?: string }> }
    expect(after.events.find((event) => event.id === standup.id)?.linkedNodeId).toBeUndefined()
    expect(await native.debugGetLedgerCommand(requestIdentity)).toBeNull()
    expect(await native.debugGetLedgerReceipt(requestIdentity)).toBeNull()
    expect(await native.debugGetLedgerEvent(requestIdentity)).toBeNull()
    expect(await native.debugGetLedgerOutboxIntent(requestIdentity)).toBeNull()
  })

  it("rejects an anonymous calendar link even on an otherwise ungoverned workspace", async () => {
    const { workspaceId, bindingId, stub } = await setUpConnectedWorkspace()
    await stub.syncGoogleCalendar({ workspaceId, bindingId })
    const events = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ id: string; providerEventId: string; linkedNodeId?: string }>
    }
    const standup = events.events.find((event) => event.providerEventId === "standup-1")!
    const nodeId = freshNodeId()
    await stub.createNode({ workspaceId, id: nodeId, title: "Authenticated-only annotation" })

    // `freshWorkspaceId()` creates an ungoverned workspace, so the ordinary role gate alone would
    // allow an anonymous caller. The explicit principal check at the ledger boundary must still
    // reject the mutation before visibility lookup or any write occurs.
    const anonymous = await connectToWorkspace(workspaceId)
    const error = await rejectionToDomainError(anonymous.linkCalendarEventToNode({
      workspaceId,
      calendarEventId: standup.id,
      nodeId,
      requestId: "anonymous-calendar-link",
      commitMessage: "Attempt an anonymous calendar link.",
      attribution: { version: "athenaeum.mutation-attribution.v1", kind: "humanUi", surface: "macos" }
    }))
    expect(error._tag).toBe("Unauthorized")

    const after = (await stub.listCalendarEvents({ workspaceId })) as {
      events: ReadonlyArray<{ id: string; linkedNodeId?: string }>
    }
    expect(after.events.find((event) => event.id === standup.id)?.linkedNodeId).toBeUndefined()
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
    expect(await workspaceDurableObjectStub(workspaceId).debugGetLedgerCustody(identity)).toMatchObject({
      type: "prepareMeetingInDailyNote", actorKind: "user", actorLabel: "You", targetKind: "node", targetId: dailyNoteId
    })

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
    installScriptedCalendarClient(buildFixtures(), { legacy: true })
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
    // Opaque bindings require an exact private observer connection; an email alone cannot
    // select one of a collaborator's possible Google grants and must not fall back to email.
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

  it("keeps retained calendar projections owner-only after the binding is disconnected", async () => {
    installScriptedCalendarClient(buildFixtures(), { legacy: true })
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
    await ownerStub.addCollaborator({ workspaceId, profileId: grantedObserver, role: "use" })

    const { credential: observerCred } = await devSignIn(grantedObserver)
    const { stub: observerStub } = await connectToWorkspaceWithSocketAs(workspaceId, observerCred)
    const beforeDisconnect = (await observerStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(beforeDisconnect.events).toHaveLength(1)

    expect((await ownerStub.disconnectGoogleCalendar({ workspaceId, bindingId })) as { disconnected: boolean }).toEqual({ disconnected: true })

    // Disconnect removes provider credentials, but retained rows are still private projection
    // data. The owner can audit them; a previously-qualified collaborator cannot use the deleted
    // binding's old observer grant as a durable capability.
    const ownerRetained = (await ownerStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(ownerRetained.events).toHaveLength(1)
    const observerAfterDisconnect = (await observerStub.listCalendarEvents({ workspaceId })) as { events: ReadonlyArray<unknown> }
    expect(observerAfterDisconnect.events).toEqual([])
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
    const handle = installScriptedCalendarClient(buildFixtures(), { legacy: true })
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
    const bindingsError = await rejectionToDomainError(anon.listGatekeeperBindings({ workspaceId }))
    expect(bindingsError._tag).toBe("Unauthorized")
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

  it("keeps the binding catalog behind the build role", async () => {
    const ownerEmail = "binding-role-owner@example.test"
    const readerEmail = "binding-role-reader@example.test"
    const { credential: ownerCredential } = await devSignIn(ownerEmail)
    const workspaceId = await createGovernedWorkspace(ownerEmail)
    const { stub: ownerStub } = await connectToWorkspaceWithSocketAs(workspaceId, ownerCredential)

    const ownerCatalog = (await ownerStub.listGatekeeperBindings({ workspaceId })) as { bindings: ReadonlyArray<unknown> }
    expect(ownerCatalog.bindings).toEqual([])

    await ownerStub.addCollaborator({ workspaceId, profileId: readerEmail, role: "use" })
    const { credential: readerCredential } = await devSignIn(readerEmail)
    const { stub: readerStub } = await connectToWorkspaceWithSocketAs(workspaceId, readerCredential)
    const readerError = await rejectionToDomainError(readerStub.listGatekeeperBindings({ workspaceId }))
    expect(readerError._tag).toBe("Unauthorized")
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
    installScriptedCalendarClient(buildFixtures(), { legacy: true })
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
    await drainWorkforceRuns(workspaceId)

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
