import Foundation
import Automerge
import AthenaeumDomain

// `PageDocumentStore` — plan §"Repo/package layout"'s "Automerge integration" actor: real Text
// CRDT operations (init, local edit/splice, generate/receive sync message) for page bodies,
// matching what the backend's Automerge sync protocol (`notes-service-live.ts`) expects on the
// wire.
//
// **Content model, matched exactly to `notes-service-live.ts`'s `PageDoc`** (task item 2: "same
// message framing"): a single Text CRDT object stored at the document root under key `"text"`.
// The backend creates this via `Automerge.from<PageDoc>({text: ""})` in `@automerge/automerge`
// 3.x, whose plain-string-field-spliced-via-`Automerge.splice` API is, at the binary/CRDT level,
// the exact same `OBJTYPE_TEXT` representation `automerge-swift`'s explicit
// `doc.putObject(obj: ROOT, key: "text", ty: .Text)` produces (confirmed by the Decisions stage's
// `automerge-swift-spike`, and re-confirmed for real by this stage's own live end-to-end smoke
// test — see `WorkspaceSyncClientLiveTests.swift` — which syncs a server-created page down into a
// genuinely empty Swift `Document()` and reads its text back correctly, which would be impossible
// if the two representations didn't actually unify on the wire).
//
// **Why the client never independently creates the root `"text"` key** (mirrors
// `web/src/automerge-page.ts`'s `emptyPageDoc()` doc comment, reproduced here because the same
// bug class applies identically in Swift): `Automerge.from`/an eager `putObject` performs its own
// genesis commit, creating an *independent* Text object under a fresh actor id with no causal
// relationship to the server's own genesis object (minted once, server-side, in `createPage`).
// Merging two independently-created Text objects resolves as a map-key-level last-writer-wins
// conflict, not a character-level text merge — silently discarding one side's content. This store
// therefore only ever creates a page's `"text"` object in exactly one place
// (`WorkspaceSyncClient.createPage`, immediately after the *server* confirms genesis via the
// `createPage` RPC) and otherwise requires a doc to have already synced content in from the
// server (`ensureTextObjId` throws `.textNotYetSynced` rather than lazily creating one) before
// any local edit is accepted.
public enum PageDocumentStoreError: Error, Sendable, Equatable {
    case notLoaded(EntityId)
    /// A local edit or read was attempted before this node's page ever received real content
    /// from the server (no prior `loadFromSnapshot`/successful sync) — see this file's top doc
    /// comment for why this store refuses to paper over that with a locally-invented genesis
    /// Text object.
    case textNotYetSynced(EntityId)
    /// **Native safety pass** (`docs/rich-text-editor-decisions.md` item 6): this node's page uses
    /// the web rich-text editor's block/mark-shaped document (`schemaVersion >= 2`, or real
    /// block-marker structure detected directly), and native — automerge-swift 0.7.2, still
    /// flat-Text-only — refuses to originate a local edit against it. `automerge-swift-spike`'s
    /// `RichTextCompatTests.testNativeSpliceAcrossBlockMarkerDeletesTheMarker` proved, empirically,
    /// that an ordinary `spliceText` at an "innocent" index can silently delete a block-marker
    /// object, corrupting the document for every peer (including web) that later reads it. Reads
    /// and sync remain unaffected — only local-write attempts are refused.
    case richTextNoteReadOnlyOnNative(EntityId)
}

/// Owns one in-memory Automerge `Document` per node (this workspace's currently-open pages), plus the
/// low-level CRDT primitives `WorkspaceSyncClient` composes into the real sync-session network loop.
/// `Document`/`SyncState` are themselves `@unchecked Sendable` (automerge-swift 0.7.2 — verified
/// by reading `Sources/Automerge/Document.swift`/`SyncState.swift` in the Decisions stage's
/// checked-out package), so this store's methods take/return them freely; it is still built as
/// its own actor (not a plain class) to serialize concurrent access to the shared `docs` cache
/// the same way `LocalWorkspaceStore` serializes SQLite access — one logical owner per resource,
/// matching this package's overall actor-per-authority design.
public actor PageDocumentStore {
    private var docs: [String: Document] = [:]
    private var textObjIds: [String: ObjId] = [:]

    public init() {}

    /// Starts a brand-new, genuinely empty local replica for `nodeId` — the only safe starting
    /// point before a real sync exchange has happened (see top doc comment).
    public func loadEmpty(nodeId: EntityId) {
        docs[nodeId.rawValue] = Document()
        textObjIds.removeValue(forKey: nodeId.rawValue)
    }

    /// Loads a previously-saved snapshot (this device's own last-known-good state, from
    /// `LocalWorkspaceStore.pageDocBytes`) — analogous to the backend's `Automerge.load`.
    @discardableResult
    public func loadFromSnapshot(nodeId: EntityId, bytes: Data) throws -> String {
        let doc = try Document(bytes)
        docs[nodeId.rawValue] = doc
        textObjIds.removeValue(forKey: nodeId.rawValue)
        return try resolvedText(nodeId: nodeId, doc: doc)
    }

    // Deliberately no "create the text object locally right after the server confirms
    // `createPage`" convenience method here, even though it might look safe (the server's genesis
    // is also empty at that point): a locally-`putObject`-created Text object is still an
    // *independent* genesis under a fresh local actor id, causally unrelated to the server's own
    // genesis object, and merging the two later would still hit the map-key-conflict class this
    // file's top doc comment describes — emptiness doesn't make two independent CRDT objects the
    // same object. `WorkspaceSyncClient.resolveOrCreatePage` always goes through `loadEmpty` +
    // `runSyncSession` instead, exactly like `web/src/automerge-page.ts`'s `resolveDailyNote`
    // never creates `"text"` client-side either, for the same reason.

    public func isLoaded(nodeId: EntityId) -> Bool {
        docs[nodeId.rawValue] != nil
    }

    public func text(nodeId: EntityId) throws -> String {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        return try resolvedText(nodeId: nodeId, doc: doc)
    }

    private func resolvedText(nodeId: EntityId, doc: Document) throws -> String {
        guard let textId = try textObjId(nodeId: nodeId, doc: doc) else { return "" }
        return try doc.text(obj: textId)
    }

    // MARK: - Rich-text read-only detection (decisions doc item 6)

    /// `true` if this node's currently-loaded page uses the web rich-text editor's document shape
    /// and must therefore never receive a native-originated local edit. Safe to call any time
    /// after `isLoaded(nodeId:)` — including right after `loadFromSnapshot`/a sync receive, before
    /// the user has typed anything — so the UI can show its read-only banner proactively rather
    /// than only discovering the restriction via a failed `applyLocalSplice`.
    public func isRichTextNote(nodeId: EntityId) throws -> Bool {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        guard let textId = try textObjId(nodeId: nodeId, doc: doc) else { return false }
        return try isRichTextNote(doc: doc, textId: textId)
    }

    /// **Primary signal:** an explicit `schemaVersion` scalar at the document root (mirrors this
    /// repo's own "Editor document schema"/"Protocol versions" numbering convention —
    /// `new-notes/docs/architecture.md`'s "Protocol versions and limits" table — rather than
    /// inventing a parallel one); `>= 2` means "written by the rich-text editor". Absent/`1` means
    /// the pre-existing flat-Text scheme (implicit on every note that predates this pass).
    ///
    /// **Defense in depth, not trust-on-first-sight:** `schemaVersion` is just another piece of
    /// app-written state a future bug could fail to bump, so this is never the *only* check — see
    /// `containsBlockMarkers` below, which detects the actual hazardous structure directly and
    /// wins whenever the two signals disagree (fail closed).
    private func isRichTextNote(doc: Document, textId: ObjId) throws -> Bool {
        if let version = try schemaVersion(doc: doc), version >= 2 {
            return true
        }
        return try containsBlockMarkers(doc: doc, textId: textId)
    }

    private func schemaVersion(doc: Document) throws -> Int64? {
        guard let value = try doc.get(obj: ObjId.ROOT, key: "schemaVersion") else { return nil }
        switch value {
        case let .Scalar(.Int(v)): return v
        case let .Scalar(.Uint(v)): return Int64(v)
        default:
            // Present but not an integer — an unrecognized shape is exactly the case defense in
            // depth exists for; fall through to the structural check rather than assuming v1.
            return nil
        }
    }

    /// automerge-swift 0.7.2 has no block-marker-aware API at all (confirmed against
    /// `Sources/Automerge` in the Decisions stage — no `block`/`Block` symbol anywhere in the
    /// package); `.text(obj:)` is the only way to read a Text object, and it renders every block
    /// marker inline as a literal U+FFFC OBJECT REPLACEMENT CHARACTER
    /// (`RichTextCompatTests.testTextReadIsGarbledWithReplacementCharacters`, empirically proven
    /// against a real `@automerge/prosemirror`-shaped fixture). Scanning for that glyph is
    /// therefore the real, direct structural signal — not a heuristic layered on top of one.
    private func containsBlockMarkers(doc: Document, textId: ObjId) throws -> Bool {
        try doc.text(obj: textId).unicodeScalars.contains { $0.value == 0xFFFC }
    }

    /// Delete `deleteCount` UTF-16 code units starting at `index`, then insert `insertText` — the
    /// exact `(index, deleteCount, insertText)` shape `ApplyPageEditInput`
    /// (`packages/domain/src/page-rpc.ts`) and `web/src/automerge-page.ts`'s `applyLocalSplice`
    /// both use.
    @discardableResult
    public func applyLocalSplice(
        nodeId: EntityId,
        index: Int,
        deleteCount: Int,
        insertText: String
    ) throws -> String {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        guard let textId = try textObjId(nodeId: nodeId, doc: doc) else {
            throw PageDocumentStoreError.textNotYetSynced(nodeId)
        }
        // Native safety pass (decisions doc item 6) — refuse to originate a local edit against a
        // rich note's Text object at all; see `PageDocumentStoreError.richTextNoteReadOnlyOnNative`.
        guard try !isRichTextNote(doc: doc, textId: textId) else {
            throw PageDocumentStoreError.richTextNoteReadOnlyOnNative(nodeId)
        }
        try doc.spliceText(obj: textId, start: UInt64(index), delete: Int64(deleteCount), value: insertText)
        return try doc.text(obj: textId)
    }

    /// `Automerge.save()` — this node's full current document state, the bytes `LocalWorkspaceStore`
    /// durably persists after every local edit and after every sync round (task item 1's
    /// "durable-before-sync": the SQLite write happens in `WorkspaceSyncClient`, using bytes read
    /// from here).
    public func snapshotBytes(nodeId: EntityId) throws -> Data {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        return doc.save()
    }

    /// Mirrors `notes-service-live.ts`'s `headsHashOf` (`Automerge.getHeads(doc).slice().sort()
    /// .join(",")`) — sorted, comma-joined hex change hashes. Purely a local bookkeeping value
    /// (stored in `LocalWorkspaceStore`'s `pages.heads_hash` column so a future stage can cheaply
    /// detect "did this page change since I last looked" without decoding the doc); the sync
    /// protocol itself never compares this string against the server's own copy of it — Automerge
    /// convergence is verified by the real sync-message exchange, not by matching hash strings.
    public func headsHash(nodeId: EntityId) throws -> String {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        return doc.heads().map(\.debugDescription).sorted().joined(separator: ",")
    }

    // MARK: - Sync-session primitives (composed by `WorkspaceSyncClient.syncPage` into the real
    // multi-round-trip exchange, mirroring `web/src/automerge-page.ts`'s `syncPageWithServer`)

    public func generateSyncMessage(nodeId: EntityId, state: SyncState) throws -> Data? {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        return doc.generateSyncMessage(state: state)
    }

    public func receiveSyncMessage(nodeId: EntityId, state: SyncState, message: Data) throws {
        guard let doc = docs[nodeId.rawValue] else { throw PageDocumentStoreError.notLoaded(nodeId) }
        try doc.receiveSyncMessage(state: state, message: message)
        // A receive can be the very first time this doc learns about the server's `"text"`
        // object (e.g. starting from `loadEmpty`) — refresh the cached objId so the next
        // `text(nodeId:)`/`applyLocalSplice` call sees it without needing its own lookup.
        _ = try? textObjId(nodeId: nodeId, doc: doc)
    }

    /// Resolves (and caches) the root `"text"` object's id by reading it out of the document —
    /// never creates one (see top doc comment); returns `nil` if the doc has no `"text"` key yet
    /// (a genuinely empty/not-yet-synced local replica).
    @discardableResult
    private func textObjId(nodeId: EntityId, doc: Document) throws -> ObjId? {
        if let cached = textObjIds[nodeId.rawValue] { return cached }
        guard case let .Object(id, .Text) = try doc.get(obj: ObjId.ROOT, key: "text") else {
            return nil
        }
        textObjIds[nodeId.rawValue] = id
        return id
    }
}
