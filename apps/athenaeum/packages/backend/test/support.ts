// Shared test harness for the Phase 0 Verify-stage exit-criteria suites (request-response.test.ts,
// live-subscription.test.ts, do-recovery.test.ts). Talks to the real `WorkspaceDurableObject` the same
// way a real client would: through `src/index.ts`'s Worker `fetch` handler (never by reaching into
// DO internals directly), over a real Cap'n Web WebSocket session opened the same way
// cloudflare-os's own `workshop-backend/__integration__/open-gadget-rpc.test.ts` connects to its
// Worker in tests (`exports.default.fetch(...)` with an `Upgrade: websocket` header, then
// `socket.accept()` before handing the client end to `newWebSocketRpcSession`).

import { exports } from "cloudflare:workers"
import { newWebSocketRpcSession, type RpcStub } from "capnweb"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { decodeRpcError, EntityId, type DomainError } from "@athenaeum/domain"

/**
 * Structural client-side mirror of `WorkspaceDurableObject`'s `WorkspaceRpcApi`
 * (`src/workspace-durable-object.ts`) — the same "hand-write the interface, don't import the server
 * class" pattern `web/src/rpc-client.ts` already uses for the identical reason (Cap'n Web's own
 * README-documented convention for cross-boundary typing; also keeps this test file from
 * depending on `WorkspaceRpcApi`, a private implementation detail of the DO's own module). Extended
 * with `getNode`, added specifically for this Verify stage (see `domain/src/rpc.ts`'s
 * `GetNodeInput` doc comment).
 */
export interface WorkspaceApi {
  whoami(): Promise<unknown>

  createNode(input: unknown): Promise<unknown>
  createNodeWithIntent(input: unknown): Promise<unknown>
  listNodes(input: unknown): Promise<unknown>
  getNode(input: unknown): Promise<unknown>
  subscribeToNodes(input: unknown): Promise<NodesSubscriptionApi>

  createPage(input: unknown): Promise<unknown>
  createLoroPage(input: unknown): Promise<unknown>
  getPageText(input: unknown): Promise<unknown>
  applyPageEdit(input: unknown): Promise<unknown>
  startPageSync(input: unknown): Promise<unknown>
  pageSyncMessage(input: unknown): Promise<unknown>
  getPageDocumentDescriptor(input: unknown): Promise<unknown>
  getLegacyPageProjection(input: unknown): Promise<unknown>
  activateLoroPage(input: unknown): Promise<unknown>
  migrateLegacyPage(input: unknown): Promise<unknown>
  commitLoroPageContent(input: unknown): Promise<unknown>
  prepareMeetingInDailyNote(input: unknown): Promise<unknown>
  startLoroPageSync(input: unknown): Promise<unknown>
  loroPageSyncMessage(input: unknown): Promise<unknown>

  proposePageEdit(input: unknown): Promise<unknown>
  previewPageProposal(input: unknown): Promise<unknown>
  acceptPageProposal(input: unknown): Promise<unknown>
  revertPageProposal(input: unknown): Promise<unknown>

  forkChatEdit(input: unknown): Promise<unknown>
  applyChatForkEdit(input: unknown): Promise<unknown>
  chatForkPreview(input: unknown): Promise<unknown>
  acceptChatFork(input: unknown): Promise<unknown>
  revertChatFork(input: unknown): Promise<unknown>

  createTag(input: unknown): Promise<unknown>
  addFact(input: unknown): Promise<unknown>
  createRelationDefinition(input: unknown): Promise<unknown>
  createEdge(input: unknown): Promise<unknown>
  listBacklinks(input: unknown): Promise<unknown>
  syncNoteReferences(input: unknown): Promise<unknown>
  listGraphIssues(input: unknown): Promise<unknown>
  listTagClosure(input: unknown): Promise<unknown>
  assignTag(input: unknown): Promise<unknown>
  unassignTag(input: unknown): Promise<unknown>
  defineTagField(input: unknown): Promise<unknown>
  listTagFields(input: unknown): Promise<unknown>
  applySupertag(input: unknown): Promise<unknown>

  runView(input: unknown): Promise<unknown>
  searchNodes(input: unknown): Promise<unknown>

  syncFeed(input: unknown): Promise<unknown>
  listRecentLedgerActivity(input: unknown): Promise<unknown>
  rotateEpoch(input: unknown): Promise<unknown>

  createChat(input: unknown): Promise<unknown>
  listChats(input: unknown): Promise<unknown>
  getChat(input: unknown): Promise<unknown>
  sendChatMessage(input: unknown): Promise<unknown>
  mergeChanges(input: unknown): Promise<unknown>
  revertChanges(input: unknown): Promise<unknown>
  decideAgentChangeProposal(input: unknown): Promise<unknown>
  listChatChanges(input: unknown): Promise<unknown>
  listPendingChanges(input: unknown): Promise<unknown>

  createApp(input: unknown): Promise<unknown>
  updateAppCode(input: unknown): Promise<unknown>
  listApps(input: unknown): Promise<unknown>
  getApp(input: unknown): Promise<unknown>
  getAppCode(input: unknown): Promise<unknown>
  deleteApp(input: unknown): Promise<unknown>
  mintAppRunCredential(input: unknown): Promise<unknown>

  addCollaborator(input: unknown): Promise<unknown>
  previewRemoveCollaborator(input: unknown): Promise<unknown>
  removeCollaborator(input: unknown): Promise<unknown>
  createShareLink(input: unknown): Promise<unknown>
  redeemShareLink(input: unknown): Promise<unknown>
  previewRevokeShareLink(input: unknown): Promise<unknown>
  revokeShareLink(input: unknown): Promise<unknown>
  listCollaborators(input: unknown): Promise<unknown>
  listShareLinks(input: unknown): Promise<unknown>

  connectGoogleCalendar(input: unknown): Promise<unknown>
  googleCalendarOAuthCallback(input: unknown): Promise<unknown>
  disconnectGoogleCalendar(input: unknown): Promise<unknown>
  syncGoogleCalendar(input: unknown): Promise<unknown>
  listCalendarEvents(input: unknown): Promise<unknown>
  listGatekeeperBindings(input: unknown): Promise<unknown>
  getTodayBrief(input: unknown): Promise<unknown>
  linkCalendarEventToNode(input: unknown): Promise<unknown>
  createBookmark(input: unknown): Promise<unknown>
  listBookmarks(input: unknown): Promise<unknown>

  startMeeting(input: unknown): Promise<unknown>
  endMeeting(input: unknown): Promise<unknown>
  appendTranscriptSegment(input: unknown): Promise<unknown>
  getMeeting(input: unknown): Promise<unknown>
  listMeetings(input: unknown): Promise<unknown>

  startVoiceSession(input: unknown): Promise<unknown>
  endVoiceSession(input: unknown): Promise<unknown>

  importWorkout(input: unknown): Promise<unknown>
  listWorkoutImports(input: unknown): Promise<unknown>

  openVoiceAudioSession(input: unknown): Promise<unknown>
  sendVoiceAudioChunk(input: unknown): Promise<unknown>
  commitVoiceAudioAndRespond(input: unknown): Promise<unknown>
  pollVoiceAudioEvents(input: unknown): Promise<unknown>
  closeVoiceAudioSession(input: unknown): Promise<unknown>
}

/** Mirrors `backend`'s `NodesSubscription` RPC-facing surface. */
export interface NodesSubscriptionApi {
  next(): Promise<unknown>
}

/** Structural client-side mirror of `UserDurableObject`'s `UserRpcApi`
 *  (`src/user-durable-object.ts`) — same hand-write-the-interface convention as `WorkspaceApi` above. */
export interface UserApi {
  createWorkspace(input: unknown): Promise<unknown>
  listWorkspaces(input: unknown): Promise<unknown>
}

/** A fresh, schema-valid workspace id for one test — every test gets its own workspace (hence its own
 *  `WorkspaceDurableObject` instance, per `getByName`) so tests never see each other's nodes. */
export const freshWorkspaceId = (): EntityId => Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())

export const freshNodeId = (): EntityId => Schema.decodeUnknownSync(EntityId)(crypto.randomUUID())

/**
 * Opens a real WebSocket-transport Cap'n Web session against `workspaceId`'s `WorkspaceDurableObject`,
 * routed through the real Worker `fetch` handler exactly as `router`/a browser client would hit
 * it in production (`GET /api/workspace/:workspaceId` with `Upgrade: websocket`) — not a shortcut into DO
 * internals. WebSocket transport (rather than HTTP batch) is used for every RPC call in this test
 * suite, including plain request/response ones: `newWorkersRpcResponse` handles both uniformly
 * (see `workspace-durable-object.ts`'s own doc comment), and a single long-lived session is what lets
 * one test both drive `createNode`/`listNodes` *and* open a `subscribeToNodes` stub without a
 * second connection.
 */
export const connectToWorkspace = async (workspaceId: EntityId): Promise<RpcStub<WorkspaceApi>> => {
  const response = await exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}`, {
      headers: { Upgrade: "websocket" }
    })
  )
  if (response.status !== 101) {
    throw new Error(`Expected a WebSocket upgrade (101), got ${response.status}: ${await response.text()}`)
  }
  const socket = response.webSocket
  if (!socket) throw new TypeError("Expected a WebSocket response.")
  socket.accept()
  return newWebSocketRpcSession<WorkspaceApi>(socket)
}

/**
 * Like `connectToWorkspace`, but also hands back the raw `WebSocket` transport underneath the Cap'n
 * Web session — Cap'n Web's `RpcStub` doesn't expose its own transport, so a test that needs to
 * force the connection closed directly (bypassing the stub's `[Symbol.dispose]()`/release
 * protocol, to simulate an abrupt client crash rather than a clean disconnect) needs the socket
 * kept alongside the stub, not reachable through it.
 */
export const connectToWorkspaceWithSocket = async (
  workspaceId: EntityId
): Promise<{ stub: RpcStub<WorkspaceApi>; socket: WebSocket }> => {
  const response = await exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}`, {
      headers: { Upgrade: "websocket" }
    })
  )
  if (response.status !== 101) {
    throw new Error(`Expected a WebSocket upgrade (101), got ${response.status}: ${await response.text()}`)
  }
  const socket = response.webSocket
  if (!socket) throw new TypeError("Expected a WebSocket response.")
  socket.accept()
  return { stub: newWebSocketRpcSession<WorkspaceApi>(socket), socket }
}

/**
 * `POST /api/dev/sign-in` against the real Worker entrypoint (`index.ts#handleDevSignIn`) — real
 * HTTP, real HMAC signing (`dev-auth.ts`), real `UserDurableObject.ensureProfile` round trip, not
 * a shortcut into either module's internals. Used by every test in `dev-auth.test.ts` and
 * `revocation-eviction.test.ts` that needs a real, distinct authenticated identity.
 */
export const devSignIn = async (
  email: string
): Promise<{ credential: string; email: string; issuedAt: string; expiresAt: string }> => {
  const response = await exports.default.fetch(
    new Request("https://athenaeum.invalid/api/dev/sign-in", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    })
  )
  if (response.status !== 200) {
    throw new Error(`Expected 200 from /api/dev/sign-in, got ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

/**
 * Like `connectToWorkspaceWithSocket`, but presents `credential` (from `devSignIn`) as a Bearer
 * `Authorization` header on the WebSocket upgrade request — real callers that can set arbitrary
 * headers (native clients, this test suite) use this path; `dev-auth.ts#extractBearerCredential`'s
 * own doc comment covers the browser `?token=` fallback this helper deliberately does not need.
 */
export const connectToWorkspaceWithSocketAs = async (
  workspaceId: EntityId,
  credential: string
): Promise<{ stub: RpcStub<WorkspaceApi>; socket: WebSocket }> => {
  const response = await exports.default.fetch(
    new Request(`https://athenaeum.invalid/api/workspace/${workspaceId}`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` }
    })
  )
  if (response.status !== 101) {
    throw new Error(`Expected a WebSocket upgrade (101), got ${response.status}: ${await response.text()}`)
  }
  const socket = response.webSocket
  if (!socket) throw new TypeError("Expected a WebSocket response.")
  socket.accept()
  return { stub: newWebSocketRpcSession<WorkspaceApi>(socket), socket }
}

/** Authenticated convenience connection for tests of routes that require a real actor. Keep the
 * existing `connectToWorkspace` helper anonymous because several suites explicitly test denial. */
export const connectToWorkspaceAsTestUser = async (workspaceId: EntityId): Promise<RpcStub<WorkspaceApi>> => {
  const { credential } = await devSignIn(`workspace-test-${crypto.randomUUID()}@example.com`)
  return (await connectToWorkspaceWithSocketAs(workspaceId, credential)).stub
}

/**
 * Opens a real WebSocket-transport Cap'n Web session against the caller's own `/api/user` route
 * (`UserDurableObject#fetch()`), presenting `credential` (from `devSignIn`) as a Bearer
 * `Authorization` header — the mandatory-auth counterpart to `connectToWorkspaceWithSocketAs`. Used
 * by `test/user-workspace-catalog.test.ts`.
 */
export const connectToUserAs = async (
  credential: string
): Promise<{ stub: RpcStub<UserApi>; socket: WebSocket }> => {
  const response = await exports.default.fetch(
    new Request("https://athenaeum.invalid/api/user", {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${credential}` }
    })
  )
  if (response.status !== 101) {
    throw new Error(`Expected a WebSocket upgrade (101), got ${response.status}: ${await response.text()}`)
  }
  const socket = response.webSocket
  if (!socket) throw new TypeError("Expected a WebSocket response.")
  socket.accept()
  return { stub: newWebSocketRpcSession<UserApi>(socket), socket }
}

/** `POST /api/user` (HTTP-batch transport, no WebSocket) as `credential` — used by the "rejects a
 *  request with no credential at all" / "credential from a different account" negative tests,
 *  which only need a plain status-code assertion, not a live session. */
export const fetchUserRoute = (request: Request): Promise<Response> => exports.default.fetch(request)

/** Fresh `WorkspaceDurableObject` native-RPC stub, for calling `evictSessions` directly — the same
 *  `ctx.exports.WorkspaceDurableObject.getByName(workspaceId)` shape `index.ts`'s own fetch handler uses,
 *  reused here since `evictSessions` is deliberately not exposed over Cap'n Web (see its own doc
 *  comment in `workspace-durable-object.ts`). */
export const workspaceDurableObjectStub = (workspaceId: EntityId) => exports.WorkspaceDurableObject.getByName(workspaceId)

/** Recovers the typed `DomainError` a Cap'n Web call rejected with, exactly as `web/src/
 *  rpc-client.ts`'s `domainErrorFromThrown` does — parses the thrown `Error#message` as the
 *  `{tag, message, data}` envelope `backend/src/rpc-boundary.ts` throws, and decodes it through
 *  `@athenaeum/domain`'s `decodeRpcError`. Throws (fails the test) if the rejection isn't a
 *  well-formed envelope — an opaque/generic `Error` reaching this point would itself be the bug
 *  the exit criterion cares about ("surfaced correctly... not as opaque failures"). */
export const rejectionToDomainError = async (promise: Promise<unknown>): Promise<DomainError> => {
  try {
    await promise
  } catch (thrown) {
    if (!(thrown instanceof Error)) {
      throw new TypeError(`Expected the RPC call to reject with an Error, got: ${String(thrown)}`)
    }
    const parsed: unknown = JSON.parse(thrown.message)
    return Effect.runPromise(decodeRpcError(parsed))
  }
  throw new Error("Expected the RPC call to reject, but it resolved.")
}

/** Polls `predicate` until it's true or `timeoutMs` elapses, for asserting on async
 *  instrumentation state (e.g. `subscriptionLifecycle.disposed`) that updates on its own schedule
 *  relative to the action that triggers it (an abrupt disconnect, a DO reset). */
export const waitUntil = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
