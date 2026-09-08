import Foundation

/// A caller-owned, mutable compatibility handle for one legacy page session. The shipped native
/// client no longer opens an Automerge sync session, but the token remains at the UI seam so old
/// fakes and migration tooling can keep their route contracts without bringing the FFI into Core.
public final class SyncSessionHandle: @unchecked Sendable {
    public var id: String

    public init(id: String = UUID().uuidString) {
        self.id = id
    }
}
