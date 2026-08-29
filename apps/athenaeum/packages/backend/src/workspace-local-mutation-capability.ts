/**
 * The only capability a Stage 1A local mutation handler receives.
 *
 * This module intentionally contains no Worker, Durable Object, Effect, network, clock, or
 * cryptographic dependency. The authority kernel owns the surrounding transaction and gives a
 * handler only synchronous local projection primitives plus typed outbox staging.
 */
export type StagedMutationIntent = Readonly<{ recipient: string; payload: unknown }>
export type LocalMutationCapability = Readonly<{
  readLocal: (key: string) => unknown
  writeLocal: (key: string, value: unknown) => void
  deleteLocal: (key: string) => void
  stageIntent: (intent: StagedMutationIntent) => void
}>

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
  stageIntent: LocalMutationCapability["stageIntent"]
): LocalMutationCapability => {
  const safeRead: LocalMutationCapability["readLocal"] = (key) => {
    const value = readLocal(key)
    return value === undefined ? undefined : freezeLocalMutationInput(value)
  }
  const safeWrite: LocalMutationCapability["writeLocal"] = (key, value) => writeLocal(key, freezeLocalMutationInput(value))
  const safeStage: LocalMutationCapability["stageIntent"] = (intent) => stageIntent(freezeLocalMutationInput(intent))
  const capability = Object.create(null) as Record<string, unknown>
  Object.defineProperties(capability, {
    readLocal: { value: safeRead, enumerable: true, configurable: false, writable: false },
    writeLocal: { value: safeWrite, enumerable: true, configurable: false, writable: false },
    deleteLocal: { value: deleteLocal, enumerable: true, configurable: false, writable: false },
    stageIntent: { value: safeStage, enumerable: true, configurable: false, writable: false }
  })
  return Object.freeze(capability) as LocalMutationCapability
}
