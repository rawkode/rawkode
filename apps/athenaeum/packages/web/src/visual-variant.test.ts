import { describe, expect, it } from "vitest"
import { applyVisualVariant, bootstrapVisualVariant, parseVisualVariant } from "./visual-variant.js"

describe("visual prototype query contract", () => {
  it("accepts one exact, decoded visual variant alongside unrelated query parameters", () => {
    expect(parseVisualVariant("?date=2026-08-27&variant=paper")).toBe("paper")
    expect(parseVisualVariant("?variant=%70aper")).toBe("paper")
    expect(parseVisualVariant("?variant=study")).toBe("study")
  })

  it("rejects absent, ambiguous, and non-exact variants", () => {
    for (const search of ["", "?variant=", "?variant=Paper", "?variant=unknown", "?variant=paper&variant=paper", "?variant=paper&variant=study"]) {
      expect(parseVisualVariant(search)).toBeUndefined()
    }
  })

  it("changes only the visual-prototype attribute", () => {
    const root = { dataset: { theme: "paper", variant: "paper", keep: "yes" } } as unknown as HTMLElement
    applyVisualVariant("?variant=study", root)
    expect(root.dataset).toEqual({ theme: "paper", variant: "paper", keep: "yes", visualVariant: "study" })
    applyVisualVariant("?variant=paper&variant=study", root)
    expect(root.dataset).toEqual({ theme: "paper", variant: "paper", keep: "yes" })
  })

  it("leaves the default DOM attribute contract unchanged when no valid query is present", () => {
    const root = { dataset: { theme: "dark", keep: "yes" } } as unknown as HTMLElement
    applyVisualVariant("?date=2026-08-27", root)
    expect(root.dataset).toEqual({ theme: "dark", keep: "yes" })
  })

  it("bootstraps directly from the supplied location search", () => {
    const root = { dataset: {} } as unknown as HTMLElement
    bootstrapVisualVariant("?date=2026-08-27&variant=paper", root)
    expect(root.dataset.visualVariant).toBe("paper")
  })
})
