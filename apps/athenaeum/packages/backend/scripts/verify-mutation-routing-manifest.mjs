import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { assertKnownDirectWriteSinks, assertNoUnknownWorkerEntrypoints } from "./mutation-ingress-discovery.mjs"

const backendRoot = fileURLToPath(new URL("..", import.meta.url))
const source = readFileSync(new URL("../src/workspace-durable-object.ts", import.meta.url), "utf8")
const manifest = readFileSync(new URL("../src/mutation-routing-manifest.ts", import.meta.url), "utf8")
const policy = readFileSync(new URL("../src/mutation-ingress-policy-fixtures.ts", import.meta.url), "utf8")
const evaluate = (source, name) => { const out = {}; const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; new Function("exports", "require", js)(out, () => { throw new Error(`unexpected import in ${name}`) }); return out }
const manifestExports = evaluate(manifest, "manifest"), policyExports = evaluate(policy, "policy")
const registry = manifestExports.MUTATION_INGRESS_REGISTRY
const rpcStart = source.indexOf("class WorkspaceRpcApi extends RpcTarget")
const rpcEnd = source.indexOf("export class WorkspaceDurableObject")
if (rpcStart < 0 || rpcEnd < 0 || rpcEnd <= rpcStart) {
  throw new Error(`cannot locate WorkspaceRpcApi RPC surface (root ${backendRoot})`)
}

// Start from every Cap'n Web method rather than guessing from mutation-name prefixes. A new public
// method is treated as a mutation unless it is consciously added to this small read-only inventory,
// making an unfamiliar verb such as `activate…` or `loro…` fail closed in the manifest audit.
const rpcSource = source.slice(rpcStart, rpcEnd)
const names = [...rpcSource.matchAll(/^  async (\w+)\(/gm)].map((match) => match[1])
const readOnlyRpcMethods = new Set([
  "whoami", "listNodes", "getNode", "subscribeToNodes", "getPageDocumentDescriptor", "getLegacyPageProjection", "getPageText",
  "previewPageProposal", "chatForkPreview", "listBacklinks", "listGraphIssues", "listTags", "listTagClosure",
  "listTagFields", "runView", "searchNodes", "syncFeed", "listChats", "getChat", "listChatChanges",
  "listPendingChanges", "listApps", "getApp", "getAppCode", "previewRemoveCollaborator", "previewRevokeShareLink",
  "listCollaborators", "listShareLinks", "listCalendarEvents", "listGatekeeperBindings", "getTodayBrief", "listBookmarks", "getMeeting",
  "listMeetings", "listWorkoutImports", "listWorkouts", "getWorkout", "pollVoiceAudioEvents", "listRecentLedgerActivity", "listStandupPublications",
  // A historical endpoint which now throws before decoding input. It has no manifest entry and
  // cannot mutate; retaining it briefly produces a typed upgrade error for stale clients.
  "activateLoroPage"
])
const actual = names.filter((name) => !readOnlyRpcMethods.has(name))
const listed = Object.keys(manifestExports.WORKSPACE_MUTATION_ROUTING).filter((name) => name !== "appRunHttp")
const missing = actual.filter((name) => !listed.includes(name))
const stale = listed.filter((name) => !actual.includes(name))
if (missing.length || stale.length) {
  throw new Error(`mutation-routing manifest drift; missing=[${missing}] stale=[${stale}] (root ${backendRoot})`)
}
const ledgerRoutes = ["createNode", "createNodeWithIntent", "createLoroPage", "acceptChatFork", "acceptPageProposal", "addFact", "createRelationDefinition", "createEdge", "createTag", "syncNoteReferences", "assignTag", "unassignTag", "defineTagField", "applySupertag", "decideAgentChangeProposal", "migrateLegacyPage", "commitLoroPageContent", "prepareMeetingInDailyNote", "linkCalendarEventToNode", "createBookmark", "appendTranscriptSegment", "startMeeting"]
if (ledgerRoutes.some((name) => manifestExports.WORKSPACE_MUTATION_ROUTING[name] !== "ledger") || Object.values(manifestExports.WORKSPACE_MUTATION_ROUTING).filter((route) => route === "ledger").length !== ledgerRoutes.length) {
  throw new Error(`ledger routing manifest must contain exactly ${ledgerRoutes.join(", ")}`)
}
// NLE-00 fails closed: all discovery surfaces and every Workspace RPC entry must be represented.
// The concrete registry derives one row per RPC from the checked-in routing map; no dynamic
// dispatch/write sink is accepted without a declared adapter/policy row and a migration sunset.
for (const adapter of ["workspace-rpc", "user-do", "worker-fetch", "do-alarm", "service-sink", "migration-root", "tool"]) {
  if (!policyExports.REQUIRED_MUTATION_DISCOVERY_ADAPTERS.includes(adapter) || !registry.some((row) => row.adapter === adapter)) throw new Error(`mutation ingress registry missing ${adapter} discovery adapter`)
}
if (registry.some((row) => row.stateEffect === "semantic-mutation" && row.disposition !== "strict" && (!row.migration || !row.sunset))) {
  throw new Error("mutation ingress registry must map every semantic compatibility route with migration and sunset")
}
if (/\[\s*[^\]]*\]\s*\[.*(?:symbol|method|route)/.test(manifest)) throw new Error("unknown dynamic mutation dispatch is forbidden")
const userSource = readFileSync(new URL("../src/user-durable-object.ts", import.meta.url), "utf8")
const userRpc = userSource.slice(userSource.indexOf("class UserRpcApi extends RpcTarget"), userSource.indexOf("export class UserDurableObject"))
const userMethods = [...userRpc.matchAll(/^  async (\w+)\(/gm)].map((match) => match[1])
for (const method of userMethods) {
  if (method === "createWorkspace" && !registry.some((row) => row.adapter === "user-do" && row.symbol === "UserRpcApi.createWorkspace")) throw new Error(`unmapped User DO mutation: ${method}`)
  if (method !== "createWorkspace" && !["listWorkspaces"].includes(method)) throw new Error(`unknown User DO RPC entrypoint: ${method}`)
}
const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
if (!registry.some((row) => row.adapter === "worker-fetch" && row.symbol === "Worker.fetch")) throw new Error("unknown Worker fetch entrypoint")
assertNoUnknownWorkerEntrypoints(worker)
const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url))
// Stage 1A's unwired authority kernel and the dormant private standup publisher deliberately own
// in-memory registries, capability objects, and transaction doubles. Their `.set`/`.delete`/
// `Object.create` calls are not direct persistence sinks; the transitive source audit is the
// separate guard for every actual repository/SQLite writer.
const authorityContractOnly = new Set([
  "authority-kernel-contract.ts",
  "authority-local-command-registry.ts",
  "authority-trusted-data-token.ts",
  "standup-publication-collections.ts",
  "standup-publication-service-live.ts",
  "workspace-local-mutation-capability.ts",
  "workspace-mutation-authority.ts"
])
for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"))) {
  const contents = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
  for (const match of contents.matchAll(/export class (\w+Service) extends Context\.Tag/g)) if (!registry.some((row) => row.adapter === "service-sink" && row.symbol === match[1])) throw new Error(`unmapped service write sink: ${match[1]}`)
  if (/\basync alarm\(/.test(contents)) throw new Error(`unknown Durable Object alarm entrypoint in ${file}; add a concrete registry row`)
}
assertKnownDirectWriteSinks(Object.fromEntries(readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts") && !authorityContractOnly.has(name)).map((file) => [file, readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")])), registry.filter((row) => row.id.startsWith("direct-storage:")).map((row) => row.symbol))
const agentTools = readFileSync(new URL("../../domain/src/agent-tools.ts", import.meta.url), "utf8")
for (const match of agentTools.matchAll(/export class (\w+)ToolInput/g)) if (!registry.some((row) => row.adapter === "tool" && row.symbol === match[1])) throw new Error(`unknown agent tool definition: ${match[1]}`)
console.log(`mutation-routing manifest verified (${actual.length} public mutations)`)
