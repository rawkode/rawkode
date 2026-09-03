import * as Schema from "effect/Schema"
import { AppCodeKind, AppIcon } from "./app.js"
import { ChatBindingName } from "./chat-binding.js"
import { JsonValue } from "./json-value.js"
import { EntityId } from "./node.js"
import { TagFieldValueKind } from "./tag-field-definition.js"

const AgentCommitMessage = Schema.transform(
  Schema.String.pipe(Schema.maxLength(756)),
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)),
  { decode: (value) => value.trim(), encode: (value) => value }
)

// Phase 3 storage-schema task (plan: "Agent tools (readNote, editNote, createNode, addFact,
// addEdge, linkCalendarEvent) take a chat-local binding name resolved the same way — reuse the
// mechanism as designed"). One input/output `Schema.Class` pair per tool, following
// rpc.ts/graph-rpc.ts's established one-pair-per-method convention.
//
// Every tool takes `chatId` (which binding namespace to resolve names against — chats are
// workspace-scoped per chat.ts, so `chatId` alone is enough to also determine the workspace) plus one or
// more `ChatBindingName`s in place of any `EntityId` a raw storage-layer RPC method (rpc.ts /
// graph-rpc.ts / chat-fork-rpc.ts) would take instead — resolving a name to an `EntityId` against
// the chat's binding map is a backend `AgentEditService` concern (Storage stage, not built by
// this task); these schemas only fix the wire shape the agent's tool-calling loop presents to
// `ModelClient.converse()` as a `ToolSpec` and receives back as a `ToolCallRequest.input`
// (model-client.ts).
//
// None of these are wired into `ToolSpec`/`ModelClient` yet, and none has a backend
// implementation — that wiring (turning each pair into a real `ToolSpec.inputSchema` +
// dispatching a matching `ToolCallRequest` to real storage) is Storage-stage work. This task's
// scope is the schema layer alone (plan task: "Extend packages/domain/src").

/** Reads a note's current mainline text through the binding's node. Read-only — unlike
 *  `editNote` below, this never forks (there's nothing to preview), so it has no `chatId`-scoped
 *  side effect; `chatId` is present only to resolve `binding` against the right chat's map. */
export class ReadNoteToolInput extends Schema.Class<ReadNoteToolInput>("ReadNoteToolInput")({
  chatId: EntityId,
  binding: ChatBindingName
}) {}

export class ReadNoteToolOutput extends Schema.Class<ReadNoteToolOutput>("ReadNoteToolOutput")({
  text: Schema.String
}) {}

/**
 * Applies an edit to a note's body. Legacy Automerge pages retain the chat-fork workflow, while
 * native Loro pages commit through the semantic ledger gateway. `commitMessage` is the bounded
 * agent-authored rationale retained by the latter path; the legacy fork accepts it for the same
 * stable tool contract and carries it into the durable proposal rationale.
 */
export class EditNoteToolInput extends Schema.Class<EditNoteToolInput>("EditNoteToolInput")({
  chatId: EntityId,
  binding: ChatBindingName,
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  deleteCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  insertText: Schema.String,
  commitMessage: AgentCommitMessage
}) {}

/**
 * `nodeId` (adversarial-review fix): the fork's underlying node, resolved server-side from
 * `binding` — added so a reviewing client (web `ChatPanel.tsx` / native `PendingChangesView`) has
 * a real way to discover which node an `editNote` tool call just forked, without a second RPC
 * round trip or a copy of the chat's binding map. Every `"tool"`-role `ChatMessageRecord` this
 * tool produces JSON-stringifies its full output as `result`
 * (`agent-edit-service-live.ts`'s `executeToolCall`), so this field rides along for free in the
 * chat log already both clients already fetch — a client collects the distinct `nodeId`s of every
 * `editNote` tool-log entry in a chat's history, then calls `chatForkPreview`/`acceptChatFork`/
 * `revertChatFork` (chat-fork-rpc.ts) per id to build an accept/revert UI for note-body edits,
 * exactly the way `listPendingChanges` already does for structured node/fact/edge pending
 * records. Deliberately NOT surfaced via `refs`/`ChangesMessage.batch` (dispatchTool's `editNote`
 * case keeps `refs: []`) — `refs` feeds `stampPending`, which sets the row-level `Node.pending`
 * flag on the MAINLINE node; doing that here would wrongly mark an untouched mainline node
 * pending for a change that only exists in the chat's in-memory fork (see
 * chat-fork-service-live.ts's header comment for why the two mechanisms are kept structurally
 * separate). This field is pure client-discoverability metadata, nothing more.
 */
export class EditNoteToolOutput extends Schema.Class<EditNoteToolOutput>("EditNoteToolOutput")({
  text: Schema.String,
  nodeId: EntityId
}) {}

/**
 * Creates a new pending `Node` (node.ts's `pending` field) and binds it into the chat's map
 * under `binding` in the same step — mirroring `multi-gadget.md`'s `createGadget(title,
 * bindingName)`: "the agent knows why it is requesting the resource and should pick the name
 * itself." `binding` is therefore an *input* here (the agent's choice), unlike `readNote`/
 * `editNote`/`addFact`/`addEdge`, where an existing binding is looked up.
 */
export class CreateNodeToolInput extends Schema.Class<CreateNodeToolInput>("CreateNodeToolInput")({
  chatId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  binding: ChatBindingName
}) {}

/** `nodeId` is included for tool-result content/replay bookkeeping (mirrors `multi-gadget.md`
 *  §Q15's `createGadget` recorded output keeping `gadgetId` "purely for replay bookkeeping...
 *  agents are never asked to use it"); the agent addresses the new node via `binding` from here
 *  on, never `nodeId` directly. */
export class CreateNodeToolOutput extends Schema.Class<CreateNodeToolOutput>("CreateNodeToolOutput")({
  binding: ChatBindingName,
  nodeId: EntityId
}) {}

/** Adds a pending `Fact` (fact.ts's `pending` field) to the node `binding` resolves to. */
export class AddFactToolInput extends Schema.Class<AddFactToolInput>("AddFactToolInput")({
  chatId: EntityId,
  binding: ChatBindingName,
  predicateId: Schema.String.pipe(Schema.minLength(1)),
  value: JsonValue
}) {}

export class AddFactToolOutput extends Schema.Class<AddFactToolOutput>("AddFactToolOutput")({
  factId: EntityId
}) {}

/** Adds a pending `Edge` (edge.ts's `pending` field) between two bound nodes. `relationDefinitionId`
 *  is a raw `EntityId`, not a binding — relation definitions are workspace-wide schema (like tags),
 *  not per-chat workpieces an agent turn introduces, so there is no binding-map entry for one to
 *  resolve. */
export class AddEdgeToolInput extends Schema.Class<AddEdgeToolInput>("AddEdgeToolInput")({
  chatId: EntityId,
  relationDefinitionId: EntityId,
  sourceBinding: ChatBindingName,
  targetBinding: ChatBindingName
}) {}

export class AddEdgeToolOutput extends Schema.Class<AddEdgeToolOutput>("AddEdgeToolOutput")({
  edgeId: EntityId
}) {}

/**
 * Links a calendar event to the node `binding` resolves to. **Phase 3 stub**: calendar doesn't
 * exist as a concept in Athenaeum until Phase 5 (plan §"Phased delivery": "Phase 5 — First
 * gatekeeper: Google Calendar + Bookmarks"), so there is no `calendarEvents` collection, no
 * gatekeeper, and no way to resolve `calendarEventId` against anything real yet. The schema pair
 * is declared now (per this task's instructions and the plan's "architect for the full feature
 * vision now" philosophy — the agent's system prompt / tool list can name `linkCalendarEvent` as
 * a known tool from Phase 3 onward, even before it does anything), but **every implementation of
 * this tool must fail immediately with `ToolNotImplemented` (errors.ts) before touching storage
 * or making any gatekeeper call** — there is nothing yet for it to do. `LinkCalendarEventToolOutput`
 * is declared for schema completeness/symmetry with the other five pairs; no code path can
 * currently produce one.
 */
export class LinkCalendarEventToolInput extends Schema.Class<LinkCalendarEventToolInput>(
  "LinkCalendarEventToolInput"
)({
  chatId: EntityId,
  binding: ChatBindingName,
  calendarEventId: Schema.String.pipe(Schema.minLength(1))
}) {}

export class LinkCalendarEventToolOutput extends Schema.Class<LinkCalendarEventToolOutput>(
  "LinkCalendarEventToolOutput"
)({
  linked: Schema.Boolean
}) {}

// --- App Library tools (App Library domain-extension task) -----------------------------------
//
// Mirrors `createNode`'s own tool/RPC split precisely (see app-rpc.ts's header comment): these
// two tools are the agent-facing front end that always operates inside a chat, always produces a
// pending row (a wholly new pending `App`, or an ahead-of-pointer pending `AppCodeVersion` — see
// app.ts's `AppCodeVersion` doc comment), and always resolves/binds through the chat-local
// `ChatBindingName` namespace (`AppBindingTarget`, chat-binding.ts) rather than a raw `EntityId` —
// exactly the same shape `CreateNodeToolInput`/`EditNoteToolInput` already establish above.

/** Creates a new, pending, codeless App (app.ts's `App`) and binds it into the chat's map under
 *  `binding` in the same step — mirrors `CreateNodeToolInput` field-for-field (`chatId`, `title`,
 *  `binding`), substituting `icon` for the one App-specific field `Node` doesn't have. As with
 *  `createNode`, `binding` is an *input* here (the agent's own choice of name), not a lookup. */
export class CreateAppToolInput extends Schema.Class<CreateAppToolInput>("CreateAppToolInput")({
  chatId: EntityId,
  title: Schema.String.pipe(Schema.minLength(1)),
  icon: AppIcon,
  binding: ChatBindingName
}) {}

/** `appId` is included for tool-result content/replay bookkeeping only, mirroring
 *  `CreateNodeToolOutput`'s own doc comment verbatim ("the agent addresses the new node via
 *  `binding` from here on, never `nodeId` directly") — substitute App for node throughout. */
export class CreateAppToolOutput extends Schema.Class<CreateAppToolOutput>("CreateAppToolOutput")({
  binding: ChatBindingName,
  appId: EntityId
}) {}

/**
 * Proposes a new version of the App `binding` resolves to, for one `kind` — writes an
 * ahead-of-pointer, pending `AppCodeVersion` row (app.ts's own doc comment on that class is the
 * full mechanism spec) rather than ever writing mainline code directly, per this task's hard
 * constraint that agent-authored app edits reuse the provisional/pending/accept-revert mechanism.
 * `binding` may name either an App this same chat created via `createApp` earlier in the turn, or
 * a pre-existing mainline App resolved into this chat's binding map by the naming chokepoint
 * (backend concern, mirrors `editNote`'s identical `binding`-resolution story — see
 * `ReadNoteToolInput`'s doc comment above for that precedent).
 */
export class UpdateAppCodeToolInput extends Schema.Class<UpdateAppCodeToolInput>(
  "UpdateAppCodeToolInput"
)({
  chatId: EntityId,
  binding: ChatBindingName,
  kind: AppCodeKind,
  code: Schema.String
}) {}

/** `version` is the new (pending, ahead-of-pointer) `AppCodeVersion.version` this call just
 *  created — included so a reviewing client can render "proposed server code v3" in an
 *  accept/revert summary, mirroring `EditNoteToolOutput.nodeId`'s own "client discoverability
 *  metadata" rationale (this file, above): a client collects these across a chat's tool-call log
 *  to build its App accept/revert UI the same way it does for `editNote`'s forked note edits. */
export class UpdateAppCodeToolOutput extends Schema.Class<UpdateAppCodeToolOutput>(
  "UpdateAppCodeToolOutput"
)({
  binding: ChatBindingName,
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))
}) {}

// --- Supertag-centering pass: agent tools (docs/supertag-centering-decisions.md) --------------
//
// Two new tools, agent-facing front ends to `graph-rpc.ts`'s `defineTagField`/`applySupertag`.
// Schema layer only, same caveat as every other pair in this file: not yet wired into
// `ToolSpec`/`ModelClient`, no `agent-edit-service-live.ts` dispatch implementation. Per this
// pass's own hard constraint, any later verification of these tools' dispatch must use
// `ModelClientScripted` (`packages/backend/src/model-client-scripted.ts`) — there is no live LLM
// key in this repo, same as every prior pass.
//
// `tagId` is a raw `EntityId` in both, not a `ChatBindingName`, in both tools below — tags are
// workspace-wide schema, not per-chat workpieces an agent turn introduces, exactly the precedent
// `AddEdgeToolInput.relationDefinitionId`'s own doc comment already sets ("relation definitions
// are workspace-wide schema (like tags)... so there is no binding-map entry for one to resolve").

/**
 * Agent-facing front end to `defineTagField` (graph-rpc.ts) — lets an agent add a new field to an
 * existing Supertag mid-conversation (e.g. "add a 'birthday' field to Person while we're at it")
 * without a human first visiting the `/supertags` admin page, mirroring the inline `#`-picker's
 * own "+ Add field" affordance (decisions doc §2) but agent-initiated. `chatId` is present only
 * for tool-dispatch bookkeeping (which chat's tool-call log this entry belongs to) — defining a
 * field is a mainline schema mutation with no pending/fork concept of its own (like `createTag`
 * itself, which also has no dedicated agent tool), so this produces no pending row.
 */
export class DefineSupertagToolInput extends Schema.Class<DefineSupertagToolInput>(
  "DefineSupertagToolInput"
)({
  chatId: EntityId,
  tagId: EntityId,
  name: Schema.String.pipe(Schema.minLength(1)),
  valueKind: TagFieldValueKind,
  sortOrder: Schema.Number.pipe(Schema.int(), Schema.nonNegative())
}) {}

/** `fieldId` is included for tool-result content/replay bookkeeping only, mirroring
 *  `AddFactToolOutput.factId`'s own precedent — the agent addresses the field by name in its own
 *  reasoning, this id is not something a later tool call needs to pass back in. */
export class DefineSupertagToolOutput extends Schema.Class<DefineSupertagToolOutput>(
  "DefineSupertagToolOutput"
)({
  fieldId: EntityId
}) {}

/** One field value the `applySupertag` tool seeds when it tags a node — schema mirror of
 *  `graph-rpc.ts`'s `ApplySupertagFieldValue`, named `...Tool...` here to avoid colliding with
 *  that class in this package's flat `index.ts` re-export namespace. Kept as a distinct class
 *  (not a re-export) for the same reason every other tool pair in this file declares its own
 *  input/output shape rather than importing the raw-`EntityId` RPC schema directly: the tool
 *  boundary and the RPC boundary are allowed to diverge (e.g. a tool might resolve `binding`s the
 *  RPC never sees), even when, as here, the field shapes happen to be identical today. */
export class ApplySupertagToolFieldValue extends Schema.Class<ApplySupertagToolFieldValue>(
  "ApplySupertagToolFieldValue"
)({
  fieldId: EntityId,
  value: JsonValue
}) {}

/**
 * Agent-facing front end to `applySupertag` (graph-rpc.ts) — tags the node `binding` resolves to
 * with an existing Supertag and optionally seeds initial field values, in one tool call, mirroring
 * the inline `#`-UX's own "typing the tag and filling its fields is one motion" design (decisions
 * doc §2). `binding` (not a raw `nodeId`) since the target is very often a node this same chat
 * just created via `createNode` earlier in the turn — same resolution story as `addFact`'s/
 * `addEdge`'s own bindings (`ReadNoteToolInput`'s doc comment above). `tagId` is raw (workspace-
 * wide schema; see this section's header comment).
 *
 * Produces PENDING `Fact`s for any `fieldValues` supplied, mirroring `AddFactToolInput`/
 * `Fact.pending` exactly — the tag *assignment* itself (`graph_node_tags`) has no pending/
 * accept-revert concept (`AssignTagOutput` never gained one), so only the field-value facts this
 * call may also create are subject to the chat's existing accept/revert flow.
 */
export class ApplySupertagToolInput extends Schema.Class<ApplySupertagToolInput>(
  "ApplySupertagToolInput"
)({
  chatId: EntityId,
  binding: ChatBindingName,
  tagId: EntityId,
  fieldValues: Schema.optional(Schema.Array(ApplySupertagToolFieldValue))
}) {}

/** `factIds` are included for tool-result content/replay bookkeeping, one per `fieldValues` entry
 *  in the same order, mirroring `AddFactToolOutput.factId`'s own precedent (plural here since a
 *  single `applySupertag` call may seed several fields' pending facts at once). */
export class ApplySupertagToolOutput extends Schema.Class<ApplySupertagToolOutput>(
  "ApplySupertagToolOutput"
)({
  tagId: EntityId,
  factIds: Schema.Array(EntityId)
}) {}
