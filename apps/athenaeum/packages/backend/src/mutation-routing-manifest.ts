/**
 * Source-verified routing inventory for the public Workspace RPC mutation surface, including
 * credential minting even though it does not itself persist workspace application state.
 * `createNode`, `createNodeWithIntent`, `acceptChatFork`, `acceptPageProposal`, `decideAgentChangeProposal`, `applySupertag`,
 * `addFact`, `createRelationDefinition`, `createEdge`, `createTag`, `syncNoteReferences`, `defineTagField`, `assignTag`, `unassignTag`, `linkCalendarEventToNode`, `createBookmark`, and `appendTranscriptSegment` are ledger routes. Every other entry is deliberately a
 * direct bypass until it receives its own compatible command contract; this manifest prevents
 * silently implying that the ledger governs mutations it does not yet govern.
 * `loroPageSyncMessage` is a direct protocol route only for empty convergence/reset frames: its
 * server boundary rejects nonempty content frames, and user content belongs to the ledgered
 * `commitLoroPageContent` command. The legacy web `syncLoroPageWithServer` helper, where present,
 * is therefore an unsupported raw-compatibility transport rather than a user-content writer.
 */
export const WORKSPACE_MUTATION_ROUTING = {
  createNode: "ledger",
  createNodeWithIntent: "ledger",
  createPage: "direct", createLoroPage: "ledger", applyPageEdit: "direct", startPageSync: "direct", pageSyncMessage: "direct",
  forkChatEdit: "direct", applyChatForkEdit: "direct", acceptChatFork: "ledger", revertChatFork: "direct",
  proposePageEdit: "direct", acceptPageProposal: "ledger", revertPageProposal: "direct",
  addFact: "ledger", createRelationDefinition: "ledger", createEdge: "ledger", createTag: "ledger", updateTag: "ledger",
  syncNoteReferences: "ledger", assignTag: "ledger", unassignTag: "ledger", defineTagField: "ledger", applySupertag: "ledger",
  rotateEpoch: "direct", createChat: "direct", sendChatMessage: "direct", mergeChanges: "direct", revertChanges: "direct", decideAgentChangeProposal: "ledger",
  createApp: "direct", updateAppCode: "direct", deleteApp: "direct",
  mintAppRunCredential: "direct",
  migrateLegacyPage: "ledger", commitLoroPageContent: "ledger", prepareMeetingInDailyNote: "ledger", startLoroPageSync: "direct", loroPageSyncMessage: "direct",
  addCollaborator: "direct", removeCollaborator: "direct", createShareLink: "direct", redeemShareLink: "direct", revokeShareLink: "direct",
  connectGoogleCalendar: "direct", googleCalendarOAuthCallback: "direct", disconnectGoogleCalendar: "direct", syncGoogleCalendar: "direct",
  linkCalendarEventToNode: "ledger", createBookmark: "ledger",
  startMeeting: "ledger", endMeeting: "direct", appendTranscriptSegment: "ledger",
  importWorkout: "direct", importWorkouts: "direct",
  startVoiceSession: "direct", endVoiceSession: "direct", openVoiceAudioSession: "direct", sendVoiceAudioChunk: "direct",
  commitVoiceAudioAndRespond: "direct", closeVoiceAudioSession: "direct",
  appRunHttp: "direct"
} as const

/** The semantic Loro page writers share one Workspace-actor gateway. Keeping this explicit next
 * to the broader routing inventory prevents a future direct route from quietly bypassing the
 * custody, command, side-effect, and post-commit cache contract. */
export const WORKSPACE_LORO_GATEWAY_OPERATIONS = [
  "createLoroPage",
  "commitLoroPageContent",
  "migrateLegacyPage",
  "prepareMeetingInDailyNote",
  "workforce.ensureLoroPage"
] as const

/**
 * Generated-source inventory for the NLE migration.  `declared*` values on an ingress request
 * are evidence only; the future Workspace authority boundary resolves ActorContext itself.
 * Temporary compatibility entries are intentionally noisy: every semantic bypass has an owner,
 * migration package, and sunset rather than becoming an accidental permanent exception.
 */
export type MutationIngressDisposition = "strict" | "temporary-compatibility" | "protocol-compatibility" | "system-bootstrap" | "test-dev-only" | "read-only" | "non-semantic"
export type MutationIngressEntry = Readonly<{
  id: string; adapter: "workspace-rpc" | "user-do" | "worker-fetch" | "do-alarm" | "service-sink" | "migration-root" | "tool"
  symbol: string; disposition: MutationIngressDisposition; owner: "workspace-ledger" | "identity" | "platform" | "test"
  stateEffect: "semantic-mutation" | "delivery" | "bootstrap" | "read" | "non-semantic"
  actorContext: "required" | "system" | "none"; rationale: "required" | "derived" | "not-applicable"
  replay: "workspace-request-id" | "protocol" | "none"; recipient: "workspace" | "user" | "worker" | "external" | "none"
  migration?: "NLE-01"; sunset?: "2026-12-31"
}>
const protocolCompatibility = new Set(["startPageSync", "pageSyncMessage", "startLoroPageSync", "loroPageSyncMessage"])
const compatibility = (symbol: string): MutationIngressEntry => ({ id: `workspace-rpc:${symbol}`, adapter: "workspace-rpc", symbol, disposition: protocolCompatibility.has(symbol) ? "protocol-compatibility" : "temporary-compatibility", owner: "workspace-ledger", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: protocolCompatibility.has(symbol) ? "protocol" : "workspace-request-id", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" })
const strict = (symbol: string): MutationIngressEntry => ({ ...compatibility(symbol), disposition: "strict", migration: undefined, sunset: undefined })
// Deliberately conservative: every exported service boundary is treated as a semantic write sink
// until a later package proves it read-only. This prevents new repository/service writes escaping.
export const SERVICE_WRITE_SINKS = ["AgentLoroEditService", "AgentEditService", "AppRuntimeService", "AppsService", "CalendarService", "ChatForkService", "GraphService", "LedgerService", "LoroPageService", "MeetingsService", "NotesService", "PageProposalService", "SharingService", "StandupPublicationService", "SyncFeedService", "VoiceSessionService", "ViewsService", "WorkoutsService"] as const
const serviceSink = (symbol: string): MutationIngressEntry => ({ id: `service-sink:${symbol}`, adapter: "service-sink", symbol, disposition: "temporary-compatibility", owner: "workspace-ledger", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: "workspace-request-id", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" })
export const DIRECT_WRITE_SINK_FILES = ["agent-change-proposal-collections.ts", "agent-edit-service-live.ts", "apps-repository-live.ts", "apps-service-live.ts", "automerge-probe-durable-object.ts", "calendar-concierge-executor.ts", "calendar-concierge-grant-store.ts", "calendar-service-live.ts", "dev-auth.ts", "edges-repository-live.ts", "facts-repository-live.ts", "fts-probe-durable-object.ts", "graph-issues-repository-live.ts", "graph-service-live.ts", "ledger-service.ts", "loro-page-service-live.ts", "meetings-service-live.ts", "mention-seed.ts", "nodes-repository-live.ts", "nodes-subscription.ts", "notes-service-live.ts", "page-proposal-service-live.ts", "pages-repository-live.ts", "read-model.ts", "realtime-voice-client-openai.ts", "relation-definitions-repository-live.ts", "seed-base-tag-fields.ts", "seed-base-tags.ts", "sharing-service-live.ts", "sync-feed-service-live.ts", "tag-closure.ts", "tags-repository-live.ts", "user-durable-object.ts", "voice-session-service-live.ts", "workforce-run-authority.ts", "workforce-runtime-store.ts", "workspace-durable-object.ts", "workspace-ownership.ts", "workout-seed.ts", "workouts-service-live.ts"] as const
export const AGENT_TOOL_DEFINITIONS = ["ReadNote", "EditNote", "CreateNode", "AddFact", "AddEdge", "LinkCalendarEvent", "CreateApp", "UpdateAppCode", "DefineSupertag", "ApplySupertag"] as const
const directSink = (symbol: string): MutationIngressEntry => ({ id: `direct-storage:${symbol}`, adapter: "service-sink", symbol, disposition: "temporary-compatibility", owner: "workspace-ledger", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: "workspace-request-id", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" })
const toolDefinition = (symbol: string): MutationIngressEntry => ({ id: `tool-definition:${symbol}`, adapter: "tool", symbol, disposition: "temporary-compatibility", owner: "workspace-ledger", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: "workspace-request-id", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" })
const bootstrap = (symbol: string): MutationIngressEntry => ({ id: `bootstrap:${symbol}`, adapter: "migration-root", symbol, disposition: "system-bootstrap", owner: "platform", stateEffect: "bootstrap", actorContext: "system", rationale: "derived", replay: "none", recipient: "workspace" })
export const MUTATION_INGRESS_REGISTRY: readonly MutationIngressEntry[] = [
  ...Object.entries(WORKSPACE_MUTATION_ROUTING).map(([symbol, route]) => route === "ledger" ? strict(symbol) : compatibility(symbol)),
  { id: "user-do:createWorkspace", adapter: "user-do", symbol: "UserRpcApi.createWorkspace", disposition: "temporary-compatibility", owner: "identity", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: "none", recipient: "user", migration: "NLE-01", sunset: "2026-12-31" },
  { id: "worker-fetch:default", adapter: "worker-fetch", symbol: "Worker.fetch", disposition: "temporary-compatibility", owner: "platform", stateEffect: "semantic-mutation", actorContext: "required", rationale: "required", replay: "none", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" },
  { id: "do-alarm:workforce-runtime", adapter: "do-alarm", symbol: "WorkspaceDurableObject.alarm", disposition: "system-bootstrap", owner: "platform", stateEffect: "delivery", actorContext: "system", rationale: "derived", replay: "workspace-request-id", recipient: "workspace" },
  ...SERVICE_WRITE_SINKS.map(serviceSink),
  ...DIRECT_WRITE_SINK_FILES.map(directSink),
  ...AGENT_TOOL_DEFINITIONS.map(toolDefinition),
  ...["ensureBaseTagsSeeded", "ensureBaseTagFieldsSeeded", "ensureMentionRelationSeeded", "ensureWorkoutTagsSeeded", "WorkspaceDurableObject.initializeOwner"].map(bootstrap),
  { id: "migration-root:legacy-page", adapter: "migration-root", symbol: "migrateLegacyPage", disposition: "temporary-compatibility", owner: "workspace-ledger", stateEffect: "semantic-mutation", actorContext: "system", rationale: "derived", replay: "workspace-request-id", recipient: "workspace", migration: "NLE-01", sunset: "2026-12-31" },
  { id: "test-dev-only:scripted-calendar", adapter: "service-sink", symbol: "DevScriptedCalendarClient", disposition: "test-dev-only", owner: "test", stateEffect: "non-semantic", actorContext: "none", rationale: "not-applicable", replay: "none", recipient: "none" }
] as const
