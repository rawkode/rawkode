/** @vitest-environment happy-dom */

import { act, StrictMode, useRef, useState, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Drawer, type DrawerMode } from "./Drawer.js"

const flushEffects = async (): Promise<void> => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

const roots: Array<{ readonly root: Root; readonly container: HTMLDivElement }> = []

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
})

function DrawerHarness({ mode = "overlay" }: { readonly mode?: DrawerMode }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open drawer
      </button>
      <Drawer
        open={open}
        mode={mode}
        id="test-drawer"
        label="Test drawer"
        closeLabel="Close drawer"
        restoreFocusRef={triggerRef}
        onClose={() => setOpen(false)}
      >
        <button type="button">First action</button>
      </Drawer>
    </>
  )
}

const mount = async (element: ReactElement): Promise<HTMLDivElement> => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  roots.push({ root, container })
  await act(async () => {
    root.render(<StrictMode>{element}</StrictMode>)
    await flushEffects()
  })
  return container
}

describe("Drawer", () => {
  it("opens a modal drawer, moves focus in, and restores focus on close", async () => {
    const container = await mount(<DrawerHarness />)
    const trigger = container.querySelector<HTMLButtonElement>("button")
    expect(trigger).not.toBeNull()

    await act(async () => {
      trigger?.click()
      await flushEffects()
    })

    const dialog = container.querySelector<HTMLDialogElement>("dialog")
    expect(dialog?.open).toBe(true)
    expect(dialog?.inert).toBe(false)
    expect(document.activeElement).toBe(dialog?.querySelector(".drawer-close"))

    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>(".drawer-close")?.click()
      await flushEffects()
    })

    expect(dialog?.open).toBe(false)
    expect(dialog?.inert).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it("keeps a closed docked drawer inert and ignores Escape", async () => {
    const onClose = vi.fn()
    const container = await mount(
      <Drawer open={false} mode="docked" id="test-docked" label="Test docked drawer" onClose={onClose}>
        <button type="button">Action</button>
      </Drawer>
    )
    const aside = container.querySelector<HTMLElement>("aside")
    expect(aside?.inert).toBe(true)
    expect(aside?.getAttribute("aria-hidden")).toBe("true")

    await act(async () => {
      aside?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flushEffects()
    })

    expect(onClose).not.toHaveBeenCalled()
  })

  it("closes an open, dismissible docked drawer with Escape", async () => {
    const onClose = vi.fn()
    const container = await mount(
      <Drawer open mode="docked" id="test-dismissible-docked" label="Test docked drawer" onClose={onClose}>
        <button type="button">Action</button>
      </Drawer>
    )
    const aside = container.querySelector<HTMLElement>("aside")

    await act(async () => {
      aside?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flushEffects()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("does not dismiss an open resident docked drawer with Escape", async () => {
    const onClose = vi.fn()
    const container = await mount(
      <Drawer open mode="docked" dismissible={false} id="test-resident-docked" label="Test resident drawer" onClose={onClose}>
        <button type="button">Action</button>
      </Drawer>
    )
    const aside = container.querySelector<HTMLElement>("aside")

    await act(async () => {
      aside?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await flushEffects()
    })

    expect(onClose).not.toHaveBeenCalled()
  })

  it("routes a native overlay cancel event to onClose", async () => {
    const onClose = vi.fn()
    const container = await mount(
      <Drawer open mode="overlay" id="test-cancel" label="Test cancel" onClose={onClose}>
        <button type="button">Action</button>
      </Drawer>
    )
    const dialog = container.querySelector<HTMLDialogElement>("dialog")

    await act(async () => {
      dialog?.dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true }))
      await flushEffects()
    })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("reapplies inert when a closed drawer changes presentation mode", async () => {
    const container = await mount(
      <Drawer open={false} mode="docked" id="test-transition" label="Test transition drawer" onClose={() => undefined}>
        <button type="button">Action</button>
      </Drawer>
    )
    const root = roots[roots.length - 1].root

    await act(async () => {
      root.render(
        <StrictMode>
          <Drawer open={false} mode="overlay" id="test-transition" label="Test transition drawer" onClose={() => undefined}>
            <button type="button">Action</button>
          </Drawer>
        </StrictMode>
      )
      await flushEffects()
    })

    const dialog = container.querySelector<HTMLDialogElement>("dialog")
    expect(dialog?.open).toBe(false)
    expect(dialog?.inert).toBe(true)
  })

  it("keeps an open drawer usable while switching between docked and overlay modes", async () => {
    const onClose = vi.fn()
    const container = await mount(
      <Drawer open mode="docked" id="test-open-transition" label="Test open transition" onClose={onClose}>
        <button type="button">Action</button>
      </Drawer>
    )
    const root = roots[roots.length - 1].root
    expect(container.querySelector<HTMLElement>("aside")?.inert).toBe(false)

    await act(async () => {
      root.render(
        <StrictMode>
          <Drawer open mode="overlay" id="test-open-transition" label="Test open transition" onClose={onClose}>
            <button type="button">Action</button>
          </Drawer>
        </StrictMode>
      )
      await flushEffects()
    })
    const dialog = container.querySelector<HTMLDialogElement>("dialog")
    expect(dialog?.open).toBe(true)
    expect(dialog?.contains(document.activeElement)).toBe(true)

    await act(async () => {
      root.render(
        <StrictMode>
          <Drawer open mode="docked" id="test-open-transition" label="Test open transition" onClose={onClose}>
            <button type="button">Action</button>
          </Drawer>
        </StrictMode>
      )
      await flushEffects()
    })
    const aside = container.querySelector<HTMLElement>("aside")
    expect(aside?.inert).toBe(false)
    expect(aside?.contains(document.activeElement)).toBe(true)
  })
})
