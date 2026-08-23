// The plan's "CI schema-diff check" (§"Repo/package layout": "native/AthenaeumDomain/ — Swift
// package mirroring domain/ types (hand-synced; CI schema-diff check)"; risk #7: "Swift↔TypeScript
// schema-drift tooling is named, not designed... scope it as real work, not an afterthought").
//
// What this does: for every `effect/Schema.Class` in `@athenaeum/domain` this package mirrors,
// compares its field-name set (`SomeClass.fields` — every `Schema.Class` exposes this at
// runtime) against the stored-property-name set of the corresponding Swift `struct` in
// `Sources/AthenaeumDomain/*.swift` (extracted by a small brace-depth-aware regex scan, not a
// full Swift parser). A field added on one side and forgotten on the other — the most common,
// most dangerous drift — fails loudly with a non-zero exit code and a clear diff. Deliberately
// modest per the plan's own framing ("even a field-name-set diff catches the most common
// drift"): it does not check field *types*, nor does it (yet) cover the union/enum-shaped
// schemas (`ViewPredicate`, `FieldRef`, `DomainError`) that aren't `Schema.Class`es — see
// `KNOWN_LIMITATIONS` below.
//
// Run with:
//   node --experimental-strip-types scripts/schema-diff.ts
//   (or `node scripts/schema-diff.ts` on Node >=23.6, type stripping is default)
//
// Requires `packages/domain`'s `dist/` to be built and current (see `generate-fixtures.ts`'s
// header comment — same requirement, same reason).

import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import * as domain from "../../../packages/domain/dist/index.js"

const here = dirname(fileURLToPath(import.meta.url))
const swiftSourcesDir = join(here, "..", "Sources", "AthenaeumDomain")

// --- TS side: pull `.fields` off every Schema.Class this package mirrors ----------------------
//
// Every `effect/Schema.Class`-derived class exposes a static `.fields` record at runtime (not
// just a compile-time type) — `Object.keys(SomeClass.fields)` is the authoritative field-name set
// straight from the schema definition, not re-derived from `.d.ts` output or hand-copied.

type TsSchemaClass = { readonly fields: Record<string, unknown> }

const isSchemaClass = (value: unknown): value is TsSchemaClass =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "fields" in (value as object) &&
  typeof (value as { fields: unknown }).fields === "object"

/**
 * `{ tsExportName, swiftStructName }` for every `Schema.Class` in `@athenaeum/domain` this
 * package mirrors as a Swift `struct`. Deliberately explicit (not "diff every export
 * automatically") — a few `@athenaeum/domain` exports are repositories/services/error classes
 * with no Swift mirror at all (out of `AthenaeumDomain`'s scope, see this package's own doc
 * comments), and auto-discovering "every `Schema.Class`-shaped export" would silently start
 * failing the build the day one of those unrelated exports happens to look schema-class-shaped.
 */
const MIRRORED_CLASSES: ReadonlyArray<{ tsExportName: string; swiftStructName: string }> = [
  { tsExportName: "Node", swiftStructName: "Node" },
  { tsExportName: "Page", swiftStructName: "Page" },
  { tsExportName: "Tag", swiftStructName: "Tag" },
  { tsExportName: "Fact", swiftStructName: "Fact" },
  { tsExportName: "RelationDefinition", swiftStructName: "RelationDefinition" },
  { tsExportName: "Edge", swiftStructName: "Edge" },
  { tsExportName: "GraphIssue", swiftStructName: "GraphIssue" },
  { tsExportName: "ViewSpec", swiftStructName: "ViewSpec" },
  { tsExportName: "SyncFeedEntry", swiftStructName: "SyncFeedEntry" },
  { tsExportName: "AutomergeSyncSession", swiftStructName: "AutomergeSyncSession" },
  { tsExportName: "RpcErrorEnvelope", swiftStructName: "RpcErrorEnvelope" },

  { tsExportName: "CreateNodeInput", swiftStructName: "CreateNodeInput" },
  { tsExportName: "CreateNodeOutput", swiftStructName: "CreateNodeOutput" },
  { tsExportName: "GetNodeInput", swiftStructName: "GetNodeInput" },
  { tsExportName: "GetNodeOutput", swiftStructName: "GetNodeOutput" },
  { tsExportName: "ListNodesInput", swiftStructName: "ListNodesInput" },
  { tsExportName: "ListNodesOutput", swiftStructName: "ListNodesOutput" },
  { tsExportName: "NodesChangedEvent", swiftStructName: "NodesChangedEvent" },

  { tsExportName: "CreateTagInput", swiftStructName: "CreateTagInput" },
  { tsExportName: "CreateTagOutput", swiftStructName: "CreateTagOutput" },
  { tsExportName: "AddFactInput", swiftStructName: "AddFactInput" },
  { tsExportName: "AddFactOutput", swiftStructName: "AddFactOutput" },
  { tsExportName: "CreateRelationDefinitionInput", swiftStructName: "CreateRelationDefinitionInput" },
  { tsExportName: "CreateRelationDefinitionOutput", swiftStructName: "CreateRelationDefinitionOutput" },
  { tsExportName: "CreateEdgeInput", swiftStructName: "CreateEdgeInput" },
  { tsExportName: "CreateEdgeOutput", swiftStructName: "CreateEdgeOutput" },
  { tsExportName: "RunViewInput", swiftStructName: "RunViewInput" },
  { tsExportName: "RunViewOutput", swiftStructName: "RunViewOutput" },
  { tsExportName: "ListBacklinksInput", swiftStructName: "ListBacklinksInput" },
  { tsExportName: "ListBacklinksOutput", swiftStructName: "ListBacklinksOutput" },
  { tsExportName: "ListGraphIssuesInput", swiftStructName: "ListGraphIssuesInput" },
  { tsExportName: "ListGraphIssuesOutput", swiftStructName: "ListGraphIssuesOutput" },
  { tsExportName: "TagClosureEntry", swiftStructName: "TagClosureEntry" },
  { tsExportName: "ListTagClosureInput", swiftStructName: "ListTagClosureInput" },
  { tsExportName: "ListTagClosureOutput", swiftStructName: "ListTagClosureOutput" },
  { tsExportName: "ListTagsInput", swiftStructName: "ListTagsInput" },
  { tsExportName: "ListTagsOutput", swiftStructName: "ListTagsOutput" },
  { tsExportName: "AssignTagInput", swiftStructName: "AssignTagInput" },
  { tsExportName: "AssignTagOutput", swiftStructName: "AssignTagOutput" },

  { tsExportName: "SearchNodesInput", swiftStructName: "SearchNodesInput" },
  { tsExportName: "SearchResultEntry", swiftStructName: "SearchResultEntry" },
  { tsExportName: "SearchNodesOutput", swiftStructName: "SearchNodesOutput" },

  { tsExportName: "CreatePageInput", swiftStructName: "CreatePageInput" },
  { tsExportName: "CreatePageOutput", swiftStructName: "CreatePageOutput" },
  { tsExportName: "GetPageTextInput", swiftStructName: "GetPageTextInput" },
  { tsExportName: "GetPageTextOutput", swiftStructName: "GetPageTextOutput" },
  { tsExportName: "ApplyPageEditInput", swiftStructName: "ApplyPageEditInput" },
  { tsExportName: "ApplyPageEditOutput", swiftStructName: "ApplyPageEditOutput" },

  { tsExportName: "StartPageSyncInput", swiftStructName: "StartPageSyncInput" },
  { tsExportName: "StartPageSyncOutput", swiftStructName: "StartPageSyncOutput" },
  { tsExportName: "PageSyncMessageInput", swiftStructName: "PageSyncMessageInput" },
  { tsExportName: "PageSyncMessageOutput", swiftStructName: "PageSyncMessageOutput" },
  { tsExportName: "SyncFeedInput", swiftStructName: "SyncFeedInput" },
  { tsExportName: "SyncFeedOutput", swiftStructName: "SyncFeedOutput" },
  { tsExportName: "RotateEpochInput", swiftStructName: "RotateEpochInput" },
  { tsExportName: "RotateEpochOutput", swiftStructName: "RotateEpochOutput" },

  // Phase 3 (`AgentEditService`): chat/changes/pending mirrors (native-driver stage).
  { tsExportName: "PendingMarker", swiftStructName: "PendingMarker" },
  { tsExportName: "ToolCallRequest", swiftStructName: "ToolCallRequest" },
  { tsExportName: "Chat", swiftStructName: "Chat" },
  { tsExportName: "ChatMessageRecord", swiftStructName: "ChatMessageRecord" },
  { tsExportName: "CreatedNodeSummary", swiftStructName: "CreatedNodeSummary" },
  { tsExportName: "AddedFactSummary", swiftStructName: "AddedFactSummary" },
  { tsExportName: "AddedEdgeSummary", swiftStructName: "AddedEdgeSummary" },
  { tsExportName: "NoteEditSummary", swiftStructName: "NoteEditSummary" },
  { tsExportName: "ChangesMessage", swiftStructName: "ChangesMessage" },

  { tsExportName: "CreateChatInput", swiftStructName: "CreateChatInput" },
  { tsExportName: "CreateChatOutput", swiftStructName: "CreateChatOutput" },
  { tsExportName: "ListChatsInput", swiftStructName: "ListChatsInput" },
  { tsExportName: "ListChatsOutput", swiftStructName: "ListChatsOutput" },
  { tsExportName: "GetChatInput", swiftStructName: "GetChatInput" },
  { tsExportName: "GetChatOutput", swiftStructName: "GetChatOutput" },
  { tsExportName: "SendChatMessageInput", swiftStructName: "SendChatMessageInput" },
  { tsExportName: "SendChatMessageOutput", swiftStructName: "SendChatMessageOutput" },
  { tsExportName: "MergeChangesInput", swiftStructName: "MergeChangesInput" },
  { tsExportName: "MergeChangesOutput", swiftStructName: "MergeChangesOutput" },
  { tsExportName: "RevertChangesInput", swiftStructName: "RevertChangesInput" },
  { tsExportName: "RevertChangesOutput", swiftStructName: "RevertChangesOutput" },
  { tsExportName: "ListChatChangesInput", swiftStructName: "ListChatChangesInput" },
  { tsExportName: "ListChatChangesOutput", swiftStructName: "ListChatChangesOutput" },
  { tsExportName: "ListPendingChangesInput", swiftStructName: "ListPendingChangesInput" },
  { tsExportName: "ListPendingChangesOutput", swiftStructName: "ListPendingChangesOutput" },

  // Phase 4 prerequisite (`auth.ts`): dev-auth identity wire schemas.
  { tsExportName: "AuthenticatedUser", swiftStructName: "AuthenticatedUser" },
  { tsExportName: "DevSignInInput", swiftStructName: "DevSignInInput" },
  { tsExportName: "DevSignInOutput", swiftStructName: "DevSignInOutput" },
  { tsExportName: "WhoamiOutput", swiftStructName: "WhoamiOutput" },

  // Phase 4 (`sharing.ts`): permission-graph/share-link/workspace-catalog entity mirrors.
  { tsExportName: "UserEdge", swiftStructName: "UserEdge" },
  { tsExportName: "ShareLinkEdge", swiftStructName: "ShareLinkEdge" },
  { tsExportName: "Collaborator", swiftStructName: "Collaborator" },
  { tsExportName: "CollaboratorInfo", swiftStructName: "CollaboratorInfo" },
  { tsExportName: "ShareLink", swiftStructName: "ShareLink" },
  { tsExportName: "ShareKeyRecord", swiftStructName: "ShareKeyRecord" },
  { tsExportName: "AffectedCollaborator", swiftStructName: "AffectedCollaborator" },
  { tsExportName: "WorkspaceCatalogEntry", swiftStructName: "WorkspaceCatalogEntry" },

  // Phase 4 (`sharing-rpc.ts`): sharing/multi-workspace RPC wire schemas.
  { tsExportName: "CreateWorkspaceInput", swiftStructName: "CreateWorkspaceInput" },
  { tsExportName: "CreateWorkspaceOutput", swiftStructName: "CreateWorkspaceOutput" },
  { tsExportName: "ListWorkspacesInput", swiftStructName: "ListWorkspacesInput" },
  { tsExportName: "ListWorkspacesOutput", swiftStructName: "ListWorkspacesOutput" },
  { tsExportName: "AddCollaboratorInput", swiftStructName: "AddCollaboratorInput" },
  { tsExportName: "AddCollaboratorOutput", swiftStructName: "AddCollaboratorOutput" },
  { tsExportName: "RemoveCollaboratorInput", swiftStructName: "RemoveCollaboratorInput" },
  { tsExportName: "RemoveCollaboratorOutput", swiftStructName: "RemoveCollaboratorOutput" },
  { tsExportName: "PreviewRemoveCollaboratorInput", swiftStructName: "PreviewRemoveCollaboratorInput" },
  { tsExportName: "PreviewRemoveCollaboratorOutput", swiftStructName: "PreviewRemoveCollaboratorOutput" },
  { tsExportName: "ListCollaboratorsInput", swiftStructName: "ListCollaboratorsInput" },
  { tsExportName: "ListCollaboratorsOutput", swiftStructName: "ListCollaboratorsOutput" },
  { tsExportName: "CreateShareLinkInput", swiftStructName: "CreateShareLinkInput" },
  { tsExportName: "CreateShareLinkOutput", swiftStructName: "CreateShareLinkOutput" },
  { tsExportName: "RedeemShareLinkInput", swiftStructName: "RedeemShareLinkInput" },
  { tsExportName: "RedeemShareLinkOutput", swiftStructName: "RedeemShareLinkOutput" },
  { tsExportName: "RevokeShareLinkInput", swiftStructName: "RevokeShareLinkInput" },
  { tsExportName: "RevokeShareLinkOutput", swiftStructName: "RevokeShareLinkOutput" },
  { tsExportName: "PreviewRevokeShareLinkInput", swiftStructName: "PreviewRevokeShareLinkInput" },
  { tsExportName: "PreviewRevokeShareLinkOutput", swiftStructName: "PreviewRevokeShareLinkOutput" },
  { tsExportName: "ListShareLinksInput", swiftStructName: "ListShareLinksInput" },
  { tsExportName: "ListShareLinksOutput", swiftStructName: "ListShareLinksOutput" },

  // Phase 5 native stage (`calendar-event.ts`/`bookmark.ts`/`gatekeeper-binding.ts`/
  // `gatekeeper-rpc.ts`): calendar/bookmarks/gatekeeper-binding entity + RPC wire mirrors.
  { tsExportName: "CalendarEventAttendee", swiftStructName: "CalendarEventAttendee" },
  { tsExportName: "CalendarEvent", swiftStructName: "CalendarEvent" },
  { tsExportName: "Bookmark", swiftStructName: "Bookmark" },
  { tsExportName: "GoogleCalendarBindingConfig", swiftStructName: "GoogleCalendarBindingConfig" },
  { tsExportName: "GatekeeperBinding", swiftStructName: "GatekeeperBinding" },

  { tsExportName: "ConnectGoogleCalendarInput", swiftStructName: "ConnectGoogleCalendarInput" },
  { tsExportName: "ConnectGoogleCalendarOutput", swiftStructName: "ConnectGoogleCalendarOutput" },
  { tsExportName: "GoogleCalendarOAuthCallbackInput", swiftStructName: "GoogleCalendarOAuthCallbackInput" },
  { tsExportName: "GoogleCalendarOAuthCallbackOutput", swiftStructName: "GoogleCalendarOAuthCallbackOutput" },
  { tsExportName: "DisconnectGoogleCalendarInput", swiftStructName: "DisconnectGoogleCalendarInput" },
  { tsExportName: "DisconnectGoogleCalendarOutput", swiftStructName: "DisconnectGoogleCalendarOutput" },
  { tsExportName: "SyncGoogleCalendarInput", swiftStructName: "SyncGoogleCalendarInput" },
  { tsExportName: "SyncGoogleCalendarOutput", swiftStructName: "SyncGoogleCalendarOutput" },
  { tsExportName: "ListCalendarEventsInput", swiftStructName: "ListCalendarEventsInput" },
  { tsExportName: "ListCalendarEventsOutput", swiftStructName: "ListCalendarEventsOutput" },
  { tsExportName: "LinkCalendarEventToNodeInput", swiftStructName: "LinkCalendarEventToNodeInput" },
  { tsExportName: "LinkCalendarEventToNodeOutput", swiftStructName: "LinkCalendarEventToNodeOutput" },
  { tsExportName: "CreateBookmarkInput", swiftStructName: "CreateBookmarkInput" },
  { tsExportName: "CreateBookmarkOutput", swiftStructName: "CreateBookmarkOutput" },
  { tsExportName: "ListBookmarksInput", swiftStructName: "ListBookmarksInput" },
  { tsExportName: "ListBookmarksOutput", swiftStructName: "ListBookmarksOutput" }
]

const KNOWN_LIMITATIONS = [
  "Field *types* are not compared, only field-name sets (a String vs. Int mismatch of the same name is not caught).",
  "ViewPredicate/FieldRef (view-spec.ts) and DomainError (errors.ts/RpcError.swift's enum) are TS Schema.Union / tagged-variant shapes, not Schema.Class — not diffed by this tool (their Swift mirrors are hand-verified against the TS union's discriminant+payload shape instead, see ViewSpec.swift's/RpcError.swift's own doc comments).",
  "RelationCardinality/GraphIssueKind/SyncOperation/ViewRenderMode/GraphViewName (TS Schema.Literal unions) are diffed nowhere automatically — a case added to a TS literal union without a matching Swift enum case only surfaces as a decode failure at runtime, not at this tool's check time.",
  "EntityId/IsoDateTimeString/WorkspaceEpoch (branded scalars, no fields) are out of scope for a field-name diff by construction.",
  "Role (sharing.ts's build/use Schema.Literal union) and ShareKeyHash (a branded scalar, like EntityId) are likewise out of scope for a field-name diff — Role is diffed nowhere automatically (same limitation as RelationCardinality etc., above); ShareKeyHash's Swift mirror is hand-verified against sharing.ts's own regex.",
  "PermissionEdge (sharing.ts's Schema.Union(UserEdge, ShareLinkEdge)) is not itself diffed — only its two member classes (UserEdge, ShareLinkEdge) are, individually, via MIRRORED_CLASSES; the Swift-side tagged-union Codable dispatch (Sharing.swift) is hand-verified against the TS union's shared `type` discriminant, same convention as ViewSpec.swift/RpcError.swift.",
  "Phase 5 native stage additions follow the identical existing pattern, not a new gap: CalendarEventTime (calendar-event.ts's Schema.Union, hand-Codable in CalendarEvent.swift, same convention as PermissionEdge/ViewPredicate), CalendarEventStatus/GatekeeperKind (Schema.Literal unions, like RelationCardinality — diffed nowhere automatically), BookmarkUrl (a branded scalar, like ShareKeyHash/EntityId — out of scope for a field-name diff by construction), and GatekeeperBindingConfig (gatekeeper-binding.ts's Schema.Union(GoogleCalendarBindingConfig), one real member today — only that member is diffed via MIRRORED_CLASSES, same convention as PermissionEdge above)."
]

// --- Swift side: extract stored-property names per top-level struct ---------------------------

interface SwiftStructFields {
  readonly file: string
  readonly fields: ReadonlySet<string>
}

/**
 * Scans one Swift source file and returns every top-level `struct Name: ... { ... }` found,
 * mapped to the `public let <name>:` stored-property names declared directly inside it (brace-
 * depth aware, so a nested type or a computed property's own braces don't get misattributed).
 * Deliberately regex/brace-counting based, not a real Swift parser — see this file's header
 * comment for why that's an acceptable, documented scope for this tool.
 */
function extractSwiftStructs(source: string, file: string): Map<string, SwiftStructFields> {
  const result = new Map<string, SwiftStructFields>()
  // Anchored to the start of a (trimmed) line — deliberately stricter than a bare `\bstruct\b`
  // scan: this file's own doc comments use the word "struct" in prose (e.g. "one Codable struct
  // per TS Schema.Class"), which a comment-blind scan would misfire on. A real struct
  // declaration always starts its line with an optional access modifier then `struct Name`.
  const structHeaderPattern = /^[ \t]*(?:public\s+|internal\s+|private\s+|fileprivate\s+)*struct\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{[ \t]*$/gm

  let match: RegExpExecArray | null
  while ((match = structHeaderPattern.exec(source)) !== null) {
    const structName = match[1]
    const bodyStart = match.index + match[0].length
    // Walk forward counting braces to find this struct's matching closing brace.
    let depth = 1
    let i = bodyStart
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++
      else if (source[i] === "}") depth--
      i++
    }
    const body = source.slice(bodyStart, i - 1)

    // Only stored properties directly at this struct's own depth (depth 0 relative to `body`) —
    // skip anything inside a further nested `{...}` (a nested type, a computed property's
    // getter, an inline closure default value, etc.).
    const fields = new Set<string>()
    let localDepth = 0
    const lines = body.split("\n")
    for (const line of lines) {
      const opens = (line.match(/\{/g) ?? []).length
      const closes = (line.match(/\}/g) ?? []).length
      if (localDepth === 0) {
        const fieldMatch = line.match(/^\s*public\s+let\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/)
        if (fieldMatch) fields.add(fieldMatch[1])
      }
      localDepth += opens - closes
    }

    result.set(structName, { file, fields })
  }
  return result
}

function loadAllSwiftStructs(): Map<string, SwiftStructFields> {
  const all = new Map<string, SwiftStructFields>()
  for (const entry of readdirSync(swiftSourcesDir)) {
    if (!entry.endsWith(".swift")) continue
    const path = join(swiftSourcesDir, entry)
    const source = readFileSync(path, "utf8")
    for (const [name, info] of extractSwiftStructs(source, entry)) {
      if (all.has(name)) {
        throw new Error(`Duplicate Swift struct name '${name}' found in both ${all.get(name)!.file} and ${entry}`)
      }
      all.set(name, info)
    }
  }
  return all
}

// --- Diff ---------------------------------------------------------------------------------------

interface Mismatch {
  readonly tsExportName: string
  readonly swiftStructName: string
  readonly missingInSwift: ReadonlyArray<string>
  readonly extraInSwift: ReadonlyArray<string>
  readonly swiftStructNotFound: boolean
}

function main(): number {
  const swiftStructs = loadAllSwiftStructs()
  const mismatches: Mismatch[] = []

  for (const { tsExportName, swiftStructName } of MIRRORED_CLASSES) {
    const tsClass = (domain as Record<string, unknown>)[tsExportName]
    if (!isSchemaClass(tsClass)) {
      throw new Error(
        `'${tsExportName}' is not exported from @athenaeum/domain as a Schema.Class with .fields — ` +
          `check MIRRORED_CLASSES / the domain package's index.ts exports.`
      )
    }
    const tsFields = new Set(Object.keys(tsClass.fields))
    const swiftInfo = swiftStructs.get(swiftStructName)

    if (!swiftInfo) {
      mismatches.push({
        tsExportName,
        swiftStructName,
        missingInSwift: [...tsFields],
        extraInSwift: [],
        swiftStructNotFound: true
      })
      continue
    }

    const missingInSwift = [...tsFields].filter((f) => !swiftInfo.fields.has(f)).sort()
    const extraInSwift = [...swiftInfo.fields].filter((f) => !tsFields.has(f)).sort()

    if (missingInSwift.length > 0 || extraInSwift.length > 0) {
      mismatches.push({ tsExportName, swiftStructName, missingInSwift, extraInSwift, swiftStructNotFound: false })
    }
  }

  console.log(`Checked ${MIRRORED_CLASSES.length} TS Schema.Class ⇄ Swift struct pairs.\n`)

  if (mismatches.length === 0) {
    console.log("✅ No field-name drift detected.\n")
    console.log("Known limitations of this check (documented, not bugs):")
    for (const limitation of KNOWN_LIMITATIONS) console.log(`  - ${limitation}`)
    return 0
  }

  console.error(`❌ Field-name drift detected in ${mismatches.length} type(s):\n`)
  for (const m of mismatches) {
    console.error(`  ${m.tsExportName} (TS) ⇄ ${m.swiftStructName} (Swift)`)
    if (m.swiftStructNotFound) {
      console.error(`    Swift struct '${m.swiftStructName}' not found in Sources/AthenaeumDomain/*.swift`)
      continue
    }
    if (m.missingInSwift.length > 0) {
      console.error(`    Missing in Swift: ${m.missingInSwift.join(", ")}`)
    }
    if (m.extraInSwift.length > 0) {
      console.error(`    Extra in Swift (not in TS schema): ${m.extraInSwift.join(", ")}`)
    }
  }
  return 1
}

process.exit(main())
