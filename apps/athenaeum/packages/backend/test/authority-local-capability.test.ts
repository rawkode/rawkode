import { describe, expect, it } from "vitest"
import { decodeTrustedDataToken } from "../src/authority-trusted-data-token.js"
import { createScopedLocalMutationCapability, materializeLocalMutationResult } from "../src/workspace-local-mutation-capability.js"

describe("local authority callback confinement", () => {
  it("commits only a capability-issued token and revokes retained capability", () => {
    const local = new Map<string, unknown>()
    const scope = createScopedLocalMutationCapability({ readLocal: (key) => local.get(key), writeLocal: (key, value) => local.set(key, value), deleteLocal: (key) => local.delete(key), stageIntent: () => {} })
    const payload = decodeTrustedDataToken('{"ok":true}')
    scope.begin(); scope.capability.writeLocal("x", payload)
    const result = scope.capability.issueResult(payload)
    expect(materializeLocalMutationResult(result)).toEqual({ ok: true })
    scope.revoke()
    expect(() => scope.capability.writeLocal("late", payload)).toThrow(/no longer executing/)
    expect(local.has("late")).toBe(false)
  })

  it("does not invoke traps, thenables, generators, or iterators while rejecting unissued output", () => {
    let traps = 0
    const proxy = new Proxy({}, { get: () => { traps += 1; throw new Error("trap") } })
    expect(() => materializeLocalMutationResult(proxy)).toThrow(/capability-issued/)
    expect(() => materializeLocalMutationResult({ get then() { traps += 1; return undefined } })).toThrow(/capability-issued/)
    expect(() => materializeLocalMutationResult((function* () { traps += 1 })())).toThrow(/capability-issued/)
    expect(traps).toBe(0)
  })

  it("rejects unissued payload tokens and reentrant invocation", () => {
    const scope = createScopedLocalMutationCapability({ readLocal: () => undefined, writeLocal: () => {}, deleteLocal: () => {}, stageIntent: () => {} })
    scope.begin()
    expect(() => scope.capability.writeLocal("x", {} as never)).toThrow(/unissued/)
    expect(() => scope.begin()).toThrow(/not idle/)
    scope.revoke()
  })
})
