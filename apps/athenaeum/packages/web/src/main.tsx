import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { App } from "./App.js"
import "./design-system/tokens.css"
import "./design-system/fonts.css"
import "./design-system/base.css"
import "./design-system/primitives.css"
import "./AppShell.css"
import "./app.css"
import "./design-system/variant-paper.css"
import "./design-system/visual-variants.css"

import { applyTheme, getInitialTheme } from "./theme.js"
import { bootstrapVisualVariant } from "./visual-variant.js"
import { VisualVariantSynchronizer } from "./VisualVariantSynchronizer.js"

// Apply the persisted/system choice before React paints the shell. This avoids a dark-to-paper
// flash on launch and keeps the paper treatment an intentional, reversible mode rather than a
// separate prototype URL.
applyTheme(getInitialTheme())
bootstrapVisualVariant()

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element not found")

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <VisualVariantSynchronizer />
      <App />
    </BrowserRouter>
  </StrictMode>
)
