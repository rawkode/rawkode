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
  () => auditLocalHandlerGraph({ "/entry.ts": "export { value } from './helper.js'", "/helper.ts": "export const value = Promise.resolve(1)" }, ["/entry.ts"]),
  /Promise/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "import './helper.js'", "/helper.ts": "export { x } from './entry.js'" }, ["/entry.ts"]),
  /cycle/
)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "import './missing.js'" }, ["/entry.ts"]), /unresolved/)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "import { digestCanonicalV2 } from '@athenaeum/domain'; export { digestCanonicalV2 }" }, ["/entry.ts"]), /nonlocal/)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = import('./helper.js')", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /dynamic import/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = require('./helper.js')", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /require/
)
assert.doesNotThrow(() => auditLocalHandlerGraph({ "/entry.ts": "const text = 'Promise.resolve(1)'" }, ["/entry.ts"]))
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = () => { const Promise = 1; return Promise }; export { x }" }, ["/entry.ts"]),
  /forbidden/,
  "reserved ambient spellings remain forbidden even when locally shadowed"
)
assert.doesNotThrow(
  () => auditLocalHandlerGraph({ "/entry.ts": "export const x = Object.keys(JSON.parse('{\\\"safe\\\":true}'))" }, ["/entry.ts"]),
  "curated JSON/Object calls remain available for trusted data"
)
for (const source of [
  "export const x = globalThis",
  "export const x = Date.now()",
  "export const x = Reflect.get({}, 'x')",
  "export const x = Object.constructor",
  "export const x = queueMicrotask(() => {})",
  "export const x = Atomics.waitAsync",
  "export const x = eval('1')",
  "export const x = Function('return 1')"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /forbidden|unresolved/)
for (const source of [
  "export const x = Object.getPrototypeOf({})",
  "export const x = Object.getOwnPropertyDescriptor({}, 'constructor')",
  "const key = 'get' + 'PrototypeOf'; export const x = Object[key]({})",
  "const entries = Object.entries; export const x = entries({})",
  "export const x = Object.entries(Object)",
  "export const x = Object.values(Object)",
  "export const x = Array.isArray(Array)"
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
  "const { 'constructor': C } = capability.readLocal; export const x = C('return globalThis')()",
  "const { prototype: P } = capability.readLocal; export const x = P",
  "const { __proto__: P } = capability.readLocal; export const x = P",
  "const { call: C } = capability.readLocal; export const x = C",
  "const { constructor } = capability.readLocal; export const x = constructor",
  "export const handler = ({ 'bind': B }: Record<string, unknown>) => B",
  "({ 'apply': A } = capability.readLocal); export const x = A",
  "const { [key]: C } = capability.readLocal; export const x = C",
  "({ [key]: C } = capability.readLocal); export const x = C"
]) assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": source }, ["/entry.ts"]), /forbidden|computed/)
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "export { x } from './helper.js'", "/helper.ts": "const alias = fetch; export const x = alias" }, ["/entry.ts"]), /forbidden|unresolved/)
console.log("authority local source audit fixtures verified")
