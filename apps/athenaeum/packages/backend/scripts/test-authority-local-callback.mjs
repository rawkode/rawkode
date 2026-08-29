import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { verifyAuthorityLocalCallback } from "./verify-authority-local-callback.mjs"

const fixture = mkdtempSync(join(tmpdir(), "athenaeum-authority-callback-"))
const root = join(fixture, "src")
mkdirSync(root, { recursive: true })
const files = {
  "authority-local-command-registry.ts": `import type { LocalMutationCapability } from "./workspace-local-mutation-capability.js"\nimport { AUTHORITY_LOCAL_COMMANDS } from "./authority-local-commands.js"\nexport const authorityLocalCommandRegistry = Object.freeze({ get: (kind: string) => AUTHORITY_LOCAL_COMMANDS.find((entry) => entry.kind === kind)?.handler })`,
  "authority-local-commands.ts": `export const AUTHORITY_LOCAL_COMMANDS = [] as const`,
  "workspace-local-mutation-capability.ts": `export type LocalMutationCapability = Readonly<Record<string, never>>`,
  "workspace-mutation-authority-internal.ts": `export const executeMutationAuthorityWithRegistry = () => undefined`,
  "workspace-mutation-authority.ts": `import { executeMutationAuthorityWithRegistry } from "./workspace-mutation-authority-internal"\nexport const executeUnwiredMutationAuthority = executeMutationAuthorityWithRegistry`
}
for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source)

try {
  assert.doesNotThrow(() => verifyAuthorityLocalCallback(root), "extensionless wrapper import should be allowed")

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
