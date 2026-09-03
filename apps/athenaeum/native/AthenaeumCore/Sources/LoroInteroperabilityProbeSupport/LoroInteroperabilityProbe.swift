import Foundation
import AthenaeumCore
import Loro

/// The only public values emitted by the native Loro capability probe. Loro FFI handles remain
/// actor-confined; callers can persist or send only opaque bytes and a human-safe text length.
public struct LoroProbeOutput: Sendable, Equatable {
    public let update: Data
    public let clientVersion: Data
    public let snapshot: Data
    public let insertedTextUTF8Count: Int

    public init(update: Data, clientVersion: Data, snapshot: Data, insertedTextUTF8Count: Int) {
        self.update = update
        self.clientVersion = clientVersion
        self.snapshot = snapshot
        self.insertedTextUTF8Count = insertedTextUTF8Count
    }
}

public enum LoroInteroperabilityProbeError: Error, Equatable, Sendable {
    case emptyText
    case malformedSnapshot
    case malformedServerVersion
    case unsupportedPageSchema
    case invalidPageStructure
    case updateWasEmpty
    case exportFailed
    case invalidReplaceRange
    case replacementNoOp
    case replacementNewlineUnsupported
}

/// A deliberately narrow FFI boundary for validating native Loro mechanics. It is not a page
/// store, does not know RPC, and never exposes a `LoroDoc`/container/version-vector handle.
///
/// The supplied snapshot may come from the server. `serverVersion` is an opaque Loro version
/// vector returned by the server sync handshake: the probe decodes and accepts it only to prove
/// that it is valid input for Loro's update export API. It does not assert wire compatibility;
/// the separate Node integration harness owns that end-to-end claim.
public actor LoroInteroperabilityProbe {
    public init() {}

    public func makeTextUpdate(
        snapshot: Data,
        serverVersion: Data?,
        text: String
    ) throws -> LoroProbeOutput {
        guard !text.isEmpty else { throw LoroInteroperabilityProbeError.emptyText }

        let doc = LoroDoc()
        do {
            _ = try doc.import(bytes: snapshot)
        } catch {
            throw LoroInteroperabilityProbeError.malformedSnapshot
        }

        if let serverVersion {
            do {
                let accepted = try VersionVector.decode(bytes: serverVersion)
                _ = try doc.export(mode: .updates(from: accepted))
            } catch {
                throw LoroInteroperabilityProbeError.malformedServerVersion
            }
        }

        let before = doc.oplogVv()
        let probeText = try legacyCanonicalPageText(in: doc)
        do {
            try probeText.insert(pos: UInt32(probeText.toString().unicodeScalars.count), s: text)
        } catch {
            throw LoroInteroperabilityProbeError.exportFailed
        }
        doc.commit()

        do {
            let update = try doc.export(mode: .updates(from: before))
            guard !update.isEmpty else { throw LoroInteroperabilityProbeError.updateWasEmpty }
            return LoroProbeOutput(
                update: update,
                clientVersion: doc.oplogVv().encode(),
                snapshot: try doc.export(mode: .snapshot),
                insertedTextUTF8Count: text.lengthOfBytes(using: .utf8)
            )
        } catch let error as LoroInteroperabilityProbeError {
            throw error
        } catch {
            throw LoroInteroperabilityProbeError.exportFailed
        }
    }

    /// Test-only counterpart of the append probe. Ranges use Unicode scalar offsets, matching
    /// Loro's indexed text API; this is intentionally the sole conversion point for the CLI.
    public func replaceTextUpdate(snapshot: Data, serverVersion: Data?, incomingUpdate: Data? = nil, text: String, rangeStart: Int, rangeLength: Int) throws -> LoroProbeOutput {
        guard !text.contains(where: { $0 == "\n" || $0 == "\r" }) else { throw LoroInteroperabilityProbeError.replacementNewlineUnsupported }
        let doc = LoroDoc()
        do { _ = try doc.import(bytes: snapshot) } catch { throw LoroInteroperabilityProbeError.malformedSnapshot }
        if let incomingUpdate, !incomingUpdate.isEmpty { do { _ = try doc.import(bytes: incomingUpdate) } catch { throw LoroInteroperabilityProbeError.malformedSnapshot } }
        if let serverVersion {
            do { _ = try doc.export(mode: .updates(from: VersionVector.decode(bytes: serverVersion))) }
            catch { throw LoroInteroperabilityProbeError.malformedServerVersion }
        }
        let before = doc.oplogVv()
        let target = try strictNativePlainText(in: doc)
        let current = target.toString()
        let count = current.unicodeScalars.count
        guard rangeStart >= 0, rangeLength >= 0, rangeStart <= count, rangeLength <= count - rangeStart,
              let position = UInt32(exactly: rangeStart), let length = UInt32(exactly: rangeLength) else {
            throw LoroInteroperabilityProbeError.invalidReplaceRange
        }
        let existing = String(current.unicodeScalars.dropFirst(rangeStart).prefix(rangeLength))
        guard existing != text else { throw LoroInteroperabilityProbeError.replacementNoOp }
        do {
            if length > 0 { try target.delete(pos: position, len: length) }
            if !text.isEmpty { try target.insert(pos: position, s: text) }
            doc.commit()
            let update = try doc.export(mode: .updates(from: before))
            guard !update.isEmpty else { throw LoroInteroperabilityProbeError.updateWasEmpty }
            return LoroProbeOutput(update: update, clientVersion: doc.oplogVv().encode(), snapshot: try doc.export(mode: .snapshot), insertedTextUTF8Count: text.lengthOfBytes(using: .utf8))
        } catch let error as LoroInteroperabilityProbeError { throw error }
        catch { throw LoroInteroperabilityProbeError.exportFailed }
    }

    /// The backend's Loro page validator owns this schema. The probe deliberately traverses its
    /// existing named containers rather than creating a parallel text root: metadata -> PM root
    /// -> children -> first paragraph -> children -> first LoroText.
    /// Test-only strict v1 traversal. It intentionally mirrors the Core editor subset rather
    /// than the legacy append probe's permissive traversal, including attach-once empty pages.
    private func strictNativePlainText(in doc: LoroDoc) throws -> LoroText {
        guard case let .map(value: roots) = doc.getDeepValue(),
              Set(roots.keys) == ["athenaeum-page-meta-v1", "athenaeum-prosemirror-v1"] else { throw LoroInteroperabilityProbeError.invalidPageStructure }
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        guard case let .map(value: meta) = metadata.getDeepValue(), meta == ["schemaVersion": .i64(value: 1)] else {
            throw LoroInteroperabilityProbeError.unsupportedPageSchema
        }

        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard case let .map(value: rootValue) = root.getDeepValue(),
              Set(rootValue.keys) == ["nodeName", "attributes", "children"],
              case .string("doc")? = rootValue["nodeName"],
              case let .map(value: rootAttrs)? = rootValue["attributes"], rootAttrs == ["isAmgBlock": .bool(value: false)],
              case let .list(value: rootItems)? = rootValue["children"], rootItems.count == 1,
              let children = root.get(key: "children")?.asLoroList(),
              let paragraph = children.get(index: 0)?.asLoroMap(),
              case let .map(value: paragraphValue) = paragraph.getDeepValue(),
              Set(paragraphValue.keys) == ["nodeName", "attributes", "children"],
              case .string("paragraph")? = paragraphValue["nodeName"],
              case let .map(value: paragraphAttrs)? = paragraphValue["attributes"], paragraphAttrs == ["isAmgBlock": .bool(value: false)],
              case let .list(value: inlineItems)? = paragraphValue["children"], inlineItems.count <= 1,
              let paragraphChildren = paragraph.get(key: "children")?.asLoroList() else {
            throw LoroInteroperabilityProbeError.invalidPageStructure
        }
        if let text = paragraphChildren.get(index: 0)?.asLoroText(), text.isAttached(), !text.isDeleted(),
           Int(text.lenUnicode()) <= LoroPageProjectionLimits().maxUTF8Bytes,
           text.lenUtf8() <= UInt32(LoroPageProjectionLimits().maxUTF8Bytes),
           case let .list(value: delta) = text.getRichtextValue(),
           delta.allSatisfy({ entry in
               guard case let .map(value: run) = entry,
                     case .string? = run["insert"],
                     run.keys.allSatisfy({ $0 == "insert" }) else { return false }
               return true
           }) { return text }
        guard paragraphChildren.len() == 0 else { throw LoroInteroperabilityProbeError.invalidPageStructure }
        do { return try paragraphChildren.insertTextContainer(pos: 0, child: LoroText()) }
        catch { throw LoroInteroperabilityProbeError.invalidPageStructure }
    }

    private func legacyCanonicalPageText(in doc: LoroDoc) throws -> LoroText {
        let metadata = doc.getMap(id: "athenaeum-page-meta-v1")
        guard case .i64(1)? = metadata.get(key: "schemaVersion")?.asValue() else { throw LoroInteroperabilityProbeError.unsupportedPageSchema }
        let root = doc.getMap(id: "athenaeum-prosemirror-v1")
        guard let children = root.get(key: "children")?.asLoroList(), let paragraph = children.get(index: 0)?.asLoroMap(), let inline = paragraph.get(key: "children")?.asLoroList(), let text = inline.get(index: 0)?.asLoroText() else { throw LoroInteroperabilityProbeError.invalidPageStructure }
        return text
    }
}
