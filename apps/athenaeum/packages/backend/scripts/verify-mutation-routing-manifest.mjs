import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const backendRoot = fileURLToPath(new URL("..", import.meta.url))
const source = readFileSync(new URL("../src/workspace-durable-object.ts", import.meta.url), "utf8")
const manifest = readFileSync(new URL("../src/mutation-routing-manifest.ts", import.meta.url), "utf8")
const names = [...source.matchAll(/^  async (\w+)\(/gm)].map((match) => match[1])
const mutationPrefixes = /^(add|create|update|delete|apply|append|assign|unassign|define|syncNote|syncGoogle|rotate|fork|accept|revert|revoke|merge|send|start|end|open|close|commit|import|connect|disconnect|redeem|remove|link|pageSync|googleCalendarOAuth|mint)/
const actual = names.filter((name) => mutationPrefixes.test(name))
const listed = [...manifest.matchAll(/\b(\w+): "(?:ledger|direct)"/g)].map((match) => match[1]).filter((name) => name !== "appRunHttp")
const missing = actual.filter((name) => !listed.includes(name))
const stale = listed.filter((name) => !actual.includes(name))
if (missing.length || stale.length) {
  throw new Error(`mutation-routing manifest drift; missing=[${missing}] stale=[${stale}] (root ${backendRoot})`)
}
if (!/createNode: "ledger"/.test(manifest) || (manifest.match(/: "ledger"/g) ?? []).length !== 1) {
  throw new Error("createNode must be the sole ledger-routed public mutation")
}
console.log(`mutation-routing manifest verified (${actual.length} public mutations)`)
