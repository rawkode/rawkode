import type { AppTheme } from "./theme.js"

/**
 * Version of the document contract given to an App's client bundle.
 *
 * The client still runs in an opaque `sandbox="allow-scripts"` iframe. This contract only gives
 * it a predictable canvas and semantic tokens; it does not add a parent bridge, same-origin
 * access, or any additional capability. Bump this when the shape or semantics of the public
 * `--athenaeum-*` variables change.
 */
export const APP_SANDBOX_DOCUMENT_VERSION = 1

export interface AppSandboxDocumentOptions {
  readonly clientJsUrl: string
  readonly bootstrapScript: string
  readonly theme: AppTheme
}

const themeTokens: Record<AppTheme, string> = {
  dark: `
    color-scheme: dark;
    --athenaeum-canvas: oklch(16% 0.02 220);
    --athenaeum-surface: oklch(20% 0.021 220);
    --athenaeum-surface-raised: oklch(24.5% 0.022 220);
    --athenaeum-text: oklch(93% 0.02 75);
    --athenaeum-text-muted: oklch(72% 0.018 75);
    --athenaeum-text-faint: oklch(60% 0.014 75);
    --athenaeum-border: oklch(42% 0.024 220);
    --athenaeum-border-strong: oklch(54% 0.026 220);
    --athenaeum-accent: oklch(74% 0.135 200);
    --athenaeum-accent-soft: oklch(21% 0.03 200);
    --athenaeum-on-accent: oklch(15% 0.03 200);
  `,
  paper: `
    color-scheme: light;
    --athenaeum-canvas: oklch(97.3% 0.007 85);
    --athenaeum-surface: oklch(98.8% 0.004 85);
    --athenaeum-surface-raised: oklch(100% 0 0);
    --athenaeum-text: oklch(30% 0.015 250);
    --athenaeum-text-muted: oklch(40% 0.015 250);
    --athenaeum-text-faint: oklch(48% 0.012 250);
    --athenaeum-border: oklch(89% 0.012 85);
    --athenaeum-border-strong: oklch(58% 0.02 85);
    --athenaeum-accent: oklch(48% 0.085 200);
    --athenaeum-accent-soft: oklch(95.5% 0.02 200);
    --athenaeum-on-accent: oklch(98.5% 0.005 200);
  `
}

// `srcDoc` is an HTML document, so URLs in attributes must be escaped independently of the JS
// escaping used by `buildAppSandboxBootstrapScript`. Encoding `&` as `&amp;` is intentional: the
// browser decodes it back to the query separator before requesting the script.
const escapeHtmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

const escapeScriptClose = (value: string): string => value.replaceAll(/<\/script/gi, "<\\/script")

/**
 * Builds the stable HTML shell around an App's client code.
 *
 * App authors can rely on `document.documentElement.dataset.athenaeumTheme`, the
 * `--athenaeum-*` semantic variables, and `#app-root` being a full-height, padded canvas. The
 * shell intentionally contains no remote stylesheet or inline event handler: the App remains a
 * classic script loaded after the credentialed fetch bootstrap and keeps the same opaque origin.
 */
export const buildAppSandboxDocument = ({ clientJsUrl, bootstrapScript, theme }: AppSandboxDocumentOptions): string => {
  const scheme = theme === "paper" ? "light" : "dark"
  return `<!doctype html>
<html lang="en" data-athenaeum-theme="${theme}" data-athenaeum-contract="${APP_SANDBOX_DOCUMENT_VERSION}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="${scheme}">
    <style>
      :root {
        ${themeTokens[theme]}
        --athenaeum-radius: 10px;
        --athenaeum-space: 0.75rem;
      }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { min-width: 0; min-height: 100%; }
      body {
        margin: 0;
        background: var(--athenaeum-canvas);
        color: var(--athenaeum-text);
        font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      #app-root { min-height: 100dvh; padding: clamp(0.75rem, 2vw, 1.5rem); }
      button, input, select, textarea { font: inherit; }
      button { cursor: pointer; }
      a { color: var(--athenaeum-accent); }
      :focus-visible { outline: 2px solid var(--athenaeum-accent); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
      }
    </style>
  </head>
  <body>
    <div id="app-root"></div>
    <script>${escapeScriptClose(bootstrapScript)}</script>
    <script src="${escapeHtmlAttribute(clientJsUrl)}"></script>
  </body>
</html>`
}
