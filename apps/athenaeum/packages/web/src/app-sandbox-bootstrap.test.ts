import { describe, expect, it } from "vitest"
import { buildAppSandboxBootstrapScript, rewriteFetchTarget } from "./app-sandbox-bootstrap.js"

const RUN_BASE = "/api/workspace/w1/apps/a1/run"

describe("rewriteFetchTarget", () => {
  it("rewrites a bare relative path (no leading slash) to the run-base URL with the token attached", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "increment")).toBe(
      "/api/workspace/w1/apps/a1/run/increment?token=tok.en"
    )
  })

  it("rewrites an absolute-path relative fetch (leading slash) the same way", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "/increment")).toBe(
      "/api/workspace/w1/apps/a1/run/increment?token=tok.en"
    )
  })

  it("preserves the App's own query string, appending the token with '&'", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "/echo?value=hello")).toBe(
      "/api/workspace/w1/apps/a1/run/echo?value=hello&token=tok.en"
    )
  })

  it("URL-encodes a token containing reserved characters", () => {
    expect(rewriteFetchTarget(RUN_BASE, "a b&c", "/x")).toBe("/api/workspace/w1/apps/a1/run/x?token=a%20b%26c")
  })

  it("never rewrites an absolute http(s) URL — returns undefined so the caller leaves it untouched", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "https://example.com/third-party")).toBeUndefined()
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "http://example.com/third-party")).toBeUndefined()
  })

  it("never rewrites a protocol-relative URL", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "//example.com/third-party")).toBeUndefined()
  })

  it("handles a bare root path", () => {
    expect(rewriteFetchTarget(RUN_BASE, "tok.en", "")).toBe("/api/workspace/w1/apps/a1/run/?token=tok.en")
  })
})

describe("buildAppSandboxBootstrapScript", () => {
  it("embeds runBaseUrl and token via JSON.stringify, verbatim in the generated source", () => {
    const script = buildAppSandboxBootstrapScript(RUN_BASE, "tok.en")
    expect(script).toContain(JSON.stringify(RUN_BASE))
    expect(script).toContain(JSON.stringify("tok.en"))
  })

  it("patches window.fetch and never touches Request objects, by source inspection", () => {
    const script = buildAppSandboxBootstrapScript(RUN_BASE, "tok.en")
    expect(script).toContain("window.fetch = function")
    expect(script).toContain("input instanceof Request")
  })

  it("escapes a literal </script sequence inside an embedded value so it can never close the tag early", () => {
    const token = "</script><script>alert(1)</script>"
    const script = buildAppSandboxBootstrapScript(RUN_BASE, token)
    // The raw, un-escaped "<" immediately followed by "/script" (case-insensitive) must never
    // appear anywhere in the rendered output — every occurrence must have been split apart by the
    // inserted backslash.
    expect(/<\/script/i.test(script)).toBe(false)
    // The token's actual VALUE still round-trips correctly through the JS string literal: parsing
    // `TOKEN`'s quoted source back as JSON (the standard "<\/script" -> "/" un-escape every JS
    // engine performs) reconstructs the original token exactly, so nothing about the credential
    // itself was corrupted by the defense-in-depth escape.
    const match = /var TOKEN = ("(?:[^"\\]|\\.)*");/.exec(script)
    expect(match).not.toBeNull()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(JSON.parse(match![1]!)).toBe(token)
  })
})
