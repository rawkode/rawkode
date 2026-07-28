import { describe, expect, test } from "bun:test"
import { createSerializedPageLoader, navigateAfterFlush } from "../src/editorLifecycle"

describe("editor page lifecycle", () => {
  test("flushes pending edits before each serialized page load", async () => {
    const events: string[] = []
    let releaseFirstFlush: (() => void) | undefined
    const firstFlush = new Promise<void>(resolve => { releaseFirstFlush = resolve })
    let flushCount = 0
    const loadPage = createSerializedPageLoader(
      async () => {
        flushCount += 1
        events.push(`flush:${flushCount}`)
        if (flushCount === 1) await firstFlush
      },
      async page => { events.push(`load:${page}`) },
    )

    const first = loadPage("first")
    const second = loadPage("second")
    await Promise.resolve()
    expect(events).toEqual(["flush:1"])

    releaseFirstFlush?.()
    await Promise.all([first, second])
    expect(events).toEqual(["flush:1", "load:first", "flush:2", "load:second"])
  })

  test("a failed page load does not poison later navigation", async () => {
    const loaded: string[] = []
    const loadPage = createSerializedPageLoader(
      async () => {},
      async page => {
        if (page === "broken") throw new Error("broken")
        loaded.push(page)
      },
    )

    await expect(loadPage("broken")).rejects.toThrow("broken")
    await expect(loadPage("healthy")).resolves.toBeUndefined()
    expect(loaded).toEqual(["healthy"])
  })
})

describe("internal navigation", () => {
  test("waits for pending edits before opening a native destination", async () => {
    const events: string[] = []

    await navigateAfterFlush(
      async () => { events.push("flush") },
      async () => { events.push("navigate") },
    )

    expect(events).toEqual(["flush", "navigate"])
  })

  test("does not navigate when flushing fails", async () => {
    let didNavigate = false

    await expect(navigateAfterFlush(
      async () => { throw new Error("commit failed") },
      async () => { didNavigate = true },
    )).rejects.toThrow("commit failed")

    expect(didNavigate).toBeFalse()
  })
})
