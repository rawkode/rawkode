import Foundation

/// Mirrors `packages/domain/src/page.ts`'s `Page` — a 1:0-or-1 companion to `Node` (keyed by
/// `nodeId`, not its own `id`) holding the legacy Automerge document reference (never document
/// bytes, see that file's doc comment) for a node's prose body. New native pages use the Loro
/// descriptor contract; this value remains for server/web compatibility and recovery records.
public struct Page: Codable, Hashable, Sendable {
    public let nodeId: EntityId
    public let automergeDocId: String
    public let headsHash: String

    public init(nodeId: EntityId, automergeDocId: String, headsHash: String) {
        self.nodeId = nodeId
        self.automergeDocId = automergeDocId
        self.headsHash = headsHash
    }
}
