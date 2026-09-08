import Foundation

// Mirrors `packages/domain/src/page-rpc.ts` — `NotesService`'s page-body RPC methods:
// create a page (empty Automerge text doc), read current text, apply a local plain
// text-replace op.

public struct CreatePageInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
    }
}

public struct CreatePageOutput: Codable, Hashable, Sendable {
    public let page: Page
    public let text: String
    public init(page: Page, text: String) {
        self.page = page
        self.text = text
    }
}

public struct GetPageTextInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public init(workspaceId: EntityId, nodeId: EntityId) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
    }
}

public struct GetPageTextOutput: Codable, Hashable, Sendable {
    public let page: Page
    public let text: String
    public init(page: Page, text: String) {
        self.page = page
        self.text = text
    }
}

/// Mirrors `page-rpc.ts`'s `ApplyPageEditInput` — a plain text-replace op: delete `deleteCount`
/// UTF-16 code units starting at `index`, then insert `insertText`. The same `(index, del,
/// newText)` shape `@automerge/automerge`'s own `splice` primitive takes.
public struct ApplyPageEditInput: Codable, Hashable, Sendable {
    public let workspaceId: EntityId
    public let nodeId: EntityId
    public let index: Int
    public let deleteCount: Int
    public let insertText: String

    public init(workspaceId: EntityId, nodeId: EntityId, index: Int, deleteCount: Int, insertText: String) {
        self.workspaceId = workspaceId
        self.nodeId = nodeId
        self.index = index
        self.deleteCount = deleteCount
        self.insertText = insertText
    }
}

public struct ApplyPageEditOutput: Codable, Hashable, Sendable {
    public let page: Page
    public let text: String
    public init(page: Page, text: String) {
        self.page = page
        self.text = text
    }
}
