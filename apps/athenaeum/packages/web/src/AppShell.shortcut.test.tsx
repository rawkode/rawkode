/** @vitest-environment happy-dom */

import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let routeLocation = { pathname: "/notes", search: "" }

vi.mock("./WorkspaceSwitcher.js", () => ({
  WorkspaceSwitcher: () => <div data-workspace-switcher />
}))

vi.mock("./SearchBox.js", () => ({
  SearchBox: () => <div data-search-box />
}))

vi.mock("./design-system/Drawer.js", () => ({
  Drawer: ({ children, id, open }: { readonly children: ReactNode; readonly id: string; readonly open: boolean }) => (
    <section data-drawer={id} data-open={String(open)}>{children}</section>
  )
}))

vi.mock("./CommandPalette.js", () => ({
  CommandPalette: ({ open }: { readonly open: boolean }) => (
    <>
      <output data-command-palette-state>{open ? "open" : "closed"}</output>
      {open && <input data-command-palette-input aria-label="Palette search" />}
    </>
  )
}))

vi.mock("react-router", () => ({
  NavLink: ({
    children,
    className,
    onClick,
    to
  }: {
    readonly children: ReactNode
    readonly className: string | ((state: { readonly isActive: boolean }) => string)
    readonly onClick?: () => void
    readonly to: string
  }) => (
    <a className={typeof className === "function" ? className({ isActive: to === "/notes" }) : className} href={to} onClick={onClick}>
      {children}
    </a>
  ),
  Outlet: () => (
    <div data-route-outlet>
      <textarea data-route-composer aria-label="Draft message" />
      <div contentEditable role="textbox" data-route-editor aria-label="Daily note editor" suppressContentEditableWarning>
        <span data-route-editor-child>Draft note</span>
      </div>
    </div>
  ),
  useLocation: () => routeLocation
}))

import { AppShell } from "./AppShell.js"

const roots: Array<{ readonly root: Root; readonly host: HTMLDivElement }> = []
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const renderShell = async (root: Root): Promise<void> => {
  await act(async () => {
    root.render(
      <AppShell
        session={{
          email: "writer@example.com",
          credential: "test-credential",
          issuedAt: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-08-29T00:00:00.000Z"
        }}
        activeWorkspaceId={"00000000-0000-4000-8000-000000000001" as never}
        onSwitchWorkspace={() => undefined}
        onSignOut={() => undefined}
        chat={<p>Agent work</p>}
      />
    )
    await flush()
  })
}

const mount = async (): Promise<HTMLDivElement> => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.push({ root, host })
  await renderShell(root)
  return host
}

const rerenderShell = async (): Promise<void> => {
  const latest = roots.at(-1)
  if (latest === undefined) throw new Error("Expected a mounted AppShell")
  await renderShell(latest.root)
}

const pressPaletteShortcut = async (modifier: "metaKey" | "ctrlKey"): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", [modifier]: true, bubbles: true, cancelable: true }))
    await flush()
  })
}

const pressShortcutOn = async (
  target: HTMLElement,
  key: string,
  modifier: "metaKey" | "ctrlKey"
): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { key, [modifier]: true, bubbles: true, cancelable: true })
  await act(async () => {
    target.dispatchEvent(event)
    await flush()
  })
  return event
}

const pressEscapeOn = async (target: HTMLElement): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
  await act(async () => {
    target.dispatchEvent(event)
    await flush()
  })
  return event
}

afterEach(() => {
  for (const { root, host } of roots.splice(0)) {
    act(() => root.unmount())
    host.remove()
  }
  delete reactActEnvironment.IS_REACT_ACT_ENVIRONMENT
})

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  routeLocation = { pathname: "/notes", search: "" }
})

describe("AppShell command palette shortcut", () => {
  it("skips workspace chrome to the route content", async () => {
    const host = await mount()
    const shell = host.querySelector<HTMLElement>(".shell-container")
    const skipLink = host.querySelector<HTMLAnchorElement>(".shell-skip-link")
    const content = host.querySelector<HTMLDivElement>("#athenaeum-main-content")

    expect(shell?.firstElementChild).toBe(skipLink)
    expect(skipLink?.textContent).toBe("Skip to workspace content")
    expect(skipLink?.getAttribute("href")).toBe("#athenaeum-main-content")
    expect(content?.tabIndex).toBe(-1)

    await act(async () => {
      skipLink?.click()
      await flush()
    })

    expect(document.activeElement).toBe(content)
  })

  it("announces completed pathname changes without announcing daily-note queries", async () => {
    const host = await mount()
    const announcement = host.querySelector<HTMLElement>('[role="status"][aria-live="polite"]')

    expect(announcement?.getAttribute("aria-atomic")).toBe("true")
    expect(announcement?.textContent).toBe("")

    routeLocation = { pathname: "/notes", search: "?date=2026-08-29" }
    await rerenderShell()
    expect(announcement?.textContent).toBe("")

    routeLocation = { pathname: "/graph", search: "" }
    await rerenderShell()
    expect(announcement?.textContent).toBe("Opened Graph.")
  })

  it("labels valid selected daily notes without treating malformed dates as history", async () => {
    const host = await mount()
    const routeTitle = () => host.querySelector(".shell-mainbar-title")?.textContent

    expect(routeTitle()).toBe("Today")

    routeLocation = { pathname: "/notes", search: "?date=2026-08-29" }
    await rerenderShell()
    expect(routeTitle()).toBe("Daily note")

    routeLocation = { pathname: "/notes", search: "?date=2026-02-31" }
    await rerenderShell()
    expect(routeTitle()).toBe("Today")
  })

  it.each(["metaKey", "ctrlKey"] as const)("toggles the palette with %s", async (modifier) => {
    const host = await mount()
    const paletteState = () => host.querySelector<HTMLOutputElement>("[data-command-palette-state]")?.textContent

    expect(paletteState()).toBe("closed")

    await pressPaletteShortcut(modifier)
    expect(paletteState()).toBe("open")

    await pressPaletteShortcut(modifier)
    expect(paletteState()).toBe("closed")
  })

  it.each(["metaKey", "ctrlKey"] as const)("does not hijack %s shortcuts from a writing control", async (modifier) => {
    const host = await mount()
    const paletteState = () => host.querySelector<HTMLOutputElement>("[data-command-palette-state]")?.textContent
    const composer = host.querySelector<HTMLTextAreaElement>("[data-route-composer]")
    const editorChild = host.querySelector<HTMLElement>("[data-route-editor-child]")

    expect(composer).not.toBeNull()
    expect(editorChild).not.toBeNull()

    const paletteEvent = await pressShortcutOn(composer as HTMLTextAreaElement, "k", modifier)
    expect(paletteEvent.defaultPrevented).toBe(false)
    expect(paletteState()).toBe("closed")

    const chatEvent = await pressShortcutOn(editorChild as HTMLElement, "j", modifier)
    expect(chatEvent.defaultPrevented).toBe(false)
    expect(host.querySelector("[data-drawer='athenaeum-agent-chat']")?.getAttribute("data-open")).toBe("false")
  })

  it.each(["metaKey", "ctrlKey"] as const)("keeps the open palette’s %s toggle and Escape available from its search field", async (modifier) => {
    const host = await mount()
    const paletteState = () => host.querySelector<HTMLOutputElement>("[data-command-palette-state]")?.textContent

    await pressPaletteShortcut(modifier)
    const paletteInput = host.querySelector<HTMLInputElement>("[data-command-palette-input]")
    expect(paletteState()).toBe("open")
    expect(paletteInput).not.toBeNull()

    const toggleEvent = await pressShortcutOn(paletteInput as HTMLInputElement, "k", modifier)
    expect(toggleEvent.defaultPrevented).toBe(true)
    expect(paletteState()).toBe("closed")

    await pressPaletteShortcut(modifier)
    const reopenedPaletteInput = host.querySelector<HTMLInputElement>("[data-command-palette-input]")
    const escapeEvent = await pressEscapeOn(reopenedPaletteInput as HTMLInputElement)
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(paletteState()).toBe("closed")
  })

  it("advertises the supported palette and agent modifiers", async () => {
    const host = await mount()
    const hints = Array.from(host.querySelectorAll("kbd")).map((hint) => hint.textContent)

    expect(hints).toEqual(expect.arrayContaining(["⌘K / Ctrl K", "⌘J / Ctrl J"]))
  })

  it("keeps the sidebar focused on workspace navigation", async () => {
    const host = await mount()

    expect(host.querySelector(".shell-sidebar [data-search-box]")).toBeNull()
    expect(host.querySelector(".shell-search-input")).toBeNull()
    expect(host.querySelector(".shell-search-toggle")).not.toBeNull()
  })
})
