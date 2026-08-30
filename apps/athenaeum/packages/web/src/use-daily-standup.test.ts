/** @vitest-environment happy-dom */

import { EntityId } from "@athenaeum/domain"
import { describe, expect, it } from "vitest"
import { dailyStandupLanePlan, dailyStandupSnapshotKey } from "./use-daily-standup.js"

const note = EntityId.make("00000000-0000-4000-8000-000000000210")
const today = {
  from: "2026-08-30T00:00:00.000Z",
  to: "2026-08-31T00:00:00.000Z"
} as never
const tomorrow = {
  from: "2026-08-31T00:00:00.000Z",
  to: "2026-09-01T00:00:00.000Z"
} as never

describe("daily standup controller contract", () => {
  it("keeps historical publication detail but never plans a ledger request", () => {
    expect(dailyStandupLanePlan(note, false)).toEqual({ publications: true, ledger: false })
    expect(dailyStandupLanePlan(note, true)).toEqual({ publications: true, ledger: true })
    expect(dailyStandupLanePlan(undefined, true)).toEqual({ publications: false, ledger: false })
  })

  it("makes refresh, civil-day, mode, and note transitions distinct snapshot identities", () => {
    const initial = dailyStandupSnapshotKey(note, true, today, 0)
    expect(dailyStandupSnapshotKey(note, true, today, 1)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(note, true, tomorrow, 0)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(note, false, today, 0)).not.toBe(initial)
    expect(dailyStandupSnapshotKey(EntityId.make("00000000-0000-4000-8000-000000000211"), true, today, 0)).not.toBe(initial)
  })
})
