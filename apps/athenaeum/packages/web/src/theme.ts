/** The writing surface has two intentional treatments: a quiet paper mode for long sessions
 * and the existing dark command-center mode for dense operations work. Keep the choice at the
 * shell boundary so feature routes only consume semantic color tokens. */

export type AppTheme = "dark" | "paper"

export const THEME_STORAGE_KEY = "athenaeum.theme"

type ThemeStorage = Pick<Storage, "getItem" | "setItem">

export const readStoredTheme = (storage: ThemeStorage | undefined): AppTheme | undefined => {
  if (!storage) return undefined
  try {
    const value = storage.getItem(THEME_STORAGE_KEY)
    return value === "dark" || value === "paper" ? value : undefined
  } catch {
    // Private browsing and embedded document policies can deny localStorage. Theme selection is
    // still useful for this session, so treat storage as an optional enhancement.
    return undefined
  }
}

export const themeForEnvironment = (stored: AppTheme | undefined, prefersLight: boolean): AppTheme =>
  stored ?? (prefersLight ? "paper" : "dark")

export const applyTheme = (
  theme: AppTheme,
  root: Pick<HTMLElement, "dataset"> = document.documentElement
): void => {
  root.dataset.theme = theme
  if (theme === "paper") root.dataset.variant = "paper"
  else delete root.dataset.variant
}

export const getInitialTheme = (): AppTheme => {
  if (typeof window === "undefined") return "dark"
  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    storage = undefined
  }
  const stored = readStoredTheme(storage)
  const prefersLight = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches
  return themeForEnvironment(stored, prefersLight)
}

export const persistTheme = (theme: AppTheme): void => {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Keep the active theme even when persistence is unavailable.
  }
}
