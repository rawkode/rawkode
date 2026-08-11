// AssistantTaskSnapshotProviding.swift
// EnchiridionCore
//
// Task #68. The one additional boundary `proposeTaskUpdate`/
// `proposeTaskComplete` need beyond what #65/#66/#67 already built: to
// record an `.update`/`.complete` `AssistantTaskMutationProposal`
// (`AssistantWriteTools.swift`), the dispatcher needs the target task
// page's CURRENT `AssistantPageVersionToken` — the same "version-tokened
// proposals" discipline `AssistantTaskMutationApplier.swift`'s header
// describes for the apply side, applied here at propose time instead.
//
// Deliberately a narrow protocol, not a direct `EnchiridionSync.CRDTEngine`
// dependency: `EnchiridionCore` cannot import `EnchiridionSync` (see
// `AssistantWriteTools.swift`'s header for the identical layering
// argument applied to `AssistantPageVersionToken` itself). A real,
// production-backed conformance (e.g. wrapping `CRDTEngine.exportSnapshot(of:)`
// and `EnchiridionSync.PageDocument.currentVersion(of:)`) belongs in
// `EnchiridionUI`, alongside `AssistantLocalToolDispatcher` — see that
// file's header for the honest caveat about how much of that production
// wiring this task actually built versus left for a follow-on.

import Foundation

public protocol AssistantTaskSnapshotProviding: Sendable {
  /// The task page's current full document snapshot bytes (the same `Data`
  /// shape `EnchiridionSync.PageDocument`'s functions and
  /// `AssistantTaskMutationApplier.apply`'s `existingSnapshot` parameter
  /// consume), or `nil` if `pageID` has no known local snapshot yet.
  func snapshot(for pageID: PageID) async throws -> Data?
}
