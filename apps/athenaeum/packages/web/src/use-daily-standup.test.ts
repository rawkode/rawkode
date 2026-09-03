/** @vitest-environment happy-dom */

import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  EntityId,
  type LedgerActivityEntry,
  type ListRecentLedgerActivityOutput,
  type ListStandupPublicationsOutput,
  type StandupPublication
} from "@athenaeum/domain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  dailyStandupLanePlan,
  dailyStandupSnapshotKey,
  ledgerActivityFromRpc,
  standupPublicationsFromRpc,
  useDailyStandup,
  type DailyStandupController,
  type DailyStandupLoaders
} from "./use-daily-standup.js"
import { dailyStandupWindow } from "./daily-standup-window.js"

type Deferred<T> = { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: () => void }
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: () => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = () => rejectPromise(new Error("unavailable")) })
  return { promise, resolve, reject }
}

const noteA = EntityId.make("00000000-0000-4000-8000-000000000210")
const noteB = EntityId.make("00000000-0000-4000-8000-000000000211")
const publication = (label: string): StandupPublication => ({ microEmployeeLabel: label } as StandupPublication)
const ledger = (label: string): LedgerActivityEntry => ({ message: label } as LedgerActivityEntry)

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let latest: DailyStandupController | undefined
let visibility: DocumentVisibilityState = "visible"

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

const Probe = (props: Parameters<typeof useDailyStandup>[0]) => {
  latest = useDailyStandup(props)
  return createElement("output", undefined, `${latest.employeeUpdates.status}:${latest.ledger.status}`)
}

const mount = async (props: Parameters<typeof useDailyStandup>[0]) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => { root.render(createElement(Probe, props)); await flush() })
  return { root, update: async (next: Parameters<typeof useDailyStandup>[0]) => act(async () => { root.render(createElement(Probe, next)); await flush() }) }
}

const status = () => latest as DailyStandupController

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  latest = undefined
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility })
})

afterEach(() => {
  vi.useRealTimers()
  for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove() }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("daily standup controller contract", () => {
  it("normalizes production RPC envelopes to the arrays consumed by the two lanes", () => {
    const publications = [publication("standup employee")]
    const entries = [ledger("ledger entry")]
    const publicationEnvelope = { publications } as ListStandupPublicationsOutput
    const ledgerEnvelope = { entries } as ListRecentLedgerActivityOutput

    const normalizedPublications = standupPublicationsFromRpc(publicationEnvelope)
    const normalizedEntries = ledgerActivityFromRpc(ledgerEnvelope)

    expect(Array.isArray(normalizedPublications)).toBe(true)
    expect(Array.isArray(normalizedEntries)).toBe(true)
    expect(normalizedPublications).toBe(publications)
    expect(normalizedEntries).toBe(entries)
    expect(normalizedPublications).not.toHaveProperty("publications")
    expect(normalizedEntries).not.toBe(ledgerEnvelope)
  })

  it("keeps historical publication detail but never plans a ledger request", () => {
    expect(dailyStandupLanePlan(noteA, false)).toEqual({ publications: true, ledger: false })
    expect(dailyStandupLanePlan(noteA, true)).toEqual({ publications: true, ledger: true })
    expect(dailyStandupLanePlan(undefined, true)).toEqual({ publications: false, ledger: false })
  })

  it("makes refresh, civil-day, mode, and note transitions distinct snapshot identities", () => {
    const today = dailyStandupWindow(new Date(2026, 7, 30))
    const tomorrow = dailyStandupWindow(new Date(2026, 7, 31))
    const initial = dailyStandupSnapshotKey(noteA, true, today, 0)
    expect(dailyStandupSnapshotKey(noteA, true, today, 1)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(noteA, true, tomorrow, 0)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(noteA, false, today, 0)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(noteB, true, today, 0)).not.toBe(initial)
  })

  it("renders a settled publication lane while the independent ledger lane is pending or failed", async () => {
    const publications = deferred<readonly StandupPublication[]>()
    const ledgers = deferred<readonly LedgerActivityEntry[]>()
    const loaders: DailyStandupLoaders = { publications: vi.fn(() => publications.promise), ledger: vi.fn(() => ledgers.promise) }
    await mount({ dailyNoteId: noteA, isToday: true, loaders })
    expect(status().employeeUpdates.status).toBe("loading")
    expect(status().ledger.status).toBe("loading")
    await act(async () => { publications.resolve([publication("fresh")]); await flush() })
    expect(status().employeeUpdates).toMatchObject({ status: "success", publications: [{ microEmployeeLabel: "fresh" }] })
    expect(status().ledger.status).toBe("loading")
    await act(async () => { ledgers.reject(); await flush() })
    expect(status().ledger.status).toBe("failure")
  })

  it("lets same-note refresh N plus one beat late N completions, with one shared claim", async () => {
    const p0 = deferred<readonly StandupPublication[]>(), l0 = deferred<readonly LedgerActivityEntry[]>()
    const p1 = deferred<readonly StandupPublication[]>(), l1 = deferred<readonly LedgerActivityEntry[]>()
    const loaders: DailyStandupLoaders = {
      publications: vi.fn().mockReturnValueOnce(p0.promise).mockReturnValueOnce(p1.promise),
      ledger: vi.fn().mockReturnValueOnce(l0.promise).mockReturnValueOnce(l1.promise)
    }
    await mount({ dailyNoteId: noteA, isToday: true, loaders })
    await act(async () => { status().refresh(); status().refresh(); await flush() })
    expect(loaders.publications).toHaveBeenCalledTimes(2)
    expect(loaders.ledger).toHaveBeenCalledTimes(2)
    expect(status().isRefreshing).toBe(true)
    await act(async () => { p1.resolve([publication("N+1")]); l1.resolve([ledger("N+1")]); await flush() })
    expect(status().isRefreshing).toBe(false)
    await act(async () => { p0.resolve([publication("N")]); l0.resolve([ledger("N")]); await flush() })
    expect(status().employeeUpdates).toMatchObject({ status: "success", publications: [{ microEmployeeLabel: "N+1" }] })
    expect(status().ledger).toMatchObject({ status: "success", value: [{ message: "N+1" }] })
  })

  it("never lets an old note or historical response repopulate the selected snapshot", async () => {
    const oldPublications = deferred<readonly StandupPublication[]>(), oldLedger = deferred<readonly LedgerActivityEntry[]>()
    const historicalPublications = deferred<readonly StandupPublication[]>(), currentPublications = deferred<readonly StandupPublication[]>(), currentLedger = deferred<readonly LedgerActivityEntry[]>()
    const loaders: DailyStandupLoaders = {
      publications: vi.fn().mockReturnValueOnce(oldPublications.promise).mockReturnValueOnce(historicalPublications.promise).mockReturnValueOnce(currentPublications.promise),
      ledger: vi.fn().mockReturnValueOnce(oldLedger.promise).mockReturnValueOnce(currentLedger.promise)
    }
    const mounted = await mount({ dailyNoteId: noteA, isToday: true, loaders })
    await mounted.update({ dailyNoteId: noteB, isToday: false, loaders })
    expect(loaders.ledger).toHaveBeenCalledTimes(1)
    expect(status().ledger.status).toBe("idle")
    await mounted.update({ dailyNoteId: noteB, isToday: true, loaders })
    await act(async () => { oldPublications.resolve([publication("old")]); oldLedger.resolve([ledger("old")]); historicalPublications.resolve([publication("history")]); await flush() })
    expect(status().snapshot.dailyNoteId).toBe(noteB)
    expect(status().employeeUpdates.status).toBe("loading")
    await act(async () => { currentPublications.resolve([publication("current")]); currentLedger.resolve([ledger("current")]); await flush() })
    expect(status().employeeUpdates).toMatchObject({ status: "success", publications: [{ microEmployeeLabel: "current" }] })
  })

  it("clears yesterday, re-queries the current local window at midnight and refreshes once on visibility", async () => {
    vi.useFakeTimers()
    let now = new Date(2026, 7, 30, 23, 59, 59)
    const p0 = deferred<readonly StandupPublication[]>(), l0 = deferred<readonly LedgerActivityEntry[]>()
    const p1 = deferred<readonly StandupPublication[]>(), l1 = deferred<readonly LedgerActivityEntry[]>()
    const p2 = deferred<readonly StandupPublication[]>(), l2 = deferred<readonly LedgerActivityEntry[]>()
    const loaders: DailyStandupLoaders = {
      publications: vi.fn().mockReturnValueOnce(p0.promise).mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise),
      ledger: vi.fn().mockReturnValueOnce(l0.promise).mockReturnValueOnce(l1.promise).mockReturnValueOnce(l2.promise)
    }
    await mount({ dailyNoteId: noteA, isToday: true, clock: () => now, loaders })
    await act(async () => { p0.resolve([publication("yesterday")]); l0.resolve([ledger("yesterday")]); await flush() })
    now = new Date(2026, 7, 31, 0, 0, 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); await flush() })
    expect(status().employeeUpdates.status).toBe("loading")
    expect(status().ledger.status).toBe("loading")
    expect(loaders.ledger).toHaveBeenCalledWith(expect.objectContaining(dailyStandupWindow(now)))
    await act(async () => { p1.resolve([publication("today")]); l1.resolve([ledger("today")]); await flush() })
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await flush() })
    expect(loaders.publications).toHaveBeenCalledTimes(3)
    expect(loaders.ledger).toHaveBeenCalledTimes(3)
    await act(async () => { p2.resolve([publication("visible")]); l2.resolve([ledger("visible")]); await flush() })
    expect(status().employeeUpdates).toMatchObject({ status: "success", publications: [{ microEmployeeLabel: "visible" }] })
  })
})
