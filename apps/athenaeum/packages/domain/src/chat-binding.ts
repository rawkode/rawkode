import * as Schema from "effect/Schema"
import { EntityId } from "./node.js"

// Phase 3 storage-schema task (plan: "Workpiece/binding model: cloudflare-os's per-chat named
// binding map... generalizes cleanly: the namespace becomes workspace-scoped: nodes ∪ gatekeeper
// bindings. Agent tools (readNote, editNote, createNode, addFact, addEdge, linkCalendarEvent)
// take a chat-local binding name resolved the same way — reuse the mechanism as designed").
// Adapted from `multi-gadget.md` Part 2's per-chat named binding map: **no gatekeepers exist in
// Athenaeum yet** (Phase 5+), so nothing in this codebase can construct a `"gatekeeperBinding"`
// target today — every binding a Phase 3 tool actually creates targets a node. The `"node" |
// "gatekeeperBinding"` union below is still declared in full, not narrowed to `"node"` alone,
// per the plan's own stated philosophy ("architect for the full feature vision now; deliver in
// phases... so later phases are additive, not reworks") — when a gatekeeper binding target type
// exists (Phase 5), it plugs into this already-shaped union instead of widening it then.

/**
 * The name-validation rule for a chat-local binding, per `multi-gadget.md`'s Part 2 "Name
 * validation" section (adapted to Athenaeum's two client languages): the name must be a valid
 * identifier in **both** JavaScript (the web client, agent tool arguments) and Swift (the native
 * client's mirrored env), so a single reserved-word list isn't enough — a name legal in one
 * language but reserved in the other would work on one client's env access and break the other's.
 * `multi-gadget.md`'s own validator only had to satisfy JS (cloudflare-os has no native client);
 * this is the one place that requirement doesn't carry over unchanged.
 *
 * Three checks, same order `multi-gadget.md` describes:
 * 1. Matches `^[A-Za-z_][A-Za-z0-9_]*$` — the intersection of JS's and Swift's basic identifier
 *    grammar (deliberately excluding JS's `$`, which Swift identifiers don't allow, and every
 *    non-ASCII identifier character both languages otherwise permit — ASCII-only keeps this
 *    predictable and matches this package's existing identifier-shaped values, e.g. `EntityId`).
 * 2. Not a JS or Swift reserved word.
 * 3. Not a "dangerous or confusing property name" (`multi-gadget.md`: "reject anything that
 *    exists on `Object.prototype`... plus `prototype` — these names would collide with inherited
 *    object members... anywhere a binding map is used as a plain object").
 *
 * `multi-gadget.md`'s `GADGET`-is-reserved carve-out has no Athenaeum analog: that name was
 * reserved because it was the gadget's *own* auto-injected self-binding inside its own env,
 * which nothing in this codebase's binding model has (chat bindings only ever point at other
 * entities, never at "the chat itself"). ALL_CAPS is style guidance only in `multi-gadget.md`
 * ("not enforced") and is not enforced here either, for the same reason: it's a convention for
 * generated/suggested names, not a schema-level constraint.
 */
const jsIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

const jsReservedWords: ReadonlySet<string> = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static", "await", "enum",
  "implements", "interface", "package", "private", "protected", "public"
])

const swiftReservedWords: ReadonlySet<string> = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import",
  "init", "inout", "internal", "let", "open", "operator", "private", "protocol", "public",
  "rethrows", "static", "struct", "subscript", "typealias", "var", "break", "case", "continue",
  "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return",
  "switch", "where", "while", "as", "Any", "catch", "false", "is", "nil", "self", "Self", "super",
  "throw", "throws", "true", "try"
])

const dangerousPropertyNames: ReadonlySet<string> = new Set([
  "__proto__", "constructor", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf",
  "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "prototype"
])

/** The predicate `ChatBindingName` below validates against — exported separately so backend
 *  code (the naming chokepoint's fallback suffixing, per `multi-gadget.md`'s "Fallback"
 *  paragraph) can check candidate names before constructing a `ChatBindingName` from them,
 *  without needing to go through `Schema.decodeUnknown` for a plain boolean check. */
export const isValidChatBindingName = (name: string): boolean =>
  jsIdentifierPattern.test(name) &&
  !jsReservedWords.has(name) &&
  !swiftReservedWords.has(name) &&
  !dangerousPropertyNames.has(name)

/** A chat-local binding name, validated per `isValidChatBindingName` above. Used both as
 *  `ChatBinding.name` and as the binding-name parameter type on every agent tool in
 *  agent-tools.ts (readNote/editNote/createNode/addFact/addEdge/linkCalendarEvent all resolve a
 *  target through this namespace instead of taking a raw `EntityId` — plan: "Agent tools...
 *  take a chat-local binding name... resolved the same way"). */
export const ChatBindingName = Schema.String.pipe(
  Schema.filter(isValidChatBindingName, {
    message: () =>
      "ChatBindingName must be a valid JS/Swift identifier, not a reserved word, and not a " +
      "dangerous property name (e.g. __proto__, constructor, prototype)"
  }),
  Schema.brand("ChatBindingName")
)
export type ChatBindingName = typeof ChatBindingName.Type

/** A binding pointing at a workspace node — the only target kind any Phase 3 code can actually
 *  construct (see this file's header comment). */
export class NodeBindingTarget extends Schema.Class<NodeBindingTarget>("NodeBindingTarget")({
  kind: Schema.Literal("node"),
  id: EntityId
}) {}

/** A binding pointing at a gatekeeper connection. No Athenaeum gatekeeper exists before Phase 5
 *  (plan §"Phased delivery"); this variant is declared now, for wire/forward compatibility, but
 *  nothing in this codebase constructs one yet — see this file's header comment. */
export class GatekeeperBindingTarget extends Schema.Class<GatekeeperBindingTarget>(
  "GatekeeperBindingTarget"
)({
  kind: Schema.Literal("gatekeeperBinding"),
  id: EntityId
}) {}

/** A binding pointing at an App Library entry (app.ts). Added by the App Library domain-extension
 *  task, following this file's own stated precedent to heart ("when a gatekeeper binding target
 *  type exists (Phase 5), it plugs into this already-shaped union instead of widening it then") —
 *  `CreateAppTool`/`UpdateAppCodeTool` (agent-tools.ts) resolve/bind an App through this target
 *  exactly the way `createNode`/`editNote` resolve/bind a `NodeBindingTarget`. */
export class AppBindingTarget extends Schema.Class<AppBindingTarget>("AppBindingTarget")({
  kind: Schema.Literal("app"),
  id: EntityId
}) {}

export const ChatBindingTarget = Schema.Union(NodeBindingTarget, GatekeeperBindingTarget, AppBindingTarget)
export type ChatBindingTarget = typeof ChatBindingTarget.Type

/** One entry of a chat-local binding map: `{name, target}`, per the plan's workpiece/binding-
 *  model paragraph. A full binding *map* is `ReadonlyArray<ChatBinding>` (or, storage-side, an
 *  indexed collection keyed by `(chatId, name)`) rather than a `Record<name, target>` object
 *  schema here — `ChatBindingName` is already validated to reject `Object.prototype`/`prototype`
 *  property names specifically so a binding map *can* safely be used as a plain object at the
 *  consuming end (agent tool execution, `env`-building) without that risk; encoding the map as a
 *  `Schema.Record` at the wire/domain-schema layer isn't needed to get that safety and would
 *  make each individual binding harder to reference (e.g. from `PendingMarker`-adjacent
 *  provisional-binding records, mirroring `multi-gadget.md`'s `BindingRecord.pending`) than a
 *  flat array of `{name, target}` rows is. */
export class ChatBinding extends Schema.Class<ChatBinding>("ChatBinding")({
  name: ChatBindingName,
  target: ChatBindingTarget
}) {}
