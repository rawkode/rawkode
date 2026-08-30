import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import {
  ListRecentLedgerActivityInput,
  ListStandupPublicationsInput,
  type EntityId,
  type LedgerActivityEntry,
  type StandupPublication
} from "@athenaeum/domain"
import { WorkspaceRpcClient } from "./rpc-client.js"
import { runtime } from "./runtime.js"
import { workspaceId } from "./workspace-id.js"
import { dailyStandupWindow } from "./daily-standup-window.js"
import type { EmployeeUpdatesState } from "./EmployeeUpdates.js"

export const DAILY_STANDUP_FETCH_LIMIT = 20

export type StandupLane<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly value: T }
  | { readonly status: "failure" }

export type DailyStandupSnapshot = {
  readonly dailyNoteId?: EntityId
  readonly isToday: boolean
  readonly from?: string
  readonly to?: string
  readonly generation: number
}

export type DailyStandupController = {
  readonly snapshot: DailyStandupSnapshot
  readonly employeeUpdates: EmployeeUpdatesState | { readonly status: "idle" }
  readonly ledger: StandupLane<readonly LedgerActivityEntry[]>
  readonly isRefreshing: boolean
  readonly refresh: () => void
}

type InternalState = {
  readonly key: string
  readonly employee: StandupLane<readonly StandupPublication[]>
  readonly ledger: StandupLane<readonly LedgerActivityEntry[]>
}

export type DailyStandupLanePlan = {
  readonly publications: boolean
  readonly ledger: boolean
}

const idle = <T,>(): StandupLane<T> => ({ status: "idle" })
const loading = <T,>(): StandupLane<T> => ({ status: "loading" })
const systemClock = (): Date => new Date()

const sameWindow = (
  left: ReturnType<typeof dailyStandupWindow>,
  right: ReturnType<typeof dailyStandupWindow>
): boolean => left.from === right.from && left.to === right.to

/** The historical note still owns its employee report; only Today owns ledger activity. */
export const dailyStandupLanePlan = (dailyNoteId: EntityId | undefined, isToday: boolean): DailyStandupLanePlan => ({
  publications: dailyNoteId !== undefined,
  ledger: dailyNoteId !== undefined && isToday
})

/** A change here must synchronously hide a previous snapshot before an effect can publish again. */
export const dailyStandupSnapshotKey = (
  dailyNoteId: EntityId | undefined,
  isToday: boolean,
  dayWindow: ReturnType<typeof dailyStandupWindow>,
  refreshNonce: number
): string => `${dailyNoteId ?? "unresolved"}:${isToday ? "today" : "history"}:${isToday ? `${dayWindow.from}:${dayWindow.to}` : "historical"}:${refreshNonce}`

const employeeState = (lane: StandupLane<readonly StandupPublication[]>): DailyStandupController["employeeUpdates"] => {
  if (lane.status === "idle") return { status: "idle" }
  if (lane.status === "loading") return { status: "loading" }
  if (lane.status === "failure") return { status: "failure" }
  return { status: "success", publications: lane.value }
}

/**
 * Sole web owner for a selected note's workforce projection.  The two UI consumers receive this
 * passive snapshot; they never start a second query.  A generation includes the selected note and
 * local civil-day ledger window, so a late completion can never repopulate a different day.
 */
export function useDailyStandup({
  dailyNoteId,
  isToday,
  clock = systemClock
}: {
  readonly dailyNoteId?: EntityId
  readonly isToday: boolean
  readonly clock?: () => Date
}): DailyStandupController {
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [dayWindow, setDayWindow] = useState(() => dailyStandupWindow(clock()))
  const [state, setState] = useState<InternalState>(() => ({ key: "unresolved", employee: idle(), ledger: idle() }))
  const [isRefreshing, setRefreshing] = useState(false)
  const generationRef = useRef(0)
  const activeKeyRef = useRef("unresolved")
  const refreshClaimRef = useRef(false)

  const key = dailyStandupSnapshotKey(dailyNoteId, isToday, dayWindow, refreshNonce)

  // Derive an empty/loading view synchronously on identity change. React effects run after paint,
  // so this guard is what prevents a prior note's publications from flashing during navigation.
  const identityChanged = activeKeyRef.current !== key
  if (identityChanged) activeKeyRef.current = key

  const refresh = useCallback(() => {
    if (refreshClaimRef.current || dailyNoteId === undefined) return
    refreshClaimRef.current = true
    setRefreshing(true)
    setRefreshNonce((value) => value + 1)
  }, [dailyNoteId])

  useEffect(() => {
    const revalidateWindow = () => {
      if (!isToday || document.visibilityState === "hidden") return
      const next = dailyStandupWindow(clock())
      // Returning to a visible Today has two valid outcomes: a new civil day clears the old
      // snapshot immediately; the same civil day gets a fenced refresh. Both lanes remain one
      // shared refresh claim, so focus storms cannot start competing projections.
      if (sameWindow(dayWindow, next)) refresh()
      else setDayWindow(next)
    }
    const onVisibility = () => revalidateWindow()
    window.addEventListener("focus", revalidateWindow)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", revalidateWindow)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [clock, dayWindow, isToday, refresh])

  useEffect(() => {
    if (!isToday) return
    const now = clock()
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = window.setTimeout(() => setDayWindow(dailyStandupWindow(clock())), Math.max(1_000, tomorrow.getTime() - now.getTime()))
    return () => window.clearTimeout(timer)
  }, [clock, isToday, dayWindow.from, dayWindow.to])

  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    const snapshot: DailyStandupSnapshot = {
      dailyNoteId,
      isToday,
      from: isToday ? dayWindow.from : undefined,
      to: isToday ? dayWindow.to : undefined,
      generation
    }
    const snapshotKey = key
    // Eagerly clear both lanes before issuing either request. Historical notes have a real
    // publication lane but an explicitly not-requested ledger lane.
    const lanes = dailyStandupLanePlan(dailyNoteId, isToday)
    const employee = lanes.publications ? loading<readonly StandupPublication[]>() : idle<readonly StandupPublication[]>()
    const ledger = lanes.ledger ? loading<readonly LedgerActivityEntry[]>() : idle<readonly LedgerActivityEntry[]>()
    setState({ key: snapshotKey, employee, ledger })

    if (dailyNoteId === undefined) {
      refreshClaimRef.current = false
      setRefreshing(false)
      return
    }

    const enabledLanes = Number(lanes.publications) + Number(lanes.ledger)
    let settled = 0
    const isCurrent = (): boolean => generationRef.current === generation && activeKeyRef.current === snapshotKey
    const settle = <T,>(lane: "employee" | "ledger", next: StandupLane<T>) => {
      if (!isCurrent()) return
      setState((current) => {
        if (current.key !== snapshotKey) return current
        return lane === "employee"
          ? { ...current, employee: next as StandupLane<readonly StandupPublication[]> }
          : { ...current, ledger: next as StandupLane<readonly LedgerActivityEntry[]> }
      })
      settled += 1
      if (settled === enabledLanes && isCurrent()) {
        refreshClaimRef.current = false
        setRefreshing(false)
      }
    }
    const run = <T,>(lane: "employee" | "ledger", effect: Effect.Effect<T, unknown, any>) => {
      const fiber = runtime.runFork(Effect.exit(effect as never))
      fiber.addObserver((outer) => {
        if (!Exit.isSuccess(outer)) return
        const exit = outer.value
        if (Exit.isSuccess(exit)) settle(lane, { status: "success", value: exit.value })
        else if (!Exit.isInterrupted(exit)) {
          // Never project provider/credential-adjacent failures into the standup.
          void Cause.squash(exit.cause)
          settle(lane, { status: "failure" })
        }
      })
      return fiber
    }
    const employeeFiber = run(
      "employee",
      WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listStandupPublications(new ListStandupPublicationsInput({ workspaceId, dailyNoteId }))))
    )
    const ledgerFiber = lanes.ledger
      ? run(
        "ledger",
        WorkspaceRpcClient.pipe(Effect.flatMap((client) => client.listRecentLedgerActivity(new ListRecentLedgerActivityInput({ workspaceId, limit: DAILY_STANDUP_FETCH_LIMIT, from: dayWindow.from, to: dayWindow.to }))))
      )
      : undefined
    return () => {
      void Effect.runFork(Fiber.interrupt(employeeFiber))
      if (ledgerFiber !== undefined) void Effect.runFork(Fiber.interrupt(ledgerFiber))
    }
  }, [dailyNoteId, isToday, key, dayWindow.from, dayWindow.to])

  const displayedState = state.key === key && !identityChanged
    ? state
    : {
      key,
      employee: dailyStandupLanePlan(dailyNoteId, isToday).publications ? loading<readonly StandupPublication[]>() : idle<readonly StandupPublication[]>(),
      ledger: dailyStandupLanePlan(dailyNoteId, isToday).ledger ? loading<readonly LedgerActivityEntry[]>() : idle<readonly LedgerActivityEntry[]>()
    }
  return useMemo(() => ({
    snapshot: { dailyNoteId, isToday, from: isToday ? dayWindow.from : undefined, to: isToday ? dayWindow.to : undefined, generation: generationRef.current },
    employeeUpdates: employeeState(displayedState.employee),
    ledger: displayedState.ledger,
    isRefreshing,
    refresh
  }), [dailyNoteId, displayedState, isRefreshing, isToday, refresh, dayWindow.from, dayWindow.to])
}
