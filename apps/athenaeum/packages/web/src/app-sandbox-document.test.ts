import { describe, expect, it } from "vitest"
import { buildAppSandboxDocument, APP_SANDBOX_DOCUMENT_VERSION } from "./app-sandbox-document.js"

const CLIENT_URL = "/api/workspace/w1/apps/a1/client.js?v=2&token=tok.en"
const BOOTSTRAP = "window.__appBootstrap = true"

describe("buildAppSandboxDocument", () => {
  it("provides a versioned, viewport-aware app canvas with the selected theme contract", () => {
    const document = buildAppSandboxDocument({ clientJsUrl: CLIENT_URL, bootstrapScript: BOOTSTRAP, theme: "paper" })

    expect(document).toContain(`data-athenaeum-contract="${APP_SANDBOX_DOCUMENT_VERSION}"`)
    expect(document).toContain('data-athenaeum-theme="paper"')
    expect(document).toContain('name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"')
    expect(document).toContain('name="color-scheme" content="light"')
    expect(document).toContain("--athenaeum-canvas:")
    expect(document).toContain("#app-root { min-height: 100dvh")
    expect(document).toContain("window.__appBootstrap = true")
  })

  it("keeps the dark contract available and decodes HTML-escaped query separators in the script URL", () => {
    const document = buildAppSandboxDocument({ clientJsUrl: CLIENT_URL, bootstrapScript: BOOTSTRAP, theme: "dark" })

    expect(document).toContain('data-athenaeum-theme="dark"')
    expect(document).toContain('name="color-scheme" content="dark"')
    expect(document).toContain('src="/api/workspace/w1/apps/a1/client.js?v=2&amp;token=tok.en"')
  })

  it("escapes script-closing sequences in the bootstrap source", () => {
    const document = buildAppSandboxDocument({
      clientJsUrl: CLIENT_URL,
      bootstrapScript: "const payload = '</SCRIPT><script>alert(1)</script>'",
      theme: "dark"
    })

    expect(document).toContain("<\\/script>")
    expect(document.match(/<\\\/script>/gi)).toHaveLength(2)
    const inlineBootstrap = document.split("<script>")[1]?.split("</script>")[0] ?? ""
    expect(/<\/script/i.test(inlineBootstrap)).toBe(false)
  })
})
