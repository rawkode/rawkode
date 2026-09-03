// @vitest-environment happy-dom
import { StrictMode } from "react"
import { act } from "react-dom/test-utils"
import { createRoot } from "react-dom/client"
import { MemoryRouter, useLocation, useNavigate } from "react-router"
import { describe, expect, it } from "vitest"
import { VisualVariantSynchronizer } from "./VisualVariantSynchronizer.js"

function Navigate({ to, label }: { readonly to: string; readonly label: string }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(to)}>{label}</button>
}

function LocationProbe() {
  const { search } = useLocation()
  return <output>{search}</output>
}

describe("VisualVariantSynchronizer", () => {
  it("tracks location search through StrictMode without cleanup flicker", async () => {
    const host = document.createElement("div")
    const root = createRoot(host)
    document.documentElement.dataset.theme = "paper"
    document.documentElement.dataset.variant = "paper"

    await act(async () => {
      root.render(<StrictMode><MemoryRouter initialEntries={["/notes?date=2026-08-27&variant=paper"]}><VisualVariantSynchronizer /><LocationProbe /><Navigate label="invalid" to="/notes?date=2026-08-27" /><Navigate label="study" to="/notes?variant=study" /><Navigate label="absent" to="/notes" /></MemoryRouter></StrictMode>)
    })
    expect(document.documentElement.dataset.visualVariant).toBe("paper")
    expect(document.documentElement.dataset.theme).toBe("paper")

    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click())
    expect(document.documentElement.dataset.visualVariant).toBeUndefined()
    expect(host.querySelector("output")?.textContent).toBe("?date=2026-08-27")

    await act(async () => host.querySelectorAll<HTMLButtonElement>("button")[1]?.click())
    expect(document.documentElement.dataset.visualVariant).toBe("study")

    await act(async () => host.querySelectorAll<HTMLButtonElement>("button")[2]?.click())
    expect(document.documentElement.dataset.visualVariant).toBeUndefined()
    root.unmount()
  })
})
