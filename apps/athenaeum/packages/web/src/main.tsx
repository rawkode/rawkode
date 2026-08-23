import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { App } from "./App.js"
import "./design-system/tokens.css"
import "./design-system/fonts.css"
import "./design-system/base.css"
import "./AppShell.css"
import "./app.css"
import "./design-system/variant-paper.css"
import "./design-system/variant-study.css"

// Design-review prototypes (docs/design-review-2026-08-22.md): opt-in only.
// Without ?variant=… the data-variant attribute is never set and both variant
// stylesheets are fully inert, so the default app renders exactly as before.
const variantParam = new URLSearchParams(window.location.search).get("variant")
if (variantParam === "paper" || variantParam === "study") {
  document.documentElement.dataset.variant = variantParam
}

const rootEl = document.getElementById("root")
if (!rootEl) throw new Error("#root element not found")

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
