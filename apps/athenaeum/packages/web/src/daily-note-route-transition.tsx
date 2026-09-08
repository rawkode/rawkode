import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useBlocker, type Location } from "react-router"
import { parseDateStamp } from "./daily-note-id.js"

export type DailyNoteDepartureState = "legacy-automerge" | "loro-awaiting-attachment" | "loro-ready"

export type DailyNoteDepartureRegistration = {
  readonly routeKey: string
  readonly routeGeneration: symbol
  readonly todayStamp: string
  readonly state: DailyNoteDepartureState
  readonly checkpoint?: () => Promise<boolean>
}

export type DailyNoteDeparturePresentation = "idle" | "saving" | "blocked"

type DepartureClaim = {
  readonly routeKey: string
  readonly routeGeneration: symbol
  readonly proceed: () => void
  readonly reset: () => void
  readonly checkpoint?: () => Promise<boolean>
}

type DailyNoteRouteTransitionContextValue = {
  readonly register: (registration: DailyNoteDepartureRegistration) => () => void
  readonly presentation: DailyNoteDeparturePresentation
}

const DailyNoteRouteTransitionContext = createContext<DailyNoteRouteTransitionContextValue | undefined>(undefined)

const routeKeyFor = (location: Pick<Location, "pathname" | "search" | "hash">): string =>
  `${location.pathname}${location.search}${location.hash}`

/** Mirrors NotesRoute: bad, absent, and impossible dates all mean the current civil day. */
export const logicalDailyNoteIdentity = (
  location: Pick<Location, "pathname" | "search">,
  todayStamp: string
): string | undefined => {
  if (location.pathname !== "/notes") return undefined
  const requested = new URLSearchParams(location.search).get("date")
  return requested === null ? todayStamp : (parseDateStamp(requested) === undefined ? todayStamp : requested)
}

export function DailyNoteRouteTransitionProvider({ children }: { readonly children: ReactNode }) {
  const registrationRef = useRef<DailyNoteDepartureRegistration | undefined>(undefined)
  const claimRef = useRef<DepartureClaim | undefined>(undefined)
  const [presentation, setPresentation] = useState<DailyNoteDeparturePresentation>("idle")

  const register = useCallback((registration: DailyNoteDepartureRegistration) => {
    registrationRef.current = registration
    if (claimRef.current === undefined) setPresentation("idle")
    return () => {
      if (registrationRef.current === registration) registrationRef.current = undefined
    }
  }, [])

  const shouldBlock = useCallback(({
    currentLocation,
    nextLocation
  }: {
    readonly currentLocation: Location
    readonly nextLocation: Location
  }) => {
    // Once a departure claim exists, absolutely every SPA transition waits. In particular, a
    // visual-variant replace or second Back press must never swap the first blocker callbacks.
    if (claimRef.current !== undefined) return true
    const registration = registrationRef.current
    if (registration === undefined || registration.state === "legacy-automerge") return false
    if (registration.routeKey !== routeKeyFor(currentLocation)) return false
    return logicalDailyNoteIdentity(currentLocation, registration.todayStamp) !==
      logicalDailyNoteIdentity(nextLocation, registration.todayStamp)
  }, [])
  const blocker = useBlocker(shouldBlock)

  useLayoutEffect(() => {
    if (blocker.state !== "blocked" || claimRef.current !== undefined) return
    const registration = registrationRef.current
    // The predicate checked this synchronously. Recheck before capturing callbacks so a route
    // render can never borrow a departing note's attachment or permit a fail-open race.
    if (registration === undefined) {
      blocker.reset()
      return
    }
    const claim: DepartureClaim = {
      routeKey: registration.routeKey,
      routeGeneration: registration.routeGeneration,
      proceed: blocker.proceed,
      reset: blocker.reset,
      checkpoint: registration.state === "loro-ready" ? registration.checkpoint : undefined
    }
    claimRef.current = claim
    if (claim.checkpoint === undefined) {
      setPresentation("blocked")
      claimRef.current = undefined
      claim.reset()
      return
    }
    setPresentation("saving")
    void claim.checkpoint().then((clean) => {
      if (claimRef.current !== claim) return
      const registration = registrationRef.current
      if (
        registration === undefined ||
        registration.routeKey !== claim.routeKey ||
        registration.routeGeneration !== claim.routeGeneration
      ) {
        claimRef.current = undefined
        setPresentation("blocked")
        claim.reset()
        return
      }
      claimRef.current = undefined
      if (clean) {
        setPresentation("idle")
        // Replay the original captured PUSH/REPLACE/POP once.  For POP, React Router restores
        // the current entry while blocked and this callback replays that exact history action.
        claim.proceed()
      } else {
        setPresentation("blocked")
        claim.reset()
      }
    }, () => {
      if (claimRef.current !== claim) return
      claimRef.current = undefined
      setPresentation("blocked")
      claim.reset()
    })
  }, [blocker])

  const value = useMemo(() => ({ register, presentation }), [presentation, register])
  return <DailyNoteRouteTransitionContext.Provider value={value}>{children}</DailyNoteRouteTransitionContext.Provider>
}

export const useDailyNoteRouteTransition = (): DailyNoteRouteTransitionContextValue => {
  const value = useContext(DailyNoteRouteTransitionContext)
  if (value === undefined) throw new Error("Daily note route transition provider is required")
  return value
}
