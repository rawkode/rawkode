// @enchiridion/worker-gadget-host — capability vocabulary.
//
// Plan §Gadgets: "Capabilities injected at load, default nothing:
// graph.query (pre-defined parameterized views only ...), graph.propose()
// (writes are always proposals), gatekeeper.google.calendar.read,
// schedule.cron." The FOUR capability types this P4 pass implements, fixed
// here as a closed union — adding a fifth is a deliberate code change
// (a new discriminant branch in `CapabilityScope` below plus a new
// `*-capability.ts` module), never a free-form string a grant could invent.

/** One capability type per plan §Gadgets' enumerated list. Kept as a
 *  string-literal union (not a `class`/`enum`) so it round-trips through
 *  SQLite `TEXT` and JSON without any encode/decode step, matching every
 *  other "closed string vocabulary" convention in this codebase (e.g.
 *  gatekeeper-google's `ApprovalActionType`). */
export type CapabilityType = "graph.query" | "graph.propose" | "gatekeeper.google.calendar.read" | "schedule.cron";

export const CAPABILITY_TYPES: readonly CapabilityType[] = [
  "graph.query",
  "graph.propose",
  "gatekeeper.google.calendar.read",
  "schedule.cron",
];

export function isCapabilityType(value: string): value is CapabilityType {
  return (CAPABILITY_TYPES as readonly string[]).includes(value);
}

/** The scope/params a grant narrows a capability to — plan: "capability
 *  type, scope/params, granted-at, revocable". A discriminated union keyed
 *  on the SAME `CapabilityType` so a grant's `scope` is always shaped
 *  correctly for its `capabilityType`, checked at both grant-creation time
 *  (`capability-store.ts`) and every enforcement call site
 *  (`capability-enforcement.ts`).
 *
 *  - `graph.query`: `views` — the task brief's explicit requirement ("a
 *    granted graph.query capability only works within its declared view
 *    allowlist"). An EMPTY array is a valid (if useless) grant, never
 *    "all views" — there is no implicit wildcard, matching "default
 *    nothing" all the way down into a single grant's own scope.
 *  - `graph.propose`: `pageIDs` + `pagePrefixes` — mirrors `graph.query`'s
 *    `views` allowlist pattern exactly: BOTH arrays default to empty
 *    ("no implicit wildcard"; a grant with `{pageIDs: [], pagePrefixes:
 *    []}` may propose nothing at all, same as `graph.query`'s empty
 *    `views`). `pageIDs` is an exact-match allowlist (a specific, already-
 *    known page); `pagePrefixes` is a `pageID.startsWith(prefix)`
 *    allowlist, the practical shape the plan's v1 use case actually needs
 *    ("morning brief written to the daily page" — the target pageID is a
 *    NEW one every day, `daily:YYYY-MM-DD`, so an exact-match list alone
 *    would need re-granting every single day; a gadget scoped to
 *    `{pagePrefixes: ["daily:"]}` can write to any day's daily page,
 *    forever, without widening beyond "daily pages only"). A proposal's
 *    `payload.pageID` is in scope if it exactly matches ANY `pageIDs`
 *    entry OR starts with ANY `pagePrefixes` entry — see
 *    `graph-propose-capability.ts`'s `isPageInScope`. Enforced at PROPOSE
 *    time (never confirm time — confirm isn't reachable from gadget code
 *    at all, see that file's header), same layering `graph-query-
 *    capability.ts` uses for `views` (grant existence, then scope).
 *  - `gatekeeper.google.calendar.read`: no fields — the one operation it
 *    unlocks (`listUpcomingEvents`) is already narrow enough that a v1
 *    grant is all-or-nothing, matching the plan's own one-line description
 *    ("a capability that ... allows a gadget to call a narrow read-only
 *    calendar query", no further scoping mentioned).
 *  - `schedule.cron`: `minIntervalMinutes` — the FLOOR on how frequently a
 *    schedule registered under this grant may fire (a gadget requesting
 *    "every 1 minute" when only granted "every 60 minutes or slower" is
 *    denied at `schedule-capability.ts`'s `registerSchedule`, not silently
 *    clamped) — bounds how much supervisor-tick fan-out work one grant can
 *    cause.
 */
export type CapabilityScope =
  | { capabilityType: "graph.query"; views: readonly string[] }
  | { capabilityType: "graph.propose"; pageIDs: readonly string[]; pagePrefixes: readonly string[] }
  | { capabilityType: "gatekeeper.google.calendar.read" }
  | { capabilityType: "schedule.cron"; minIntervalMinutes: number };

export interface CapabilityGrant {
  id: string;
  gadgetId: string;
  capabilityType: CapabilityType;
  scope: CapabilityScope;
  grantedAt: number;
  grantedBy: string;
  revokedAt: number | null;
}

export type GrantRequestStatus = "pending" | "approved" | "denied";

export interface CapabilityGrantRequest {
  id: string;
  gadgetId: string;
  capabilityType: CapabilityType;
  scope: CapabilityScope;
  reason: string | null;
  status: GrantRequestStatus;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  /** Set once `status` is `"approved"` — the `CapabilityGrant.id` this
   *  request produced. `null` for `pending`/`denied`. */
  resultingGrantId: string | null;
}

/** Thrown by `capability-enforcement.ts`'s `requireCapability` — the ONE
 *  error every capability-gated call site (`graph-query-capability.ts`,
 *  `graph-propose-capability.ts`, `calendar-read-capability.ts`,
 *  `schedule-capability.ts`) throws on denial, so a gadget's own error
 *  handling (and this worker's tests) can rely on one shape regardless of
 *  which capability was denied. Mirrors this codebase's established
 *  "plain, named Error subclass carrying a `.reason`" convention (compare
 *  `workers/vault/src/query-rpc.ts`'s `BoundedQueryError`). */
export class CapabilityDeniedError extends Error {
  constructor(
    public readonly gadgetId: string,
    public readonly capabilityType: CapabilityType,
    reason: string,
  ) {
    super(`capability denied for gadget "${gadgetId}" (${capabilityType}): ${reason}`);
    this.name = "CapabilityDeniedError";
  }
}
