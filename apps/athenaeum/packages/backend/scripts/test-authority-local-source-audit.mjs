import assert from "node:assert/strict"
import { auditLocalHandlerGraph } from "./authority-local-source-audit.mjs"

assert.deepEqual(
  auditLocalHandlerGraph(
    { "/entry.ts": "export { value } from './helper.js'", "/helper.ts": "export const value = 1" },
    ["/entry.ts"]
  ).sort(),
  ["/entry.ts", "/helper.ts"]
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "export { value } from './helper.js'", "/helper.ts": "export function value() { return Promise.resolve(1) }" }, ["/entry.ts"]),
  /Promise/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "import './helper.js'", "/helper.ts": "export { x } from './entry.js'" }, ["/entry.ts"]),
  /cycle/
)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "import './missing.js'" }, ["/entry.ts"]), /unresolved/)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "import { digestCanonicalV2 } from '@athenaeum/domain'; export { digestCanonicalV2 }" }, ["/entry.ts"]), /nonlocal/)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "export function x() { return import('./helper.js') }", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /dynamic import/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "export function x() { return require('./helper.js') }", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /require/
)
assert.doesNotThrow(() => auditLocalHandlerGraph({ "/entry.ts": "const text = 'Promise.resolve(1)'" }, ["/entry.ts"]))
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = () => { const Promise = 1; return Promise }; export { x }" }, ["/entry.ts"]),
  /forbidden/,
  "reserved ambient spellings remain forbidden even when locally shadowed"
)
assert.doesNotThrow(
  () => auditLocalHandlerGraph({ "/entry.ts": "export function x() { return Object.keys(JSON.parse('{\\\"safe\\\":true}')) }" }, ["/entry.ts"]),
  "curated JSON/Object calls remain available for trusted data"
)
for (const source of [
  "let retained; export function handler() { return retained }",
  "const retained: unknown[] = []; export function handler() { return retained }"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /mutable module state/)
for (const source of [
  "export function x() { return globalThis }",
  "export function x() { return Date.now() }",
  "export function x() { return Reflect.get({}, 'x') }",
  "export function x() { return Object.constructor }",
  "export function x() { return queueMicrotask(() => {}) }",
  "export function x() { return Atomics.waitAsync }",
  "export function x() { return eval('1') }",
  "export function x() { return Function('return 1') }"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /forbidden|unresolved/)
for (const source of [
  "export const handler = () => { void (async () => { await 0 })() }",
  "export async function handler() { return 1 }",
  "export function* handler() { yield 1 }",
  "export async function handler() { for await (const value of values) {} }"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /suspending|for-await/)
for (const source of [
  "export function x() { return Object.getPrototypeOf({}) }",
  "export function x() { return Object.getOwnPropertyDescriptor({}, 'constructor') }",
  "export function x() { const key = 'get' + 'PrototypeOf'; return Object[key]({}) }",
  "export function x() { const entries = Object.entries; return entries({}) }",
  "export function x() { return Object.entries(Object) }",
  "export function x() { return Object.values(Object) }",
  "export function x() { return Array.isArray(Array) }"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /forbidden|computed/)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "export const handler = (Object: unknown) => Object.entries({})" }, ["/entry.ts"]),
  /may not shadow pure intrinsic/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "export const handler = () => { for (const Object of []) return Object.entries({}) }" }, ["/entry.ts"]),
  /may not shadow pure intrinsic/
)
for (const source of [
  "export function x() { const { 'constructor': C } = capability.readLocal; return C('return globalThis')() }",
  "export function x() { const { prototype: P } = capability.readLocal; return P }",
  "export function x() { const { __proto__: P } = capability.readLocal; return P }",
  "export function x() { const { call: C } = capability.readLocal; return C }",
  "export function x() { const { constructor } = capability.readLocal; return constructor }",
  "export const handler = ({ 'bind': B }: Record<string, unknown>) => B",
  "export function x() { ({ 'apply': A } = capability.readLocal); return A }",
  "export function x() { const { [key]: C } = capability.readLocal; return C }",
  "export function x() { ({ [key]: C } = capability.readLocal); return C }"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /forbidden|computed/)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "export { x } from './helper.js'", "/helper.ts": "export function x() { const alias = fetch; return alias }" }, ["/entry.ts"]), /forbidden|unresolved/)
console.log("authority local source audit fixtures verified")
