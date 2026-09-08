import { describe, expect, it } from "vitest"
import { applyTheme, readStoredTheme, themeForEnvironment, THEME_STORAGE_KEY } from "./theme.js"

const storage = (value: string | null) => ({
  getItem: () => value,
  setItem: () => undefined
})

describe("theme selection", () => {
  it("uses a persisted choice before the operating-system preference", () => {
    expect(readStoredTheme(storage("dark"))).toBe("dark")
    expect(themeForEnvironment(readStoredTheme(storage("dark")), true)).toBe("dark")
    expect(themeForEnvironment(readStoredTheme(storage("paper")), false)).toBe("paper")
  })

  it("falls back to the system preference and ignores unknown values", () => {
    expect(readStoredTheme(storage("unknown"))).toBeUndefined()
    expect(themeForEnvironment(undefined, true)).toBe("paper")
    expect(themeForEnvironment(undefined, false)).toBe("dark")
  })

  it("applies and removes the paper variant without leaving stale attributes", () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement
    applyTheme("paper", root)
    expect(root.dataset.theme).toBe("paper")
    expect(root.dataset.variant).toBe("paper")
    applyTheme("dark", root)
    expect(root.dataset.theme).toBe("dark")
    expect(root.dataset.variant).toBeUndefined()
  })

  it("keeps the storage key stable for future migrations", () => {
    expect(THEME_STORAGE_KEY).toBe("athenaeum.theme")
  })
})
