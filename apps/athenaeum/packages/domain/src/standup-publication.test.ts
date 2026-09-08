import { describe, expect, it } from "vitest"
import { STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION, canonicalStandupPublicationSlot, canonicalStandupPublicationText, standupPublicationChildNodeId, standupPublicationFingerprint, standupPublicationRequestIdentity } from "./standup-publication.js"

const slot = () => ({ version: STANDUP_PUBLICATION_SLOT_IDENTITY_VERSION, workspaceId: "workspace", dailyNoteId: "daily-note", runIdentityVersion: "run.v1", microEmployee: { kind: "microEmployee" as const, id: "employee", version: "1" }, job: { kind: "job" as const, id: "job", version: "1" }, workflow: { kind: "workflow" as const, id: "workflow", version: "1" }, schedule: { kind: "schedule" as const, id: "schedule", version: "1" }, runId: "run", occurrenceId: "occurrence", civilDate: "2026-08-28", councilRefs: [{ kind: "council" as const, id: "council-b", version: "1" }, { kind: "council" as const, id: "council-a", version: "2" }] })
describe("standup publication identity", () => {
  it("includes every slot field, canonicalizes council order, and rejects duplicates", () => {
    const base = slot(), baseline = standupPublicationRequestIdentity(base)
    expect(canonicalStandupPublicationSlot(base).councilRefs.map((x) => x.id)).toEqual(["council-a", "council-b"])
    expect(standupPublicationRequestIdentity({ ...base, councilRefs: [...base.councilRefs].reverse() })).toBe(baseline)
    for (const mutate of [
      (x: ReturnType<typeof slot>) => ({ ...x, workspaceId: "other" }), (x: ReturnType<typeof slot>) => ({ ...x, dailyNoteId: "other" }), (x: ReturnType<typeof slot>) => ({ ...x, runIdentityVersion: "run.v2" }),
      (x: ReturnType<typeof slot>) => ({ ...x, microEmployee: { ...x.microEmployee, id: "other" } }), (x: ReturnType<typeof slot>) => ({ ...x, microEmployee: { ...x.microEmployee, version: "2" } }),
      (x: ReturnType<typeof slot>) => ({ ...x, job: { ...x.job, id: "other" } }), (x: ReturnType<typeof slot>) => ({ ...x, job: { ...x.job, version: "2" } }),
      (x: ReturnType<typeof slot>) => ({ ...x, workflow: { ...x.workflow, id: "other" } }), (x: ReturnType<typeof slot>) => ({ ...x, workflow: { ...x.workflow, version: "2" } }),
      (x: ReturnType<typeof slot>) => ({ ...x, schedule: { ...x.schedule, id: "other" } }), (x: ReturnType<typeof slot>) => ({ ...x, schedule: { ...x.schedule, version: "2" } }),
      (x: ReturnType<typeof slot>) => ({ ...x, runId: "other" }), (x: ReturnType<typeof slot>) => ({ ...x, occurrenceId: "other" }), (x: ReturnType<typeof slot>) => ({ ...x, civilDate: "2026-08-29" }),
      (x: ReturnType<typeof slot>) => ({ ...x, councilRefs: [{ ...x.councilRefs[0]!, id: "other" }, x.councilRefs[1]!] }), (x: ReturnType<typeof slot>) => ({ ...x, councilRefs: [{ ...x.councilRefs[0]!, version: "3" }, x.councilRefs[1]!] }), (x: ReturnType<typeof slot>) => ({ ...x, councilRefs: x.councilRefs.slice(0, 1) })
    ]) expect(standupPublicationRequestIdentity(mutate(slot()))).not.toBe(baseline)
    expect(() => canonicalStandupPublicationSlot({ ...base, councilRefs: [base.councilRefs[0]!, base.councilRefs[0]!] })).toThrow("duplicate")
    expect(standupPublicationChildNodeId(base)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it("keeps canonical report bytes exact while rejecting only empty and malformed input", () => {
    const variants = [" ", "a\r\nb", "a\nb", "a\n", "é", "e\u0301"]
    expect(new Set(variants.map((text) => canonicalStandupPublicationText(text).sha256)).size).toBe(variants.length)
    expect(() => canonicalStandupPublicationText("")).toThrow("non-empty")
    expect(() => canonicalStandupPublicationText("\ud800")).toThrow("well-formed")
  })
  it("keeps request and child identity stable across report changes while fingerprint changes", () => {
    const value = slot(), a = standupPublicationFingerprint({ slot: value, text: "one", authority: { subject: "subject", generation: "1" } }), b = standupPublicationFingerprint({ slot: value, text: "two", authority: { subject: "subject", generation: "1" } })
    expect(a).not.toBe(b); expect(standupPublicationRequestIdentity(value)).toBe(standupPublicationRequestIdentity(value)); expect(standupPublicationChildNodeId(value)).toBe(standupPublicationChildNodeId(value))
  })
})
