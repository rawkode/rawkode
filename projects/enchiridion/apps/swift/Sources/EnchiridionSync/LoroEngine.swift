// LoroEngine.swift
// EnchiridionSync
//
// Concrete `CRDTEngine` over loro-swift.
//
// Verification note (see Package.swift's dependency comment for the
// version-pin story): every loro-swift API referenced below was confirmed
// against the ACTUAL source of the pinned tag, fetched directly from
// GitHub in this sandbox —
// https://raw.githubusercontent.com/loro-dev/loro-swift/1.13.3/Sources/Loro/LoroFFI.swift
// (the generated UniFFI bindings, ~18.8k lines) plus the hand-written
// extensions in Sources/Loro/{Container,Value}.swift at the same tag. None
// of the calls in this file are guesses — there is no `TODO(verify-loro-api)`
// tag anywhere here because nothing needed one. Where a comment cites
// "LoroFFI.swift", that's this file, at this tag.
//
// One real API constraint worth calling out because it shapes this file's
// design, not because it's uncertain: `LoroText.mark(...)` throws
// `LoroError.StyleConfigMissing` for any mark `key` the document hasn't been
// configured for via `configTextStyle`. Loro has no wildcard/catch-all style
// config, so `LoroEngine` pre-registers a fixed vocabulary of marks
// (`LoroEngine.MarkStyle`) at document creation. A `CRDTMutation.textMark`
// with a key outside that vocabulary throws `CRDTEngineError.engineFailure`
// — expanding the vocabulary is a one-line change in `defaultTextStyle()`,
// not a redesign.

import EnchiridionCore
import Foundation
import Loro

/// `CRDTEngine` implementation backed by loro-swift (`Loro.LoroDoc`).
///
/// An `actor` because `CRDTEngine` conformers must serialize concurrent
/// access to shared document state (the sync client, local edits from the
/// UI, and reprojection triggers all touch the same documents), and because
/// `LoroDoc` itself, while `@unchecked Sendable`, is not internally
/// synchronized — Loro's own docs assume single-threaded access per
/// document instance.
public actor LoroEngine: CRDTEngine {
  /// The fixed vocabulary of rich-text mark keys this engine configures
  /// Loro to accept. See the file-level note on `StyleConfigMissing`.
  ///
  /// Expand policy choices here are a product decision (how a mark behaves
  /// when you type at its boundary), not an API-uncertainty guess:
  /// - Character-level styling (bold/italic/underline/strikethrough)
  ///   defaults to `.after` — continuing to type at the end of a bold run
  ///   stays bold, matching most rich text editors' feel.
  /// - `code` defaults to `.none` — you don't want inline code silently
  ///   swallowing whatever you type next to it.
  /// - `pageReference` (the plan's page-reference-in-body-text mark)
  ///   defaults to `.none` — extending a reference span by typing adjacent
  ///   text would silently redefine what the reference "means".
  /// - `attachment` (P7 "native drawing canvas" task — plan §Core Product
  ///   UI (P7), track 5: "an embed/attachment mechanism so a canvas can be
  ///   referenced from within a page's body text") defaults to `.none` for
  ///   the same reason as `pageReference`: typing adjacent to an embedded
  ///   canvas/image must never silently fold that typed text into what the
  ///   attachment "covers".
  public enum MarkStyle: String, CaseIterable, Sendable {
    case bold
    case italic
    case underline
    case strikethrough
    case code
    case pageReference
    case attachment

    // `internal` (not `fileprivate`): `PageDocument` (PageDocument.swift,
    // same module) reuses this exact expand-policy table via
    // `LoroEngine.makeConfiguredDocument()` below so a page document's rich
    // text and a bare `CRDTMutation`-driven document (this engine's other
    // callers) are always configured identically — one source of truth for
    // "what happens when you type at a mark's boundary", not two that could
    // drift.
    var expand: ExpandType {
      switch self {
      case .bold, .italic, .underline, .strikethrough:
        return .after
      case .code, .pageReference, .attachment:
        return .none
      }
    }
  }

  private var documents: [PageID: LoroDoc] = [:]
  private var sequence: UInt64 = 0
  private var lastChangedSequence: [PageID: UInt64] = [:]

  public init() {}

  // MARK: - CRDTEngine

  public func createDocument(id: PageID) async throws {
    guard documents[id] == nil else {
      throw CRDTEngineError.engineFailure("document \(id.rawValue) already exists")
    }
    documents[id] = makeConfiguredDocument()
  }

  public func hasDocument(id: PageID) async -> Bool {
    documents[id] != nil
  }

  public func apply(_ mutation: CRDTMutation, to id: PageID) async throws {
    let doc = documentCreatingIfNeeded(id: id)
    try applyMutation(mutation, to: doc)
    // LoroFFI.swift LoroDocProtocol.commit(): "Commit the cumulative auto
    // commit transaction ... The events will be emitted after a
    // transaction is committed." Every container mutation above is
    // auto-committed as a transaction internally, but we commit explicitly
    // so `oplogVv`/export calls immediately below (from any concurrent
    // actor call) observe this edit — matching the doc comment's list of
    // implicit-commit triggers, made explicit here for clarity.
    doc.commit()
    markChanged(id)
  }

  public func versionVector(of id: PageID) async throws -> Data {
    let doc = documentCreatingIfNeeded(id: id)
    // LoroFFI.swift LoroDocProtocol.oplogVv(): "the VersionVector of the
    // OpLog" — the full set of ops the engine has for this doc, which is
    // exactly what a peer needs to know to compute what to send us next.
    return doc.oplogVv().encode()
  }

  public func exportUpdates(of id: PageID, since versionVector: Data) async throws -> Data {
    let doc = documentCreatingIfNeeded(id: id)
    let vv = try decodeVersionVector(versionVector)
    do {
      // LoroFFI.swift ExportMode.updates(from:) + LoroDocProtocol.export(mode:):
      // "Export all the ops not included in the given VersionVector."
      return try doc.export(mode: .updates(from: vv))
    } catch {
      throw CRDTEngineError.engineFailure(String(describing: error))
    }
  }

  public func exportSnapshot(of id: PageID) async throws -> Data {
    let doc = documentCreatingIfNeeded(id: id)
    do {
      // LoroFFI.swift LoroDocProtocol.exportSnapshot(): "Export the current
      // state and history of the document."
      return try doc.exportSnapshot()
    } catch {
      throw CRDTEngineError.engineFailure(String(describing: error))
    }
  }

  public func exportShallowSnapshot(of id: PageID) async throws -> Data {
    let doc = documentCreatingIfNeeded(id: id)
    do {
      // LoroFFI.swift ExportMode.shallowSnapshot(frontiers:): a snapshot of
      // current state without full history. `oplogFrontiers()` ("the
      // Frontiers version of the OpLog") gives the latest point to shallow
      // -snapshot at, matching the plan's compaction-horizon fallback.
      return try doc.export(mode: .shallowSnapshot(frontiers: doc.oplogFrontiers()))
    } catch {
      throw CRDTEngineError.engineFailure(String(describing: error))
    }
  }

  @discardableResult
  public func importBytes(_ bytes: Data, into id: PageID) async throws -> CRDTImportOutcome {
    let doc = documentCreatingIfNeeded(id: id)
    do {
      // LoroFFI.swift LoroDocProtocol.`import`(bytes:) — named `import`
      // in Rust/the FFI signature; Swift requires backticks because
      // `import` is a keyword. Accepts either an update or a full
      // snapshot exported by this or a peer LoroDoc and merges it,
      // returning which peers' ops were actually applied (`success`) vs.
      // still blocked on missing causal dependencies (`pending`).
      let status = try doc.`import`(bytes: bytes)
      let changed = !status.success.isEmpty
      let pending = !(status.pending?.isEmpty ?? true)
      if changed {
        markChanged(id)
      }
      return CRDTImportOutcome(changedState: changed, hasPendingDependencies: pending)
    } catch {
      throw CRDTEngineError.engineFailure(String(describing: error))
    }
  }

  public func changedDocuments(since sequence: UInt64) async -> (ids: [PageID], sequence: UInt64) {
    let ids = lastChangedSequence.compactMap { key, value in
      value > sequence ? key : nil
    }
    return (ids, self.sequence)
  }

  // MARK: - Document lifecycle

  private func documentCreatingIfNeeded(id: PageID) -> LoroDoc {
    if let existing = documents[id] {
      return existing
    }
    let doc = makeConfiguredDocument()
    documents[id] = doc
    return doc
  }

  private func makeConfiguredDocument() -> LoroDoc {
    Self.makeConfiguredDocument()
  }

  /// `static` and `internal` so `PageDocument` can create Loro documents
  /// with this engine's exact mark vocabulary without going through a
  /// `LoroEngine` instance (actor-isolated, and keyed by `PageID` — neither
  /// of which `PageDocument`'s snapshot-in/snapshot-out functions need).
  /// See the file-level note on `StyleConfigMissing` for why every document
  /// must be configured this way before any mark is applied.
  static func makeConfiguredDocument() -> LoroDoc {
    // LoroFFI.swift: `public convenience init()` on LoroDoc — "Create a
    // new LoroDoc instance."
    let doc = LoroDoc()
    doc.configTextStyle(textStyle: defaultTextStyle())
    return doc
  }

  private static func defaultTextStyle() -> StyleConfigMap {
    // LoroFFI.swift StyleConfigMap(): plain `public convenience init()`,
    // then `.insert(key:value:)` per StyleConfigMapProtocol.
    let map = StyleConfigMap()
    for style in MarkStyle.allCases {
      map.insert(key: style.rawValue, value: StyleConfig(expand: style.expand))
    }
    return map
  }

  private func markChanged(_ id: PageID) {
    sequence += 1
    lastChangedSequence[id] = sequence
  }

  // MARK: - Mutation application

  private func applyMutation(_ mutation: CRDTMutation, to doc: LoroDoc) throws {
    do {
      switch mutation {
      case .textInsert(let container, let position, let text):
        // LoroFFI.swift LoroDocProtocol.getText(id: ContainerIdLike) ->
        // LoroText (String conforms to ContainerIdLike via
        // Sources/Loro/Container.swift: `.root(name: self, containerType:
        // ty)`), then LoroTextProtocol.insert(pos:s:).
        try doc.getText(id: container).insert(pos: position, s: text)

      case .textDelete(let container, let position, let length):
        // LoroTextProtocol.delete(pos:len:): "Delete a range of text at
        // the given unicode position with unicode length."
        try doc.getText(id: container).delete(pos: position, len: length)

      case .textMark(let container, let range, let key, let value):
        guard let style = MarkStyle(rawValue: key) else {
          throw CRDTEngineError.engineFailure(
            "mark key \"\(key)\" is not in LoroEngine.MarkStyle's configured vocabulary"
          )
        }
        let text = doc.getText(id: container)
        if let value {
          // Sources/Loro/Container.swift LoroText extension:
          // `mark(from:to:key:value: LoroValueLike?)` wraps the throwing
          // protocol method, substituting `.null` for a nil value.
          try text.mark(
            from: range.lowerBound, to: range.upperBound, key: style.rawValue,
            value: Self.loroValue(value))
        } else {
          // LoroTextProtocol.unmark(from:to:key:).
          try text.unmark(from: range.lowerBound, to: range.upperBound, key: style.rawValue)
        }

      case .mapSet(let container, let key, let value):
        // LoroDocProtocol.getMap(id:) -> LoroMap, then the Container.swift
        // extension `insert(key:v: LoroValueLike?)`.
        try doc.getMap(id: container).insert(key: key, v: Self.loroValue(value))

      case .mapDelete(let container, let key):
        // LoroMapProtocol.delete(key:): "Delete a key-value pair from the
        // map."
        try doc.getMap(id: container).delete(key: key)
      }
    } catch let error as CRDTEngineError {
      throw error
    } catch {
      throw CRDTEngineError.engineFailure(String(describing: error))
    }
  }

  // `static` and `internal` (not `private`/instance): doesn't touch `self`,
  // and `PageDocument` (PageDocument.swift, same module) reuses this exact
  // `CRDTValue -> LoroValue` mapping for the mark values it writes, so
  // there is one conversion table, not two that could drift.
  static func loroValue(_ value: CRDTValue) -> LoroValue {
    // LoroFFI.swift `public enum LoroValue`: .null/.bool/.double/.i64/
    // .binary/.string/.list/.map/.container. `LoroValue` itself conforms
    // to `LoroValueLike` (Sources/Loro/Value.swift), so these pass
    // directly to `insert`/`mark`.
    switch value {
    case .string(let string): return .string(value: string)
    case .bool(let bool): return .bool(value: bool)
    case .int(let int): return .i64(value: int)
    case .double(let double): return .double(value: double)
    case .null: return .null
    }
  }

  // MARK: - Test-only introspection

  /// A text container's current plain-string content
  /// (Sources/Loro/Loro.swift `LoroText.toString()`, which is
  /// `self.description` on the FFI-generated `LoroText`). `internal`, not
  /// part of `CRDTEngine`'s public surface — the protocol is deliberately
  /// write/export-oriented (real reads go through projections, not the
  /// engine, per the plan's architecture). Exists so
  /// `EnchiridionSyncTests` can assert round-trip fidelity without
  /// reaching into `LoroEngine`'s private storage.
  func debugTextContent(of id: PageID, container: String) async -> String? {
    documents[id]?.getText(id: container).toString()
  }

  private func decodeVersionVector(_ bytes: Data) throws -> VersionVector {
    do {
      // LoroFFI.swift `VersionVector.decode(bytes:) throws -> VersionVector`
      // (static), the inverse of `VersionVectorProtocol.encode()` used in
      // `versionVector(of:)` above.
      return try VersionVector.decode(bytes: bytes)
    } catch {
      throw CRDTEngineError.malformedBytes(String(describing: error))
    }
  }
}
