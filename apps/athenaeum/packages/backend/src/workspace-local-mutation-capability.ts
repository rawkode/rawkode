/**
 * The only capability a Stage 1A local mutation handler receives.
 *
 * This module intentionally contains no Worker, Durable Object, Effect, network, clock, or
 * cryptographic dependency. The authority kernel owns the surrounding transaction and gives a
 * handler only synchronous local projection primitives plus typed outbox staging.
 */
import { decodeTrustedDataToken, trustedDataValue, type TrustedDataToken } from "./authority-trusted-data-token.js"
export type StagedMutationIntent = Readonly<{ recipient: string; payload: TrustedDataToken }>
export const localMutationResultToken = Symbol("athenaeum.localMutationResultToken")
export type LocalMutationCapability = Readonly<{
  readLocal: (key: string) => TrustedDataToken | undefined
  writeLocal: (key: string, value: TrustedDataToken) => void
  deleteLocal: (key: string) => void
  stageIntent: (intent: StagedMutationIntent) => void
  issueResult: (value: unknown) => LocalMutationResultToken
}>
export type LocalMutationResultToken = Readonly<{ readonly [localMutationResultToken]: true }>
export type LocalMutationCapabilityScope = Readonly<{
  capability: LocalMutationCapability
  begin: () => void
  revoke: () => void
}>

const resultValues = new WeakMap<object, unknown>()
const makeResultToken = (value: unknown): LocalMutationResultToken => {
  value = trustedDataValue(value)
  const token = Object.create(null) as Record<PropertyKey, unknown>
  Object.defineProperty(token, localMutationResultToken, { value: true, enumerable: false, configurable: false, writable: false })
  const frozen = Object.freeze(token) as LocalMutationResultToken
  resultValues.set(frozen, value)
  return frozen
}
export const materializeLocalMutationResult = <T>(value: unknown): T => {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || !resultValues.has(value)) throw new Error("local mutation handler must return a capability-issued result token")
  return freezeLocalMutationInput(resultValues.get(value)) as T
}
export const isLocalMutationResultToken = (value: unknown): value is LocalMutationResultToken => value !== null && (typeof value === "object" || typeof value === "function") && resultValues.has(value)

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Clone JSON-shaped values into null-prototype, recursively frozen values. */
export const freezeLocalMutationInput = <T>(value: T): T => {
  const active = new Set<object>()
  const clone = (current: unknown): unknown => {
    if (!isObject(current)) {
      if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol" || current === undefined) throw new Error("local mutation values must be JSON-shaped")
      if (typeof current === "number" && !Number.isFinite(current)) throw new Error("local mutation numbers must be finite")
      return current
    }
    if (!Array.isArray(current) && !isPlainObject(current)) throw new Error("local mutation values must be plain JSON objects")
    if (active.has(current)) throw new Error("local mutation values cannot contain cycles")
    active.add(current)
    let result: unknown
    if (Array.isArray(current)) result = Object.freeze(current.map(clone))
    else {
      const output = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(current)) output[key] = clone(current[key])
      result = Object.freeze(output)
    }
    active.delete(current)
    return result
  }
  return clone(value) as T
}

/** Build a null-prototype, non-extensible capability with immutable method slots. */
export const createLocalMutationCapability = (
  readLocal: LocalMutationCapability["readLocal"],
  writeLocal: LocalMutationCapability["writeLocal"],
  deleteLocal: LocalMutationCapability["deleteLocal"],
  stageIntent: LocalMutationCapability["stageIntent"],
  lifecycle: { active?: boolean; executing?: boolean } = {}
): LocalMutationCapability => {
  const assertLive = () => { if (lifecycle.active === false || lifecycle.executing === false) throw new Error("local mutation capability is no longer active") }
  const safeRead: LocalMutationCapability["readLocal"] = (key) => {
    assertLive()
    const value = readLocal(key)
    return value === undefined ? undefined : decodeTrustedDataToken(JSON.stringify(freezeLocalMutationInput(value)))
  }
  const safeWrite: LocalMutationCapability["writeLocal"] = (key, value) => { assertLive(); writeLocal(key, trustedDataValue(value)) }
  const safeDelete: LocalMutationCapability["deleteLocal"] = (key) => { assertLive(); deleteLocal(key) }
  const safeStage: LocalMutationCapability["stageIntent"] = (intent) => { assertLive(); stageIntent(freezeLocalMutationInput({ recipient: intent.recipient, payload: trustedDataValue(intent.payload) })) }
  const issueResult: LocalMutationCapability["issueResult"] = (value) => { assertLive(); return makeResultToken(value) }
  const capability = Object.create(null) as Record<string, unknown>
  Object.defineProperties(capability, {
    readLocal: { value: safeRead, enumerable: true, configurable: false, writable: false },
    writeLocal: { value: safeWrite, enumerable: true, configurable: false, writable: false },
    deleteLocal: { value: safeDelete, enumerable: true, configurable: false, writable: false },
    issueResult: { value: issueResult, enumerable: true, configurable: false, writable: false },
    stageIntent: { value: safeStage, enumerable: true, configurable: false, writable: false }
  })
  return Object.freeze(capability) as LocalMutationCapability
}

export const createScopedLocalMutationCapability = (
  readLocal: LocalMutationCapability["readLocal"],
  writeLocal: LocalMutationCapability["writeLocal"],
  deleteLocal: LocalMutationCapability["deleteLocal"],
  stageIntent: LocalMutationCapability["stageIntent"]
): LocalMutationCapabilityScope => {
  const state = { active: true, executing: false }
  const capability = createLocalMutationCapability(readLocal, writeLocal, deleteLocal, stageIntent, state)
  return Object.freeze({
    capability,
    begin: () => { if (!state.active || state.executing) throw new Error("local mutation capability is not idle"); state.executing = true },
    revoke: () => { state.executing = false; state.active = false }
  })
}
