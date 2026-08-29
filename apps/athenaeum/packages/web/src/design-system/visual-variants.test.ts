import { describe, expect, it } from "vitest"
import mainSource from "../main.tsx?raw"
import appShellSource from "../AppShell.tsx?raw"
import drawerSource from "./Drawer.tsx?raw"
import visualVariantSource from "../visual-variant.ts?raw"
import synchronizerSource from "../VisualVariantSynchronizer.tsx?raw"
import notesRouteSource from "../routes/NotesRoute.tsx?raw"
import dailyNoteSource from "../DailyNote.tsx?raw"
import legacyPaperCss from "./variant-paper.css?raw"
import variantsCss from "./visual-variants.css?raw"

const blockFor = (variant: "paper" | "study"): string => {
  const start = variantsCss.indexOf(`html[data-visual-variant="${variant}"] {`)
  const end = variantsCss.indexOf("}\n", start)
  return variantsCss.slice(start, end)
}

const legacyRootSelectors = [...legacyPaperCss
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .matchAll(/html\[data-variant(?:="paper")?\][^{,\n]*/g)]
  .map(([selector]) => selector.trim())

const legacySelectorMatchesVisualRoot = (selector: string, visualVariant: "paper" | "study"): boolean => {
  const rootAttributes = new Map([
    ["data-variant", "paper"],
    ["data-visual-variant", visualVariant],
  ])

  return rootAttributes.has("data-variant")
    && (!selector.includes('[data-variant="paper"]') || rootAttributes.get("data-variant") === "paper")
    && (!selector.includes(":not([data-visual-variant])") || !rootAttributes.has("data-visual-variant"))
}

describe("visual variant CSS boundary", () => {
  it("is loaded last and leaves the no-query shell contract untouched", () => {
    expect(mainSource.lastIndexOf('import "./design-system/visual-variants.css"')).toBeGreaterThan(mainSource.lastIndexOf('import "./design-system/variant-paper.css"'))
    expect(mainSource).toContain("applyTheme(getInitialTheme())\nbootstrapVisualVariant()")
    expect(mainSource).toContain("<VisualVariantSynchronizer />")
    expect(appShellSource).toContain("<Drawer")
    expect(appShellSource).toContain('className="ds-disclosure shell-account-menu"')
    expect(appShellSource).toContain('className="shell-account-actions"')
    expect(drawerSource).toContain("<dialog")
    expect(drawerSource).toContain("showModal")
    expect(variantsCss).not.toMatch(/display:\s*none/)
    expect(notesRouteSource).toContain("<DailyNote")
    expect(notesRouteSource).toContain("<TodayBrief")
    expect(dailyNoteSource).toContain('className="daily-note"')
  })

  it("uses exact visual-variant selector gates and never resurrects stale prototype chrome", () => {
    for (const selector of variantsCss.matchAll(/html[^\{]+\{/g)) {
      expect(selector[0]).toMatch(/data-visual-variant="(?:paper|study)"/)
    }
    expect(variantsCss).not.toMatch(/html\[data-variant/)
    expect(variantsCss).not.toContain("shell-chat-scrim")
    expect(variantsCss).not.toContain("daily-note-eyebrow")
  })

  it("prevents every legacy Paper rule from matching either visual prototype", () => {
    expect(legacyRootSelectors).not.toHaveLength(0)

    for (const selector of legacyRootSelectors) {
      expect(selector).toContain(":not([data-visual-variant])")
      for (const visualVariant of ["paper", "study"] as const) {
        expect(legacySelectorMatchesVisualRoot(selector, visualVariant), `${selector} must not match ${visualVariant}`).toBe(false)
      }
    }
  })

  it("keeps the persisted Paper agent trigger in the current main-bar contract", () => {
    expect(legacyPaperCss).toMatch(/html\[data-variant\]:not\(\[data-visual-variant\]\) \.shell-chat-toggle \{[^}]*position:\s*static[^}]*right:\s*auto[^}]*bottom:\s*auto/)
    expect(legacyPaperCss).not.toMatch(/html\[data-variant\]:not\(\[data-visual-variant\]\) \.shell-chat-toggle \{[^}]*position:\s*fixed/)
  })

  it("defines the complete status-token set without relying on legacy Paper", () => {
    const statusTokens = [
      "--color-danger",
      "--color-danger-muted",
      "--color-danger-border",
      "--color-danger-text-strong",
      "--color-success",
      "--color-success-muted",
      "--color-warning",
      "--color-warning-muted",
      "--color-warning-border",
    ]

    for (const visualVariant of ["paper", "study"] as const) {
      const block = blockFor(visualVariant)
      for (const token of statusTokens) {
        expect(block, `${visualVariant} defines ${token}`).toMatch(new RegExp(`${token}:\\s*[^;]+;`))
      }
    }
  })

  it("styles only current structural classes while preserving the dialog drawer contract", () => {
    for (const currentClass of [
      "daily-note-editor",
      "daily-note-header h1",
      "notes-context-column",
      "today-brief",
      "backlinks",
      "daily-note-standup",
      "shell-mainbar",
      "shell-nav-core-item",
      "sync-status-synced",
      "shell-chat-toggle",
      "ProseMirror[data-empty=\"true\"]::before"
    ]) {
      expect(variantsCss).toContain(currentClass)
    }
    expect(variantsCss).not.toMatch(/\.shell-sidebar\s*\{[^}]*\b(?:position|transform|inset)\s*:/)
  })

  it("does not give the visual layer persistence or navigation authority", () => {
    for (const forbidden of ["localStorage", "matchMedia", "history", "cookie"]) {
      expect(visualVariantSource).not.toContain(forbidden)
      expect(synchronizerSource).not.toContain(forbidden)
    }
    expect(synchronizerSource).toContain("useLayoutEffect")
    expect(synchronizerSource).not.toMatch(/return\s*\(\)\s*=>/)
  })

  it("has a deterministic persisted-theme by visual-prototype token matrix", () => {
    const expected = {
      paper: { scheme: "light", ground: "oklch(97.3% 0.007 var(--hue-paper))", text: "oklch(30% 0.015 var(--hue-ink))" },
      study: { scheme: "dark", ground: "oklch(16% 0.02 var(--hue-neutral))", text: "oklch(93% 0.02 var(--hue-warm))" }
    } as const

    for (const persistedTheme of ["dark", "paper"] as const) {
      for (const visualVariant of ["paper", "study"] as const) {
        const tokens = expected[visualVariant]
        const block = blockFor(visualVariant)
        expect(block, `${persistedTheme} x ${visualVariant}`).toContain(`color-scheme: ${tokens.scheme}`)
        expect(block, `${persistedTheme} x ${visualVariant}`).toContain(`--color-ground: ${tokens.ground}`)
        expect(block, `${persistedTheme} x ${visualVariant}`).toContain(`--color-text: ${tokens.text}`)
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: visible workspace form`).toContain(".workspace-switcher-create")
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: Backlinks uses its own disclosure`).not.toContain(".link-form")
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: non-floating current toggle`).toMatch(/\.shell-chat-toggle\s*\{[\s\S]*?position:\s*static/)
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: overlay restoration`).toMatch(/\.shell-chat\s*\{[\s\S]*?position:\s*fixed[\s\S]*?inset:\s*0 0 0 auto[\s\S]*?transform:\s*translateX\(100%\)/)
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: open drawer restoration`).toMatch(/\.shell-chat\.drawer-open\s*\{\s*transform:\s*translateX\(0\)/)
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: desktop dock grid restoration`).toMatch(/@media \(min-width: 78rem\)[\s\S]*?\.shell-chat-visible\s*\{[\s\S]*?grid-template-columns:\s*var\(--shell-sidebar-w\) minmax\(0, 1fr\) var\(--shell-chat-w\)/)
        expect(variantsCss, `${persistedTheme} x ${visualVariant}: desktop dock restoration`).toMatch(/@media \(min-width: 78rem\)[\s\S]*?\.shell-chat-visible \.shell-chat\s*\{[\s\S]*?position:\s*relative[\s\S]*?inset:\s*auto[\s\S]*?transform:\s*none[\s\S]*?z-index:\s*auto/)
      }
    }
  })
})
