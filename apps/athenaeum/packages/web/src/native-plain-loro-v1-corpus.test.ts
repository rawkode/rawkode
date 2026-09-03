import { describe, expect, it } from "vitest"
import { LoroDoc } from "loro-crdt"
import checkedInCorpus from "./fixtures/native-plain-loro-v1-corpus.json"
import { buildNativePlainLoroV1Corpus, inspectNativePlainLoroV1, nativePlainLoroScalarOffset, NATIVE_PLAIN_LORO_SCALAR_UNIT } from "./native-plain-loro-v1-corpus.js"

const digest = async (encoded: string): Promise<string> => {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

describe("native plain Loro v1 corpus", () => {
  it("is reproducible and has stable versioned bridge fields", async () => {
    const generated = buildNativePlainLoroV1Corpus()
    expect(generated).toEqual({
      ...checkedInCorpus,
      cases: checkedInCorpus.cases.map(({ initialSnapshotSHA256: _snapshot, acceptedBaseVVSHA256: _vv, ...fixture }) => fixture)
    })
    expect(generated.scalarUnit).toBe(NATIVE_PLAIN_LORO_SCALAR_UNIT)
    expect(checkedInCorpus.negatives.every((entry) => entry.probeReplacement?.value.length > 0)).toBe(true)
    expect(inspectNativePlainLoroV1(checkedInCorpus.eligibility.snapshotBase64)).toEqual(checkedInCorpus.eligibility.expectedShape)
    for (const fixture of checkedInCorpus.cases) {
      expect(await digest(fixture.initialSnapshotBase64), fixture.id).toBe(fixture.initialSnapshotSHA256)
      expect(await digest(fixture.acceptedBaseVVBase64), `${fixture.id} vv`).toBe(fixture.acceptedBaseVVSHA256)
      expect(inspectNativePlainLoroV1(fixture.initialSnapshotBase64)).toEqual(fixture.initialShape)
      expect(fixture.expectedFinalShape.blocks[0].text).toBe(fixture.expectedText)
      expect(fixture.originalText.includes("\n")).toBe(false)
      expect(fixture.expectedText.includes("\n")).toBe(false)
    }
  })

  it("covers closed-world capabilities, including newline rejection", () => {
    expect(checkedInCorpus.negatives.map((entry) => entry.id)).toEqual([
      "negative-newline-rejected", "negative-missing-is-amg-block", "negative-true-is-amg-block",
      "negative-extra-attribute", "negative-extra-root-property", "negative-extra-paragraph-property", "negative-mark", "negative-extra-block", "negative-extra-container"
    ])
    expect(checkedInCorpus.negatives.every((entry) => entry.expectedFailure === "closed-world-plain-loro-v1")).toBe(true)
    const newline = checkedInCorpus.negatives.find((entry) => entry.capability === "rejected-newline")
    expect(newline?.replacement?.value.includes("\n")).toBe(true)
    expect(newline?.replacement?.originalText).toBe("plain")
    expect(newline?.replacement?.rangeStart).toBe(5)
    expect(inspectNativePlainLoroV1(newline!.snapshotBase64).blocks[0].text).toBe("plain")
    for (const entry of checkedInCorpus.negatives.filter((entry) => entry.snapshotBase64 && entry.capability !== "rejected-newline")) {
      expect(() => inspectNativePlainLoroV1(entry.snapshotBase64), entry.id).toThrow()
    }
    expect(nativePlainLoroScalarOffset("A🦜B", 2)).toBe(3)
    expect(nativePlainLoroScalarOffset("café", 5)).toBe(5)
  })

  it("enumerates an empty unknown root when empty roots are retained", () => {
    const doc = new LoroDoc()
    doc.import(Uint8Array.from(atob(checkedInCorpus.eligibility.snapshotBase64), (character) => character.charCodeAt(0)))
    doc.getMap("empty-unknown-root")
    doc.setHideEmptyRootContainers(false)
    let binary = ""
    for (const byte of doc.export({ mode: "snapshot" })) binary += String.fromCharCode(byte)
    expect(() => inspectNativePlainLoroV1(btoa(binary))).toThrow("unexpected Loro root container")
  })
})
