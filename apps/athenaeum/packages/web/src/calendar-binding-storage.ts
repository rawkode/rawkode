import type { EntityId } from "@athenaeum/domain"

// **Same-tab coherence** (found live, via this stage's own browser verification: disconnecting in
// `CalendarPanel.tsx` left `CalendarDayView.tsx` still showing the just-removed binding as
// connected, in the SAME tab): the browser's native `storage` event fires in every OTHER
// same-origin tab/window when `localStorage` changes, but deliberately NEVER in the document that
// made the write — see MDN's own `StorageEvent` docs. `CalendarPanel`/`CalendarDayView` are
// siblings reading the same key independently, so a write in one needs its own same-tab signal.
// `CALENDAR_BINDING_CHANGED_EVENT` is that signal — dispatched on `window` right after every
// write/clear below, alongside the real `localStorage` mutation the native `storage` event still
// picks up for OTHER tabs (`CalendarDayView.tsx`'s own `storage`-event listener is unaffected by
// this addition, still real, still needed for the cross-tab case).
export const CALENDAR_BINDING_CHANGED_EVENT = "athenaeum:calendarBindingChanged"

// **Documented limitation** (see `CalendarPanel.tsx`'s header comment for the full rationale):
// `gatekeeper-rpc.ts` has no "list this workspace's gatekeeper bindings" RPC method — only
// `connectGoogleCalendar`/`googleCalendarOAuthCallback`/`disconnectGoogleCalendar`/
// `syncGoogleCalendar` (which all take/return a `bindingId`, never enumerate one). So THIS
// browser's record of "which binding did I connect for this workspace" is necessarily client-side
// bookkeeping, not an authoritative server read — a different browser/device, or this same
// browser with `localStorage` cleared, has no way to discover an already-connected binding's id
// today. That is a real, documented Phase 5 gap (the next stage's obvious follow-up is a
// `listGatekeeperBindings` RPC method), not a bug in this file.

const keyFor = (workspaceId: EntityId): string => `athenaeum:calendarBinding:${workspaceId}`

export const loadCalendarBindingId = (workspaceId: EntityId): EntityId | undefined => {
  try {
    const raw = window.localStorage.getItem(keyFor(workspaceId))
    return raw === null ? undefined : (raw as EntityId)
  } catch {
    return undefined
  }
}

export const saveCalendarBindingId = (workspaceId: EntityId, bindingId: EntityId): void => {
  try {
    window.localStorage.setItem(keyFor(workspaceId), bindingId)
  } catch {
    // best-effort, same fail-open rationale as workspace-id.ts's own localStorage use
  }
  window.dispatchEvent(new CustomEvent(CALENDAR_BINDING_CHANGED_EVENT))
}

export const clearCalendarBindingId = (workspaceId: EntityId): void => {
  try {
    window.localStorage.removeItem(keyFor(workspaceId))
  } catch {
    // best-effort
  }
  window.dispatchEvent(new CustomEvent(CALENDAR_BINDING_CHANGED_EVENT))
}
