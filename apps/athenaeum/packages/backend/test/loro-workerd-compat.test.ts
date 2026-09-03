import { LoroDoc } from "loro-crdt/bundler"
import { describe, expect, it } from "vitest"

describe("Loro support inside workerd", () => {
  it("exports and re-imports text, map, snapshot, and update state", async () => {
    const source = new LoroDoc()
    const text = source.getText("text")
    const metadata = source.getMap("metadata")

    text.insert(0, "Hello ")
    text.insert(text.length, "Loro")
    metadata.set("kind", "daily-note")
    metadata.set("revision", 1)
    source.commit()

    const snapshot = source.export({ mode: "snapshot" })
    const restoredFromSnapshot = new LoroDoc()
    restoredFromSnapshot.import(snapshot)

    expect(restoredFromSnapshot.getText("text").toString()).toBe("Hello Loro")
    expect(restoredFromSnapshot.getMap("metadata").get("kind")).toBe("daily-note")
    expect(restoredFromSnapshot.getMap("metadata").get("revision")).toBe(1)

    const updateSource = new LoroDoc()
    updateSource.getText("text").insert(0, "Hello")
    updateSource.getMap("metadata").set("kind", "daily-note")
    updateSource.commit()

    const update = updateSource.export({ mode: "update" })
    const restoredFromUpdate = new LoroDoc()
    restoredFromUpdate.import(update)

    expect(restoredFromUpdate.getText("text").toString()).toBe("Hello")
    expect(restoredFromUpdate.getMap("metadata").get("kind")).toBe("daily-note")
  })
})
