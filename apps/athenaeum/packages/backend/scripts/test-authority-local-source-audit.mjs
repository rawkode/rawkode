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
console.log("authority local source audit fixtures verified")
