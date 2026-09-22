# Offline editor: bounded first slice

Architecture proposal, 13 September 2026. **Not implemented.** The native app
can restore cached day context, but its shared note editor still requires a
remote page and document request. This proposal adds local durability without
replacing the existing editor or its rich document format.

## Current implementation

- `website/src/pages/apple/editor.astro` mounts the editor-only surface and
  declares `data-native-editor-version="1"`.
- `website/src/components/NativeEditor.vue` owns document/entity navigation and
  asks the active pane to prepare before leaving.
- `website/src/components/Fieldnotes.vue` uses the shared Tiptap extensions and
  validates edits with `parseNote`. `loadToday()` waits for `readDocument()`
  before enabling editing. `prepareForTransition()` rejects active
  composition/invalid changes and flushes pending saves.
- `website/src/editor/documents.ts` reads via HTTP and keeps pending writes in
  memory. Its saver permits one in-flight POST, retains newer edits and stops on
  conflicts. There is no durable browser outbox.
- `website/src/editor/persistence.ts` handles validated Tiptap document
  replacement and export; it is not a local storage adapter.
- `packages/documents/src/note.ts` defines the canonical rich JSON schema and
  limits. `website/src/pages/api/documents/[id].ts` accepts that JSON plus
  `expectedRevision`. `core/documents/src/storage.ts` stores it in owner-scoped
  Durable Object SQLite through Drizzle, with revision checks and chunked
  content.
- `apple/Sources/Platform/NativeSession.swift` owns the authenticated WKWebView
  and network session. `apple/Sources/Platform/WebEditorController.swift` loads
  the remote page and checks readiness, navigation identity and previews.

No Loro or IndexedDB persistence was found in the current e2 editor. Introducing
Loro here would be a separate synchronization redesign, not reuse of its
existing persistence implementation.

## Proposed implementation boundary

Bundle a static native entry that imports the same `NativeEditor`, `Fieldnotes`,
Tiptap extensions and schema validator. Build the app's editor assets from those
sources; do not copy the component into a native-specific fork.

Inject a document transport at the shared editor persistence boundary. The web
implementation continues using HTTP. The Apple implementation uses a narrowly
scoped native bridge for document reads and durable local writes. Do not
globally intercept `fetch`, since entity operations and other requests have
different contracts.

Use one atomic native record per owner/document containing acknowledged server
revision/base JSON, working JSON, a local sequence and pending synchronization
state. This single record supplies both cached reads and the outbox. Preserve
the canonical JSON bytes/content rather than flattening the document into plain
text.

A successful local flush permits navigation and means **Saved on this device**.
Remote acknowledgement separately means **Synced**. Preserve composition checks,
selection behavior and the existing prepare-before-navigation contract. Native
network synchronization verifies the account and uses the existing document CAS
endpoint.

The first slice supports cached documents and new daily drafts, rich editing,
slash commands and existing entity references. Offer mentions/Supertags from an
explicit cached catalog where available. Canonical entity creation and uncached
entity-body editing remain unavailable until their own transport and identity
contracts are implemented. Do not fabricate successful entity operations.

## Blocking contracts to resolve before implementation

**Local and remote acknowledgements are different.** The current saver assumes a
successful HTTP response advances the server revision. Never synthesize that
response for a local save. Local sequence numbers and server revisions must
remain separate, including when editing continues during an upload.

**A bundled origin changes the security and save boundary.** `editorCanLeave()`
currently returns true for a URL outside the configured website origin. Merely
switching to bundled HTML would bypass the current guard. Controller readiness,
theme and preview checks also assume the remote host. Introduce an explicit
versioned bridge handshake and flush request; authorize only the bundled main
frame, current owner/document and active generation. JavaScript cannot choose an
owner or arbitrary endpoint. External pages and subframes receive no native
storage capability.

**Unknown is not absent.** A new offline daily draft has an unknown server base
until first reconciliation. A successful server read returning no document is
the only evidence for absence. If a document already exists, preserve both
versions and expose conflict resolution; do not silently overwrite it.

**CAS conflicts and lost responses need distinct handling.** Preserve both local
and remote rich documents after a 409. If a POST response is lost, compare a
fresh server read with the exact attempted payload before treating it as
acknowledged. Do not retry blindly with a newer revision. An older upload
response cannot clear or replace edits made after that upload began.

**Unsynchronized documents remain bound to their owner.** Sign-out/account
change must retain recoverable pending edits under the original owner while
hiding them from another account and stopping uploads. Decide the explicit
export/discard flow; existing connected-context clearing must not delete pending
note edits.

**Version the app/web contract.** Track bridge protocol, note schema and asset
build independently. Unsupported nodes or protocol versions must fail
recoverably without rewriting documents. Reuse the canonical JS validator and
server validation; native storage must enforce bounded envelopes and exact
document identity without inventing a second rich-text schema.

## Acceptance tests

1. Airplane-mode cold launch opens a cached rich note. Edit, force-quit and
   restart: every locally acknowledged edit survives.
2. Type or compose text, then immediately switch date or close the sheet.
   Reopening retains the final input; a failed local flush prevents departure.
3. Create a daily draft offline when that date already exists remotely.
   Reconnect: both versions survive and the app reports a conflict.
4. Reconnect an unchanged-base edit: upload succeeds once. Simulate a lost
   response and a subsequent remote edit; neither retry nor reconciliation
   overwrites it.
5. Edit while an upload is in flight. Its response cannot mark the newer local
   draft synchronized or restore the older text.
6. Simulate disk-full/atomic-write failure. The UI does not claim a local save.
7. Switch accounts with pending changes. No document, reference or queued upload
   crosses the owner boundary; the original edits remain recoverable.
8. Round-trip entity nodes, components, lists, code, Unicode and empty
   paragraphs through local storage, the shared editor and existing server
   validation.
9. Terminate the WebKit process after local acknowledgement. Restore the editor
   from native storage without fetching the remote page.
10. Load incompatible assets/schema or navigate externally. Deny bridge access,
    retain pending content and provide a recoverable explanation.

No implementation, deployment or offline device qualification is claimed by this
document. The next implementation step is the document transport/acknowledgement
contract and its failure tests, followed by bundle/bridge integration.
