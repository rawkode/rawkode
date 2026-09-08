import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyAuthorityLocalCallback } from "./verify-authority-local-callback.mjs"

const baseFiles = Object.freeze({
  "workspace-mutation-authority.ts": [
    'import { registry } from "./authority-local-command-registry.js"',
    'import { execute } from "./workspace-mutation-authority-internal.js"',
    'export * from "./authority-kernel-contract.js"',
    "export const wrapper = [registry, execute]"
  ].join("\n"),
  "workspace-mutation-authority-internal.ts": [
    'import { domain } from "@athenaeum/domain"',
    'import { token } from "./authority-trusted-data-token.js"',
    'import { capability } from "./workspace-local-mutation-capability.js"',
    'import { contract } from "./authority-kernel-contract.js"',
    "export const execute = [domain, token, capability, contract]"
  ].join("\n"),
  "authority-kernel-contract.ts": 'import { domain } from "@athenaeum/domain"\nexport const contract = domain',
  "workspace-local-mutation-capability.ts": 'import { token } from "./authority-trusted-data-token.js"\nexport const capability = token',
  "authority-trusted-data-token.ts": "export const token = 1",
  "authority-local-command-registry.ts": 'import { AUTHORITY_LOCAL_COMMANDS } from "./authority-local-commands.js"\nexport const registry = AUTHORITY_LOCAL_COMMANDS',
  "authority-local-commands.ts": "export const AUTHORITY_LOCAL_COMMANDS = Object.freeze([])"
})

const fixture = (overrides = {}, extra = {}) => {
  const root = mkdtempSync(join(tmpdir(), "athenaeum-authority-dag-"))
  try {
    for (const [name, source] of Object.entries({ ...baseFiles, ...overrides, ...extra })) {
      const path = join(root, name)
      writeFileSync(path, source)
    }
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

const withFixture = (overrides, extra, run) => {
  const current = fixture(overrides, extra)
  try { return run(current.root) } finally { current.dispose() }
}

assert.doesNotThrow(() => withFixture({}, {}, (root) => verifyAuthorityLocalCallback(root)), "wrapper -> internal/kernel and internal -> kernel are the only shared runtime paths")

for (const [name, source, pattern] of [
  ["rogue-wrapper", 'import "./workspace-mutation-authority.js"', /unwired authority wrapper/],
  ["rogue-core", 'import "./workspace-mutation-authority-internal.js"', /authority core/],
  ["rogue-kernel", 'import "./authority-kernel-contract.js"', /authority kernel/]
]) {
  assert.throws(() => withFixture({}, { [`${name}.ts`]: source }, (root) => verifyAuthorityLocalCallback(root)), pattern)
}

assert.throws(
  () => withFixture({ "workspace-mutation-authority.ts": 'export const loader = import("./authority-kernel-contract.js")' }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /dynamic/
)
assert.throws(
  () => withFixture({ "workspace-mutation-authority.ts": 'const specifier = "./authority-kernel-contract.js"\nexport const loader = import(specifier)' }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /dynamic/
)
assert.throws(
  () => withFixture({ "authority-kernel-contract.ts": 'import helper = require("./authority-trusted-data-token.js")\nexport const contract = helper' }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /import-equals/
)
assert.throws(
  () => withFixture({ "workspace-mutation-authority.ts": `${baseFiles["workspace-mutation-authority.ts"]}\nimport "./helper.js"` }, { "helper.ts": "export const helper = 1" }, (root) => verifyAuthorityLocalCallback(root)),
  /unlisted authority runtime helper/
)
assert.throws(
  () => withFixture({ "workspace-mutation-authority.ts": `${baseFiles["workspace-mutation-authority.ts"]}\nimport "./missing.js"` }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /unresolved/
)
assert.throws(
  () => withFixture({ "authority-trusted-data-token.ts": 'import { capability } from "./workspace-local-mutation-capability.js"\nexport const token = capability' }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /cycle/
)
assert.throws(
  () => withFixture({ "workspace-mutation-authority-internal.ts": `${baseFiles["workspace-mutation-authority-internal.ts"]}\nimport "./workspace-mutation-authority.js"` }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /cycle/
)
assert.throws(
  () => withFixture({ "authority-kernel-contract.ts": 'import { domain } from "@athenaeum/domain"\nimport "ambient-helper"\nexport const contract = domain' }, {}, (root) => verifyAuthorityLocalCallback(root)),
  /external edges differ/
)

console.log("authority runtime DAG audit fixtures verified")
