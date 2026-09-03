import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { verifyAuthorityLocalCallback } from "./verify-authority-local-callback.mjs"

const fixture = mkdtempSync(join(tmpdir(), "athenaeum-authority-callback-"))
const root = join(fixture, "src")
mkdirSync(root, { recursive: true })
const files = {
  "authority-local-command-registry.ts": `import { AUTHORITY_LOCAL_COMMANDS } from "./authority-local-commands.js"\nexport const authorityLocalCommandRegistry = AUTHORITY_LOCAL_COMMANDS`,
  "authority-local-commands.ts": `export const AUTHORITY_LOCAL_COMMANDS = Object.freeze([])`,
  "authority-trusted-data-token.ts": `export const token = 1`,
  "workspace-local-mutation-capability.ts": `import { token } from "./authority-trusted-data-token.js"\nexport const capability = token`,
  "authority-kernel-contract.ts": `import { domain } from "@athenaeum/domain"\nexport const contract = domain`,
  "workspace-mutation-authority-internal.ts": `import { domain } from "@athenaeum/domain"\nimport { token } from "./authority-trusted-data-token.js"\nimport { capability } from "./workspace-local-mutation-capability.js"\nimport { contract } from "./authority-kernel-contract.js"\nexport const executeMutationAuthorityWithRegistry = () => [domain, token, capability, contract]`,
  "workspace-mutation-authority.ts": `import { authorityLocalCommandRegistry } from "./authority-local-command-registry.js"\nimport { executeMutationAuthorityWithRegistry } from "./workspace-mutation-authority-internal"\nexport * from "./authority-kernel-contract.js"\nexport const executeUnwiredMutationAuthority = [authorityLocalCommandRegistry, executeMutationAuthorityWithRegistry]`
}
for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source)

try {
  assert.doesNotThrow(() => verifyAuthorityLocalCallback(root), "extensionless wrapper import should be allowed")

  writeFileSync(join(root, "index.ts"), `import { executeUnwiredMutationAuthority } from "./workspace-mutation-authority.js"\nexport { executeUnwiredMutationAuthority }`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /runtime root reaches unwired authority executor/)
  rmSync(join(root, "index.ts"), { force: true })

  writeFileSync(join(root, "rogue-extension.ts"), `import { executeMutationAuthorityWithRegistry } from "./workspace-mutation-authority-internal.ts"\nexport const rogue = executeMutationAuthorityWithRegistry`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /production source may import authority core/)
  rmSync(join(root, "rogue-extension.ts"), { force: true })

  writeFileSync(join(root, "rogue-normalized.ts"), `import { executeMutationAuthorityWithRegistry } from "./nested/../workspace-mutation-authority-internal"\nexport const rogue = executeMutationAuthorityWithRegistry`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /production source may import authority core/)
  rmSync(join(root, "rogue-normalized.ts"), { force: true })

  writeFileSync(join(root, "rogue-dynamic.ts"), `const core = import("./workspace-mutation-authority-internal.js")\nexport { core }`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /dynamic or disallowed production import/)
  rmSync(join(root, "rogue-dynamic.ts"), { force: true })

  writeFileSync(join(root, "rogue-computed.ts"), `const path = "./workspace-mutation-authority-internal.js"\nconst core = import(path)\nexport { core }`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /dynamic or disallowed production import/)
  rmSync(join(root, "rogue-computed.ts"), { force: true })

  writeFileSync(join(root, "rogue-equals.ts"), `import core = require("./workspace-mutation-authority-internal.js")\nexport { core }`)
  assert.throws(() => verifyAuthorityLocalCallback(root), /dynamic or disallowed production import/)
  console.log("authority local callback resolution fixtures verified")
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
