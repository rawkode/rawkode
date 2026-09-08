/** Opaque, module-issued JSON data. Callers can carry tokens but cannot mint or inspect them. */
const values = new WeakMap<object, unknown>()
const freezeJson = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw new Error("trusted data must be JSON-shaped")
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("trusted data numbers must be finite")
    return value
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value)) throw new Error("trusted data must be plain JSON")
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson))
  const output = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value)) output[key] = freezeJson(value[key as keyof typeof value])
  return Object.freeze(output)
}
export type TrustedDataToken = Readonly<Record<never, never>>
export const decodeTrustedDataToken = (json: string): TrustedDataToken => {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error("trusted data is not valid JSON") }
  const token = Object.freeze(Object.create(null))
  values.set(token, freezeJson(value))
  return token as TrustedDataToken
}
export const trustedDataValue = <T>(token: unknown): T => {
  if ((typeof token !== "object" && typeof token !== "function") || token === null || !values.has(token)) throw new Error("unissued trusted data token")
  return values.get(token) as T
}
