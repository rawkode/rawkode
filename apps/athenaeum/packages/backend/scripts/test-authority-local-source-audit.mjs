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
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = import('./helper.js')", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /dynamic import/
)
assert.throws(
  () => auditLocalHandlerGraph({ "/entry.ts": "const x = require('./helper.js')", "/helper.ts": "export const x = 1" }, ["/entry.ts"]),
  /require/
)
assert.doesNotThrow(() => auditLocalHandlerGraph({ "/entry.ts": "const text = 'Promise.resolve(1)'" }, ["/entry.ts"]))
assert.doesNotThrow(() => auditLocalHandlerGraph({ "/entry.ts": "const x = () => { const Promise = 1; return Promise }; export { x }" }, ["/entry.ts"]), "lexical shadowing is local")
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
assert.throws(() => auditLocalHandlerGraph({ "/entry.ts": "export { x } from './helper.js'", "/helper.ts": "const alias = fetch; export const x = alias" }, ["/entry.ts"]), /forbidden|unresolved/)
console.log("authority local source audit fixtures verified")
