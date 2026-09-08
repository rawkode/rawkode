import { describe, expect, it } from "vitest"
import appSource from "./App.tsx?raw"
import mainSource from "./main.tsx?raw"

describe("data-router migration", () => {
  it("keeps App's nested index redirect, lazy route tree, catch-all, and visual synchronizer under one data router", () => {
    expect(mainSource).toContain("createBrowserRouter([{ path: \"*\", element: <App /> }])")
    expect(mainSource).toContain("<RouterProvider router={router} />")
    expect(mainSource).not.toContain("<BrowserRouter>")
    expect(appSource).toContain("<DailyNoteRouteTransitionProvider>")
    expect(appSource).toContain("<VisualVariantSynchronizer />")
    expect(appSource).toContain('<Route index element={<Navigate to="/notes" replace />} />')
    expect(appSource).toContain('path="*"')
    expect(appSource).toContain("<Suspense fallback={<RouteLoadingFallback />}")
  })
})
