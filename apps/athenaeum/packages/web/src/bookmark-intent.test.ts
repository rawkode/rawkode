/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it } from "vitest"
import { EntityId } from "@athenaeum/domain"
import {
  clearPendingBookmarkIntent,
  pendingBookmarkStorageKey,
  persistPendingBookmarkIntent,
  readPendingBookmarkIntent,
  resolveBookmarkIntent
} from "./bookmark-intent.js"

const workspaceId = EntityId.make("00000000-0000-4000-8000-000000000011")

describe("bookmark capture intent", () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => { values.delete(key) },
        setItem: (key: string, value: string) => { values.set(key, value) }
      }
    })
  })

  it("persists and reuses one request id after a lost response", () => {
    const first = resolveBookmarkIntent("https://example.test/private?token=1", "Private note", null, () => "bookmark-request-1")
    persistPendingBookmarkIntent(workspaceId, first)
    const recovered = readPendingBookmarkIntent(workspaceId)
    const retry = resolveBookmarkIntent(first.url, first.title ?? "", recovered, () => "bookmark-request-2")
    expect(retry).toEqual(first)
    expect(retry.requestId).toBe("bookmark-request-1")
  })

  it("mints a new request id only when semantic input changes", () => {
    const first = resolveBookmarkIntent("https://example.test/a", "", null, () => "bookmark-request-1")
    const changed = resolveBookmarkIntent("https://example.test/a", "New title", first, () => "bookmark-request-2")
    expect(changed.requestId).toBe("bookmark-request-2")
    expect(changed.title).toBe("New title")
  })

  it("discards malformed persisted state", () => {
    window.localStorage.setItem(pendingBookmarkStorageKey(workspaceId), JSON.stringify({ requestId: "", url: "https://example.test/a" }))
    expect(readPendingBookmarkIntent(workspaceId)).toBeNull()
    clearPendingBookmarkIntent(workspaceId)
  })
})
