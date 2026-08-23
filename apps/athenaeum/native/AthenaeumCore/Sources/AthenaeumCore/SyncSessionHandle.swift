import Foundation

/// A caller-owned, mutable handle to one Automerge page's sync session id — the Swift mirror of
/// `web/src/automerge-page.ts`'s `SyncSessionHandle` (see that file's doc comment for the full
/// adversarial-review history this fixes: minting a fresh session id on every sync call
/// previously caused unbounded `sessions` map growth server-side). One instance is created per
/// resolved node per app lifetime (or per open-editor lifetime) and passed into every
/// `WorkspaceSyncClient.syncPage` call for that node, so the *same* session id is reused across the
/// initial resolve and every subsequent edit-triggered sync — only `WorkspaceSyncClient.syncPage`
/// itself ever overwrites `.id`, and only on a real `reset: true` from the server.
public final class SyncSessionHandle: @unchecked Sendable {
    public var id: String

    public init(id: String = UUID().uuidString) {
        self.id = id
    }
}
