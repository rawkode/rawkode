import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { newWebSocketRpcSession } from "capnweb"
import {
  AcceptChatForkInput,
  AcceptChatForkOutput,
  AddCollaboratorInput,
  AddCollaboratorOutput,
  AddFactInput,
  AddFactOutput,
  ApplySupertagInput,
  ApplySupertagOutput,
  AssignTagInput,
  AssignTagOutput,
  UnassignTagInput,
  UnassignTagOutput,
  ApplyChatForkEditInput,
  CreateAppInput,
  CreateAppOutput,
  DeleteAppInput,
  DeleteAppOutput,
  GetAppCodeInput,
  GetAppCodeOutput,
  GetAppInput,
  GetAppOutput,
  ListAppsInput,
  ListAppsOutput,
  MintAppRunCredentialInput,
  MintAppRunCredentialOutput,
  UpdateAppCodeInput,
  UpdateAppCodeOutput,
  ApplyChatForkEditOutput,
  ApplyPageEditInput,
  ApplyPageEditOutput,
  ChatForkPreviewInput,
  ChatForkPreviewOutput,
  ConnectGoogleCalendarInput,
  ConnectGoogleCalendarOutput,
  CreateBookmarkInput,
  CreateBookmarkOutput,
  CreateChatInput,
  CreateChatOutput,
  CreateEdgeInput,
  CreateEdgeOutput,
  CreateNodeInput,
  CreateNodeOutput,
  CreatePageInput,
  CreatePageOutput,
  CreateRelationDefinitionInput,
  CreateRelationDefinitionOutput,
  CreateShareLinkInput,
  CreateShareLinkOutput,
  CreateTagInput,
  CreateTagOutput,
  DefineTagFieldInput,
  DefineTagFieldOutput,
  ListTagClosureInput,
  ListTagClosureOutput,
  ListTagFieldsInput,
  ListTagFieldsOutput,
  ListTagsInput,
  ListTagsOutput,
  DisconnectGoogleCalendarInput,
  DisconnectGoogleCalendarOutput,
  EndMeetingInput,
  EndMeetingOutput,
  ForkChatEditInput,
  ForkChatEditOutput,
  GetChatInput,
  GetChatOutput,
  GetMeetingInput,
  GetMeetingOutput,
  GetNodeInput,
  GetNodeOutput,
  GetPageTextInput,
  GetPageTextOutput,
  GetWorkoutInput,
  GetWorkoutOutput,
  GoogleCalendarOAuthCallbackInput,
  GoogleCalendarOAuthCallbackOutput,
  LinkCalendarEventToNodeInput,
  LinkCalendarEventToNodeOutput,
  ListBacklinksInput,
  ListBacklinksOutput,
  ListBookmarksInput,
  ListBookmarksOutput,
  ListCalendarEventsInput,
  ListCalendarEventsOutput,
  ListChatChangesInput,
  ListChatChangesOutput,
  ListChatsInput,
  ListChatsOutput,
  ListCollaboratorsInput,
  ListCollaboratorsOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  ListNodesInput,
  ListNodesOutput,
  ListPendingChangesInput,
  ListPendingChangesOutput,
  ListShareLinksInput,
  ListShareLinksOutput,
  ListWorkoutsInput,
  ListWorkoutsOutput,
  MergeChangesInput,
  MergeChangesOutput,
  NodesChangedEvent,
  PageSyncMessageInput,
  PageSyncMessageOutput,
  PreviewRemoveCollaboratorInput,
  PreviewRemoveCollaboratorOutput,
  PreviewRevokeShareLinkInput,
  PreviewRevokeShareLinkOutput,
  RedeemShareLinkInput,
  RedeemShareLinkOutput,
  RemoveCollaboratorInput,
  RemoveCollaboratorOutput,
  RevertChangesInput,
  RevertChangesOutput,
  RevertChatForkInput,
  RevertChatForkOutput,
  ProposePageEditInput,
  ProposePageEditOutput,
  PreviewPageProposalInput,
  PreviewPageProposalOutput,
  AcceptPageProposalInput,
  AcceptPageProposalOutput,
  RevertPageProposalInput,
  RevertPageProposalOutput,
  RevokeShareLinkInput,
  RevokeShareLinkOutput,
  RotateEpochInput,
  RotateEpochOutput,
  RunViewInput,
  RunViewOutput,
  SearchNodesInput,
  SearchNodesOutput,
  SendChatMessageInput,
  SendChatMessageOutput,
  StartMeetingInput,
  StartMeetingOutput,
  StartPageSyncInput,
  StartPageSyncOutput,
  SyncFeedInput,
  SyncFeedOutput,
  SyncGoogleCalendarInput,
  SyncGoogleCalendarOutput,
  SyncNoteReferencesInput,
  SyncNoteReferencesOutput,
  AppendTranscriptSegmentInput,
  AppendTranscriptSegmentOutput,
  WhoamiOutput,
  type DomainError
} from "@athenaeum/domain"
import { callForStub, callForValue } from "./rpc-support.js"

// The Effect-side of the Cap'n Web RPC boundary (plan §"Web frontend data layer": "an RPC-client
// layer wrapping a Cap'n Web client connection to the router/backend"). Mirrors `backend`'s own
// `rpc-boundary.ts` shape but for the *client* end of risk #3's mitigation: a thrown `Error`
// carrying a JSON `{tag, message, data}` envelope (`@athenaeum/domain`'s `encodeRpcError`) is
// caught here, `JSON.parse`d, and run through `decodeRpcError` to recover a typed `DomainError` —
// exactly the contract `rpc-error.ts`'s doc comment describes for "the client stub".

/**
 * Structural client-side mirror of `WorkspaceDurableObject`'s `WorkspaceRpcApi`
 * (`packages/backend/src/workspace-durable-object.ts`). `web` intentionally does not depend on
 * `backend` (a Cloudflare Worker package, not meant to run in a browser) — this interface is a
 * hand-written copy of its method signatures, the same "declare the interface separately, don't
 * import the server class" pattern Cap'n Web's own README recommends for cross-boundary typing.
 * Inputs/outputs are `unknown` on both sides of the wire, matching the server's own signatures
 * exactly, because schema validation happens at this module's boundary
 * (`Schema.encodeSync`/`Schema.decodeUnknown` below) — not inside the RPC layer itself.
 */
interface WorkspaceApi {
  whoami(): Promise<unknown>

  createNode(input: unknown): Promise<unknown>
  listNodes(input: unknown): Promise<unknown>
  getNode(input: unknown): Promise<unknown>
  subscribeToNodes(input: unknown): Promise<NodesSubscriptionApi>
  createPage(input: unknown): Promise<unknown>
  getPageText(input: unknown): Promise<unknown>
  applyPageEdit(input: unknown): Promise<unknown>
  startPageSync(input: unknown): Promise<unknown>
  pageSyncMessage(input: unknown): Promise<unknown>
  listBacklinks(input: unknown): Promise<unknown>
  // Rich-text-editor stage (task item: "@-mention entity references... projected into the real
  // edges/backlinks system") — mirrors `WorkspaceRpcApi.syncNoteReferences` exactly (`graph-rpc.ts`).
  syncNoteReferences(input: unknown): Promise<unknown>
  createRelationDefinition(input: unknown): Promise<unknown>
  createEdge(input: unknown): Promise<unknown>
  createTag(input: unknown): Promise<unknown>
  listTags(input: unknown): Promise<unknown>
  listTagClosure(input: unknown): Promise<unknown>
  addFact(input: unknown): Promise<unknown>
  assignTag(input: unknown): Promise<unknown>
  unassignTag(input: unknown): Promise<unknown>
  // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) — mirrors
  // `WorkspaceRpcApi`'s own "Supertag-centering pass" section (`workspace-durable-object.ts`)
  // exactly: field definitions plus the one-call tag+fields application the inline `#`-picker
  // uses. Previously entirely missing from this client mirror (found via this stage's own read
  // of `workspace-durable-object.ts`'s full method list against this file) — `web` had no way to
  // call any of these three real, already-tested backend RPCs at all before this pass.
  defineTagField(input: unknown): Promise<unknown>
  listTagFields(input: unknown): Promise<unknown>
  applySupertag(input: unknown): Promise<unknown>
  runView(input: unknown): Promise<unknown>
  // Retrieval pass (design-review 2026-08-22 finding #1): mirrors `WorkspaceRpcApi.searchNodes`
  // (`workspace-durable-object.ts`, already implemented, already role-gated via
  // `requireRoleForGovernedWorkspace`, already covered by `views-search.test.ts`) — previously
  // missing from this client mirror entirely, so the web UI had no way to call the real FTS5
  // search the backend has shipped all along. Same "purely a missing client mirror" situation the
  // `defineTagField`/`forkChatEdit` comments above document for earlier passes.
  searchNodes(input: unknown): Promise<unknown>
  syncFeed(input: unknown): Promise<unknown>
  rotateEpoch(input: unknown): Promise<unknown>
  // --- Phase 3: AgentEditService (agent chats, pending records, changes stream) ----------------
  createChat(input: unknown): Promise<unknown>
  listChats(input: unknown): Promise<unknown>
  getChat(input: unknown): Promise<unknown>
  sendChatMessage(input: unknown): Promise<unknown>
  mergeChanges(input: unknown): Promise<unknown>
  revertChanges(input: unknown): Promise<unknown>
  listChatChanges(input: unknown): Promise<unknown>
  listPendingChanges(input: unknown): Promise<unknown>
  // --- Phase 3: chat-fork provisional note-body edits (plan risk #4) — adversarial-review fix:
  // previously missing from this interface entirely, so the web UI had no way to review, accept,
  // or revert an agent's note-body edits (chat-fork-rpc.ts / chat-fork-service-live.ts already
  // implement these for real server-side; this was purely a missing client mirror).
  forkChatEdit(input: unknown): Promise<unknown>
  applyChatForkEdit(input: unknown): Promise<unknown>
  chatForkPreview(input: unknown): Promise<unknown>
  acceptChatFork(input: unknown): Promise<unknown>
  revertChatFork(input: unknown): Promise<unknown>
  proposePageEdit(input: unknown): Promise<unknown>
  previewPageProposal(input: unknown): Promise<unknown>
  acceptPageProposal(input: unknown): Promise<unknown>
  revertPageProposal(input: unknown): Promise<unknown>
  // --- Web stage: sharing/multi-workspace (task item 3) — mirrors `WorkspaceRpcApi`'s Phase 4 sharing
  // methods (`workspace-durable-object.ts`) exactly, per `sharing-rpc.ts`'s method list. ------------
  addCollaborator(input: unknown): Promise<unknown>
  previewRemoveCollaborator(input: unknown): Promise<unknown>
  removeCollaborator(input: unknown): Promise<unknown>
  createShareLink(input: unknown): Promise<unknown>
  redeemShareLink(input: unknown): Promise<unknown>
  previewRevokeShareLink(input: unknown): Promise<unknown>
  revokeShareLink(input: unknown): Promise<unknown>
  listCollaborators(input: unknown): Promise<unknown>
  listShareLinks(input: unknown): Promise<unknown>
  // --- Web stage: Google Calendar + Bookmarks (task item: connect flow / day view / bookmarks
  // capture) — mirrors `WorkspaceRpcApi`'s Phase 5 `gatekeeper-rpc.ts` methods exactly, per
  // `workspace-durable-object.ts`'s "Phase 5: Google Calendar + Bookmarks" section. -----------------
  connectGoogleCalendar(input: unknown): Promise<unknown>
  googleCalendarOAuthCallback(input: unknown): Promise<unknown>
  disconnectGoogleCalendar(input: unknown): Promise<unknown>
  syncGoogleCalendar(input: unknown): Promise<unknown>
  listCalendarEvents(input: unknown): Promise<unknown>
  linkCalendarEventToNode(input: unknown): Promise<unknown>
  createBookmark(input: unknown): Promise<unknown>
  listBookmarks(input: unknown): Promise<unknown>
  // --- Web stage: Meetings (Phase 6, read path) — mirrors `WorkspaceRpcApi`'s Phase 6 `meeting-rpc.ts`
  // methods exactly, per `workspace-durable-object.ts`'s "Phase 6: Meetings & voice" section. `web`
  // itself only calls `listMeetings`/`getMeeting` (capture is native-only, per that phase's own
  // scope), but every method is mirrored here for interface completeness against the backend's
  // full RPC surface, same discipline `forkChatEdit`/`applyChatForkEdit` already established
  // above. --------------------------------------------------------------------------------------
  startMeeting(input: unknown): Promise<unknown>
  endMeeting(input: unknown): Promise<unknown>
  appendTranscriptSegment(input: unknown): Promise<unknown>
  getMeeting(input: unknown): Promise<unknown>
  listMeetings(input: unknown): Promise<unknown>
  // --- Web stage: Workouts (Phase 7, read path) — mirrors `WorkspaceRpcApi`'s Phase 7 `workout-rpc.ts`
  // read methods exactly, per `workspace-durable-object.ts`'s "Phase 7: workouts" section. `web` only
  // calls `listWorkouts`/`getWorkout` — import is native-only (HealthKit), per this stage's own
  // scope — but per `MeetingsPanel.tsx`'s established "mirror the full RPC surface for interface
  // completeness" discipline, `importWorkout`/`importWorkouts`/`listWorkoutImports` are NOT mirrored
  // here since nothing on `web` calls them (unlike `startMeeting`/`endMeeting`, which Phase 6's own
  // section mirrored despite being unused, this stage intentionally narrows to what's actually
  // called — see this file's own read-path-only scope note in `WorkoutsPanel.tsx`).
  listWorkouts(input: unknown): Promise<unknown>
  getWorkout(input: unknown): Promise<unknown>
  // --- Web stage: App Library (mainline/direct path, app-rpc.ts's six methods) — mirrors
  // `WorkspaceRpcApi`'s App Library methods exactly (`workspace-durable-object.ts`'s "App Library"
  // section). `web` calls all six directly (no `chatId`): this is the App Library page's own
  // create/edit/delete path, distinct from the agent-tool path (`CreateAppTool`/`UpdateAppCodeTool`)
  // that `ChatPanel.tsx` exercises indirectly via chat messages.
  createApp(input: unknown): Promise<unknown>
  updateAppCode(input: unknown): Promise<unknown>
  listApps(input: unknown): Promise<unknown>
  getApp(input: unknown): Promise<unknown>
  getAppCode(input: unknown): Promise<unknown>
  deleteApp(input: unknown): Promise<unknown>
  mintAppRunCredential(input: unknown): Promise<unknown>
}

/** Mirrors `backend`'s `NodesSubscription` — `next()` is its only RPC-facing method; disposal is
 *  `RpcStub`'s own `[Symbol.dispose]`, present on every stub via Cap'n Web's `StubBase`. */
interface NodesSubscriptionApi {
  next(): Promise<unknown>
}

/** A live subscription handle, as returned by `WorkspaceRpcClientService#subscribeToNodes`. `next`
 *  resolves once per change — call it in a loop (see `use-effect-subscription.ts`) to observe a
 *  live stream. Requires `Scope.Scope`: the underlying `NodesSubscriptionApi` stub (and the
 *  server-side `NodesSubscription` it points at) is released when the scope closes. */
export interface NodesSubscriptionHandle {
  readonly next: Effect.Effect<NodesChangedEvent, DomainError>
}

export interface WorkspaceRpcClientService {
  readonly whoami: () => Effect.Effect<WhoamiOutput, DomainError>
  readonly createNode: (input: CreateNodeInput) => Effect.Effect<CreateNodeOutput, DomainError>
  readonly listNodes: (input: ListNodesInput) => Effect.Effect<ListNodesOutput, DomainError>
  readonly getNode: (input: GetNodeInput) => Effect.Effect<GetNodeOutput, DomainError>
  readonly subscribeToNodes: (
    input: ListNodesInput
  ) => Effect.Effect<NodesSubscriptionHandle, DomainError, Scope.Scope>
  // --- Page bodies (Automerge) — Daily notes stage additions ---------------------------------
  readonly createPage: (input: CreatePageInput) => Effect.Effect<CreatePageOutput, DomainError>
  readonly getPageText: (input: GetPageTextInput) => Effect.Effect<GetPageTextOutput, DomainError>
  readonly applyPageEdit: (input: ApplyPageEditInput) => Effect.Effect<ApplyPageEditOutput, DomainError>
  readonly startPageSync: (input: StartPageSyncInput) => Effect.Effect<StartPageSyncOutput, DomainError>
  readonly pageSyncMessage: (
    input: PageSyncMessageInput
  ) => Effect.Effect<PageSyncMessageOutput, DomainError>
  // --- Graph ------------------------------------------------------------------------------------
  readonly listBacklinks: (input: ListBacklinksInput) => Effect.Effect<ListBacklinksOutput, DomainError>
  readonly syncNoteReferences: (
    input: SyncNoteReferencesInput
  ) => Effect.Effect<SyncNoteReferencesOutput, DomainError>
  readonly createRelationDefinition: (
    input: CreateRelationDefinitionInput
  ) => Effect.Effect<CreateRelationDefinitionOutput, DomainError>
  readonly createEdge: (input: CreateEdgeInput) => Effect.Effect<CreateEdgeOutput, DomainError>
  readonly createTag: (input: CreateTagInput) => Effect.Effect<CreateTagOutput, DomainError>
  readonly listTags: (input: ListTagsInput) => Effect.Effect<ListTagsOutput, DomainError>
  readonly listTagClosure: (input: ListTagClosureInput) => Effect.Effect<ListTagClosureOutput, DomainError>
  readonly addFact: (input: AddFactInput) => Effect.Effect<AddFactOutput, DomainError>
  readonly assignTag: (input: AssignTagInput) => Effect.Effect<AssignTagOutput, DomainError>
  readonly unassignTag: (input: UnassignTagInput) => Effect.Effect<UnassignTagOutput, DomainError>
  // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) ---------------------
  readonly defineTagField: (input: DefineTagFieldInput) => Effect.Effect<DefineTagFieldOutput, DomainError>
  readonly listTagFields: (input: ListTagFieldsInput) => Effect.Effect<ListTagFieldsOutput, DomainError>
  readonly applySupertag: (input: ApplySupertagInput) => Effect.Effect<ApplySupertagOutput, DomainError>
  // --- Views ------------------------------------------------------------------------------------
  readonly runView: (input: RunViewInput) => Effect.Effect<RunViewOutput, DomainError>
  // --- Full-text search (retrieval pass — see `WorkspaceApi.searchNodes`'s comment above) -------
  readonly searchNodes: (input: SearchNodesInput) => Effect.Effect<SearchNodesOutput, DomainError>
  // --- Structured-record sync feed + epoch (adversarial-review fix: previously implemented
  // backend-side and covered by backend tests only — see `sync-feed-client.ts`'s header comment
  // for the real client-side consumer this now feeds) -------------------------------------------
  readonly syncFeed: (input: SyncFeedInput) => Effect.Effect<SyncFeedOutput, DomainError>
  readonly rotateEpoch: (input: RotateEpochInput) => Effect.Effect<RotateEpochOutput, DomainError>
  // --- Phase 3: AgentEditService (agent chats, pending records, changes stream) ------------------
  readonly createChat: (input: CreateChatInput) => Effect.Effect<CreateChatOutput, DomainError>
  readonly listChats: (input: ListChatsInput) => Effect.Effect<ListChatsOutput, DomainError>
  readonly getChat: (input: GetChatInput) => Effect.Effect<GetChatOutput, DomainError>
  readonly sendChatMessage: (
    input: SendChatMessageInput
  ) => Effect.Effect<SendChatMessageOutput, DomainError>
  readonly mergeChanges: (input: MergeChangesInput) => Effect.Effect<MergeChangesOutput, DomainError>
  readonly revertChanges: (input: RevertChangesInput) => Effect.Effect<RevertChangesOutput, DomainError>
  readonly listChatChanges: (
    input: ListChatChangesInput
  ) => Effect.Effect<ListChatChangesOutput, DomainError>
  readonly listPendingChanges: (
    input: ListPendingChangesInput
  ) => Effect.Effect<ListPendingChangesOutput, DomainError>
  // --- Phase 3: chat-fork provisional note-body edits (plan risk #4) — see WorkspaceApi's own
  // comment above for why these were added. `forkChatEdit`/`applyChatForkEdit` are the agent-
  // tool-side operations (mirrored here for interface completeness against the backend's full
  // `WorkspaceRpcApi` surface); `chatForkPreview`/`acceptChatFork`/`revertChatFork` are what
  // `ChatPanel.tsx`'s review UI actually calls.
  readonly forkChatEdit: (input: ForkChatEditInput) => Effect.Effect<ForkChatEditOutput, DomainError>
  readonly applyChatForkEdit: (
    input: ApplyChatForkEditInput
  ) => Effect.Effect<ApplyChatForkEditOutput, DomainError>
  readonly chatForkPreview: (input: ChatForkPreviewInput) => Effect.Effect<ChatForkPreviewOutput, DomainError>
  readonly acceptChatFork: (input: AcceptChatForkInput) => Effect.Effect<AcceptChatForkOutput, DomainError>
  readonly revertChatFork: (input: RevertChatForkInput) => Effect.Effect<RevertChatForkOutput, DomainError>
  readonly proposePageEdit: (input: ProposePageEditInput) => Effect.Effect<ProposePageEditOutput, DomainError>
  readonly previewPageProposal: (input: PreviewPageProposalInput) => Effect.Effect<PreviewPageProposalOutput, DomainError>
  readonly acceptPageProposal: (input: AcceptPageProposalInput) => Effect.Effect<AcceptPageProposalOutput, DomainError>
  readonly revertPageProposal: (input: RevertPageProposalInput) => Effect.Effect<RevertPageProposalOutput, DomainError>
  // --- Web stage: sharing/multi-workspace (task item 3) ---------------------------------------------
  readonly addCollaborator: (input: AddCollaboratorInput) => Effect.Effect<AddCollaboratorOutput, DomainError>
  readonly previewRemoveCollaborator: (
    input: PreviewRemoveCollaboratorInput
  ) => Effect.Effect<PreviewRemoveCollaboratorOutput, DomainError>
  readonly removeCollaborator: (
    input: RemoveCollaboratorInput
  ) => Effect.Effect<RemoveCollaboratorOutput, DomainError>
  readonly createShareLink: (input: CreateShareLinkInput) => Effect.Effect<CreateShareLinkOutput, DomainError>
  readonly redeemShareLink: (input: RedeemShareLinkInput) => Effect.Effect<RedeemShareLinkOutput, DomainError>
  readonly previewRevokeShareLink: (
    input: PreviewRevokeShareLinkInput
  ) => Effect.Effect<PreviewRevokeShareLinkOutput, DomainError>
  readonly revokeShareLink: (input: RevokeShareLinkInput) => Effect.Effect<RevokeShareLinkOutput, DomainError>
  readonly listCollaborators: (
    input: ListCollaboratorsInput
  ) => Effect.Effect<ListCollaboratorsOutput, DomainError>
  readonly listShareLinks: (input: ListShareLinksInput) => Effect.Effect<ListShareLinksOutput, DomainError>
  // --- Web stage: Google Calendar + Bookmarks -----------------------------------------------
  readonly connectGoogleCalendar: (
    input: ConnectGoogleCalendarInput
  ) => Effect.Effect<ConnectGoogleCalendarOutput, DomainError>
  readonly googleCalendarOAuthCallback: (
    input: GoogleCalendarOAuthCallbackInput
  ) => Effect.Effect<GoogleCalendarOAuthCallbackOutput, DomainError>
  readonly disconnectGoogleCalendar: (
    input: DisconnectGoogleCalendarInput
  ) => Effect.Effect<DisconnectGoogleCalendarOutput, DomainError>
  readonly syncGoogleCalendar: (
    input: SyncGoogleCalendarInput
  ) => Effect.Effect<SyncGoogleCalendarOutput, DomainError>
  readonly listCalendarEvents: (
    input: ListCalendarEventsInput
  ) => Effect.Effect<ListCalendarEventsOutput, DomainError>
  readonly linkCalendarEventToNode: (
    input: LinkCalendarEventToNodeInput
  ) => Effect.Effect<LinkCalendarEventToNodeOutput, DomainError>
  readonly createBookmark: (input: CreateBookmarkInput) => Effect.Effect<CreateBookmarkOutput, DomainError>
  readonly listBookmarks: (input: ListBookmarksInput) => Effect.Effect<ListBookmarksOutput, DomainError>
  // --- Web stage: Meetings (Phase 6, read path) --------------------------------------------
  readonly startMeeting: (input: StartMeetingInput) => Effect.Effect<StartMeetingOutput, DomainError>
  readonly endMeeting: (input: EndMeetingInput) => Effect.Effect<EndMeetingOutput, DomainError>
  readonly appendTranscriptSegment: (
    input: AppendTranscriptSegmentInput
  ) => Effect.Effect<AppendTranscriptSegmentOutput, DomainError>
  readonly getMeeting: (input: GetMeetingInput) => Effect.Effect<GetMeetingOutput, DomainError>
  readonly listMeetings: (input: ListMeetingsInput) => Effect.Effect<ListMeetingsOutput, DomainError>
  // --- Web stage: Workouts (Phase 7, read path) ---------------------------------------------
  readonly listWorkouts: (input: ListWorkoutsInput) => Effect.Effect<ListWorkoutsOutput, DomainError>
  readonly getWorkout: (input: GetWorkoutInput) => Effect.Effect<GetWorkoutOutput, DomainError>
  // --- Web stage: App Library (mainline/direct path) ------------------------------------------
  readonly createApp: (input: CreateAppInput) => Effect.Effect<CreateAppOutput, DomainError>
  readonly updateAppCode: (input: UpdateAppCodeInput) => Effect.Effect<UpdateAppCodeOutput, DomainError>
  readonly listApps: (input: ListAppsInput) => Effect.Effect<ListAppsOutput, DomainError>
  readonly getApp: (input: GetAppInput) => Effect.Effect<GetAppOutput, DomainError>
  readonly getAppCode: (input: GetAppCodeInput) => Effect.Effect<GetAppCodeOutput, DomainError>
  readonly deleteApp: (input: DeleteAppInput) => Effect.Effect<DeleteAppOutput, DomainError>
  readonly mintAppRunCredential: (
    input: MintAppRunCredentialInput
  ) => Effect.Effect<MintAppRunCredentialOutput, DomainError>
}

export class WorkspaceRpcClient extends Context.Tag("@athenaeum/web/WorkspaceRpcClient")<
  WorkspaceRpcClient,
  WorkspaceRpcClientService
>() {}

/**
 * Builds the live `WorkspaceRpcClient` layer: one Cap'n Web WebSocket session per app lifetime,
 * opened via `newWebSocketRpcSession` and disposed (closing the socket) when the layer's scope
 * closes. Per the plan, this is composed into the app's `Layer` once and fed into a single
 * `ManagedRuntime` at boot (`runtime.ts`) — never rebuilt per call or per render.
 */
export const makeWorkspaceRpcClientLive = (wsUrl: string): Layer.Layer<WorkspaceRpcClient> =>
  Layer.scoped(
    WorkspaceRpcClient,
    Effect.gen(function* () {
      const workspaceStub = yield* Effect.acquireRelease(
        Effect.sync(() => newWebSocketRpcSession<WorkspaceApi>(wsUrl)),
        (stub) => Effect.sync(() => stub[Symbol.dispose]())
      )

      return {
        whoami: () => callForValue(WhoamiOutput, () => workspaceStub.whoami()),

        createNode: (input) =>
          callForValue(CreateNodeOutput, () =>
            workspaceStub.createNode(Schema.encodeSync(CreateNodeInput)(input))
          ),

        listNodes: (input) =>
          callForValue(ListNodesOutput, () =>
            workspaceStub.listNodes(Schema.encodeSync(ListNodesInput)(input))
          ),

        getNode: (input) =>
          callForValue(GetNodeOutput, () => workspaceStub.getNode(Schema.encodeSync(GetNodeInput)(input))),

        subscribeToNodes: (input) =>
          Effect.gen(function* () {
            const wireInput = Schema.encodeSync(ListNodesInput)(input)
            const subStub = yield* Effect.acquireRelease(
              callForStub(() => workspaceStub.subscribeToNodes(wireInput)),
              (stub) => Effect.sync(() => stub[Symbol.dispose]())
            )
            return {
              next: callForValue(NodesChangedEvent, () => subStub.next())
            } satisfies NodesSubscriptionHandle
          }),

        // --- Page bodies (Automerge) — Daily notes stage additions -----------------------------

        createPage: (input) =>
          callForValue(CreatePageOutput, () => workspaceStub.createPage(Schema.encodeSync(CreatePageInput)(input))),

        getPageText: (input) =>
          callForValue(GetPageTextOutput, () =>
            workspaceStub.getPageText(Schema.encodeSync(GetPageTextInput)(input))
          ),

        applyPageEdit: (input) =>
          callForValue(ApplyPageEditOutput, () =>
            workspaceStub.applyPageEdit(Schema.encodeSync(ApplyPageEditInput)(input))
          ),

        startPageSync: (input) =>
          callForValue(StartPageSyncOutput, () =>
            workspaceStub.startPageSync(Schema.encodeSync(StartPageSyncInput)(input))
          ),

        pageSyncMessage: (input) =>
          callForValue(PageSyncMessageOutput, () =>
            workspaceStub.pageSyncMessage(Schema.encodeSync(PageSyncMessageInput)(input))
          ),

        // --- Graph -------------------------------------------------------------------------------

        listBacklinks: (input) =>
          callForValue(ListBacklinksOutput, () =>
            workspaceStub.listBacklinks(Schema.encodeSync(ListBacklinksInput)(input))
          ),

        syncNoteReferences: (input) =>
          callForValue(SyncNoteReferencesOutput, () =>
            workspaceStub.syncNoteReferences(Schema.encodeSync(SyncNoteReferencesInput)(input))
          ),

        createRelationDefinition: (input) =>
          callForValue(CreateRelationDefinitionOutput, () =>
            workspaceStub.createRelationDefinition(Schema.encodeSync(CreateRelationDefinitionInput)(input))
          ),

        createEdge: (input) =>
          callForValue(CreateEdgeOutput, () => workspaceStub.createEdge(Schema.encodeSync(CreateEdgeInput)(input))),

        createTag: (input) =>
          callForValue(CreateTagOutput, () => workspaceStub.createTag(Schema.encodeSync(CreateTagInput)(input))),

        listTags: (input) =>
          callForValue(ListTagsOutput, () => workspaceStub.listTags(Schema.encodeSync(ListTagsInput)(input))),

        listTagClosure: (input) =>
          callForValue(ListTagClosureOutput, () =>
            workspaceStub.listTagClosure(Schema.encodeSync(ListTagClosureInput)(input))
          ),

        addFact: (input) =>
          callForValue(AddFactOutput, () => workspaceStub.addFact(Schema.encodeSync(AddFactInput)(input))),

        assignTag: (input) =>
          callForValue(AssignTagOutput, () => workspaceStub.assignTag(Schema.encodeSync(AssignTagInput)(input))),

        unassignTag: (input) =>
          callForValue(UnassignTagOutput, () =>
            workspaceStub.unassignTag(Schema.encodeSync(UnassignTagInput)(input))
          ),

        // --- Supertag-centering pass (docs/supertag-centering-decisions.md §1/§2) -------------

        defineTagField: (input) =>
          callForValue(DefineTagFieldOutput, () =>
            workspaceStub.defineTagField(Schema.encodeSync(DefineTagFieldInput)(input))
          ),

        listTagFields: (input) =>
          callForValue(ListTagFieldsOutput, () =>
            workspaceStub.listTagFields(Schema.encodeSync(ListTagFieldsInput)(input))
          ),

        applySupertag: (input) =>
          callForValue(ApplySupertagOutput, () =>
            workspaceStub.applySupertag(Schema.encodeSync(ApplySupertagInput)(input))
          ),

        // --- Views ---------------------------------------------------------------------------------

        runView: (input) =>
          callForValue(RunViewOutput, () => workspaceStub.runView(Schema.encodeSync(RunViewInput)(input))),

        // --- Full-text search (retrieval pass) ------------------------------------------------

        searchNodes: (input) =>
          callForValue(SearchNodesOutput, () =>
            workspaceStub.searchNodes(Schema.encodeSync(SearchNodesInput)(input))
          ),

        // --- Structured-record sync feed + epoch ------------------------------------------------

        syncFeed: (input) =>
          callForValue(SyncFeedOutput, () => workspaceStub.syncFeed(Schema.encodeSync(SyncFeedInput)(input))),

        rotateEpoch: (input) =>
          callForValue(RotateEpochOutput, () =>
            workspaceStub.rotateEpoch(Schema.encodeSync(RotateEpochInput)(input))
          ),

        // --- Phase 3: AgentEditService (agent chats, pending records, changes stream) ----------

        createChat: (input) =>
          callForValue(CreateChatOutput, () =>
            workspaceStub.createChat(Schema.encodeSync(CreateChatInput)(input))
          ),

        listChats: (input) =>
          callForValue(ListChatsOutput, () =>
            workspaceStub.listChats(Schema.encodeSync(ListChatsInput)(input))
          ),

        getChat: (input) =>
          callForValue(GetChatOutput, () => workspaceStub.getChat(Schema.encodeSync(GetChatInput)(input))),

        sendChatMessage: (input) =>
          callForValue(SendChatMessageOutput, () =>
            workspaceStub.sendChatMessage(Schema.encodeSync(SendChatMessageInput)(input))
          ),

        mergeChanges: (input) =>
          callForValue(MergeChangesOutput, () =>
            workspaceStub.mergeChanges(Schema.encodeSync(MergeChangesInput)(input))
          ),

        revertChanges: (input) =>
          callForValue(RevertChangesOutput, () =>
            workspaceStub.revertChanges(Schema.encodeSync(RevertChangesInput)(input))
          ),

        listChatChanges: (input) =>
          callForValue(ListChatChangesOutput, () =>
            workspaceStub.listChatChanges(Schema.encodeSync(ListChatChangesInput)(input))
          ),

        listPendingChanges: (input) =>
          callForValue(ListPendingChangesOutput, () =>
            workspaceStub.listPendingChanges(Schema.encodeSync(ListPendingChangesInput)(input))
          ),

        // --- Phase 3: chat-fork provisional note-body edits (plan risk #4) --------------------

        forkChatEdit: (input) =>
          callForValue(ForkChatEditOutput, () =>
            workspaceStub.forkChatEdit(Schema.encodeSync(ForkChatEditInput)(input))
          ),

        applyChatForkEdit: (input) =>
          callForValue(ApplyChatForkEditOutput, () =>
            workspaceStub.applyChatForkEdit(Schema.encodeSync(ApplyChatForkEditInput)(input))
          ),

        chatForkPreview: (input) =>
          callForValue(ChatForkPreviewOutput, () =>
            workspaceStub.chatForkPreview(Schema.encodeSync(ChatForkPreviewInput)(input))
          ),

        acceptChatFork: (input) =>
          callForValue(AcceptChatForkOutput, () =>
            workspaceStub.acceptChatFork(Schema.encodeSync(AcceptChatForkInput)(input))
          ),

        revertChatFork: (input) =>
          callForValue(RevertChatForkOutput, () =>
            workspaceStub.revertChatFork(Schema.encodeSync(RevertChatForkInput)(input))
          ),
        proposePageEdit: (input) =>
          callForValue(ProposePageEditOutput, () =>
            workspaceStub.proposePageEdit(Schema.encodeSync(ProposePageEditInput)(input))
          ),
        previewPageProposal: (input) =>
          callForValue(PreviewPageProposalOutput, () =>
            workspaceStub.previewPageProposal(Schema.encodeSync(PreviewPageProposalInput)(input))
          ),
        acceptPageProposal: (input) =>
          callForValue(AcceptPageProposalOutput, () =>
            workspaceStub.acceptPageProposal(Schema.encodeSync(AcceptPageProposalInput)(input))
          ),
        revertPageProposal: (input) =>
          callForValue(RevertPageProposalOutput, () =>
            workspaceStub.revertPageProposal(Schema.encodeSync(RevertPageProposalInput)(input))
          ),

        // --- Web stage: sharing/multi-workspace (task item 3) ------------------------------------

        addCollaborator: (input) =>
          callForValue(AddCollaboratorOutput, () =>
            workspaceStub.addCollaborator(Schema.encodeSync(AddCollaboratorInput)(input))
          ),

        previewRemoveCollaborator: (input) =>
          callForValue(PreviewRemoveCollaboratorOutput, () =>
            workspaceStub.previewRemoveCollaborator(Schema.encodeSync(PreviewRemoveCollaboratorInput)(input))
          ),

        removeCollaborator: (input) =>
          callForValue(RemoveCollaboratorOutput, () =>
            workspaceStub.removeCollaborator(Schema.encodeSync(RemoveCollaboratorInput)(input))
          ),

        createShareLink: (input) =>
          callForValue(CreateShareLinkOutput, () =>
            workspaceStub.createShareLink(Schema.encodeSync(CreateShareLinkInput)(input))
          ),

        redeemShareLink: (input) =>
          callForValue(RedeemShareLinkOutput, () =>
            workspaceStub.redeemShareLink(Schema.encodeSync(RedeemShareLinkInput)(input))
          ),

        previewRevokeShareLink: (input) =>
          callForValue(PreviewRevokeShareLinkOutput, () =>
            workspaceStub.previewRevokeShareLink(Schema.encodeSync(PreviewRevokeShareLinkInput)(input))
          ),

        revokeShareLink: (input) =>
          callForValue(RevokeShareLinkOutput, () =>
            workspaceStub.revokeShareLink(Schema.encodeSync(RevokeShareLinkInput)(input))
          ),

        listCollaborators: (input) =>
          callForValue(ListCollaboratorsOutput, () =>
            workspaceStub.listCollaborators(Schema.encodeSync(ListCollaboratorsInput)(input))
          ),

        listShareLinks: (input) =>
          callForValue(ListShareLinksOutput, () =>
            workspaceStub.listShareLinks(Schema.encodeSync(ListShareLinksInput)(input))
          ),

        // --- Web stage: Google Calendar + Bookmarks --------------------------------------------

        connectGoogleCalendar: (input) =>
          callForValue(ConnectGoogleCalendarOutput, () =>
            workspaceStub.connectGoogleCalendar(Schema.encodeSync(ConnectGoogleCalendarInput)(input))
          ),

        googleCalendarOAuthCallback: (input) =>
          callForValue(GoogleCalendarOAuthCallbackOutput, () =>
            workspaceStub.googleCalendarOAuthCallback(Schema.encodeSync(GoogleCalendarOAuthCallbackInput)(input))
          ),

        disconnectGoogleCalendar: (input) =>
          callForValue(DisconnectGoogleCalendarOutput, () =>
            workspaceStub.disconnectGoogleCalendar(Schema.encodeSync(DisconnectGoogleCalendarInput)(input))
          ),

        syncGoogleCalendar: (input) =>
          callForValue(SyncGoogleCalendarOutput, () =>
            workspaceStub.syncGoogleCalendar(Schema.encodeSync(SyncGoogleCalendarInput)(input))
          ),

        listCalendarEvents: (input) =>
          callForValue(ListCalendarEventsOutput, () =>
            workspaceStub.listCalendarEvents(Schema.encodeSync(ListCalendarEventsInput)(input))
          ),

        linkCalendarEventToNode: (input) =>
          callForValue(LinkCalendarEventToNodeOutput, () =>
            workspaceStub.linkCalendarEventToNode(Schema.encodeSync(LinkCalendarEventToNodeInput)(input))
          ),

        createBookmark: (input) =>
          callForValue(CreateBookmarkOutput, () =>
            workspaceStub.createBookmark(Schema.encodeSync(CreateBookmarkInput)(input))
          ),

        listBookmarks: (input) =>
          callForValue(ListBookmarksOutput, () =>
            workspaceStub.listBookmarks(Schema.encodeSync(ListBookmarksInput)(input))
          ),

        // --- Web stage: Meetings (Phase 6, read path) ------------------------------------------

        startMeeting: (input) =>
          callForValue(StartMeetingOutput, () =>
            workspaceStub.startMeeting(Schema.encodeSync(StartMeetingInput)(input))
          ),

        endMeeting: (input) =>
          callForValue(EndMeetingOutput, () => workspaceStub.endMeeting(Schema.encodeSync(EndMeetingInput)(input))),

        appendTranscriptSegment: (input) =>
          callForValue(AppendTranscriptSegmentOutput, () =>
            workspaceStub.appendTranscriptSegment(Schema.encodeSync(AppendTranscriptSegmentInput)(input))
          ),

        getMeeting: (input) =>
          callForValue(GetMeetingOutput, () => workspaceStub.getMeeting(Schema.encodeSync(GetMeetingInput)(input))),

        listMeetings: (input) =>
          callForValue(ListMeetingsOutput, () =>
            workspaceStub.listMeetings(Schema.encodeSync(ListMeetingsInput)(input))
          ),

        // --- Web stage: Workouts (Phase 7, read path) ------------------------------------------

        listWorkouts: (input) =>
          callForValue(ListWorkoutsOutput, () =>
            workspaceStub.listWorkouts(Schema.encodeSync(ListWorkoutsInput)(input))
          ),

        getWorkout: (input) =>
          callForValue(GetWorkoutOutput, () =>
            workspaceStub.getWorkout(Schema.encodeSync(GetWorkoutInput)(input))
          ),

        // --- Web stage: App Library (mainline/direct path) -------------------------------------

        createApp: (input) =>
          callForValue(CreateAppOutput, () =>
            workspaceStub.createApp(Schema.encodeSync(CreateAppInput)(input))
          ),

        updateAppCode: (input) =>
          callForValue(UpdateAppCodeOutput, () =>
            workspaceStub.updateAppCode(Schema.encodeSync(UpdateAppCodeInput)(input))
          ),

        listApps: (input) =>
          callForValue(ListAppsOutput, () => workspaceStub.listApps(Schema.encodeSync(ListAppsInput)(input))),

        getApp: (input) =>
          callForValue(GetAppOutput, () => workspaceStub.getApp(Schema.encodeSync(GetAppInput)(input))),

        getAppCode: (input) =>
          callForValue(GetAppCodeOutput, () =>
            workspaceStub.getAppCode(Schema.encodeSync(GetAppCodeInput)(input))
          ),

        deleteApp: (input) =>
          callForValue(DeleteAppOutput, () => workspaceStub.deleteApp(Schema.encodeSync(DeleteAppInput)(input))),

        mintAppRunCredential: (input) =>
          callForValue(MintAppRunCredentialOutput, () =>
            workspaceStub.mintAppRunCredential(Schema.encodeSync(MintAppRunCredentialInput)(input))
          )
      }
    })
  )
