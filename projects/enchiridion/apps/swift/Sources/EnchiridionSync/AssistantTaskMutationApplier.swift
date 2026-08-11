// AssistantTaskMutationApplier.swift
// EnchiridionSync
//
// The real apply-to-graph step for a CONFIRMED
// `EnchiridionCore.AssistantTaskMutationProposal` (task #67, plan
// "Assistant (P5)"). Takes a proposal that has already come back from
// `AssistantWriteProposalReviewer.consumeConfirmed(_:)` — this type never
// sees, and has no way to reach, the ledger itself; it only knows how to
// turn an already-confirmed proposal into a real `PageDocument` mutation.
//
// WHY THIS LIVES IN EnchiridionSync, NOT EnchiridionCore (alongside
// AssistantWriteTools.swift): identical reasoning to `PageDocument.swift`'s
// own header — `EnchiridionSync` already depends on `EnchiridionCore`, so
// the reverse would be circular, and this file needs `PageDocument`'s real
// snapshot-in/snapshot-out CRDT mutation functions (`create`/
// `setProperties`/`insertText`/`deleteText`), which only exist here. This
// is "this package's real local write path" the task brief asks the
// apply-to-graph step to call into — the same functions
// `EnchiridionUI`'s page editor itself uses to commit an edit (see
// PageDocument.swift's own callers), not a bespoke write path invented for
// the assistant.
//
// TASK SUPERTAG IDENTITY: `taskSupertagID`/`Field` below hardcode the
// exact string constants `EnchiridionSchema/Generated/CoreSupertags.swift`
// generates (`CoreTaskFieldIDs.supertagID` =
// `"dev.rawkode.enchiridion.core.task"`, and each field's raw id) rather
// than importing `EnchiridionSchema`. `EnchiridionSync` does not depend on
// `EnchiridionSchema` today (see Package.swift) and this file does not
// start that dependency for one supertag's field keys — this mirrors
// `EnchiridionImporter/OldBuiltInRelations.swift`'s existing "duplicate
// the literal, not the dependency" convention for the exact same
// supertag's keys.
//
// VERSION CONFLICT: `.update`/`.complete` require the caller-supplied
// `existingSnapshot` to still match the proposal's `AssistantPageVersionToken`
// (via `PageDocument.versionMatches`) before any mutation is attempted —
// a page edited by something else (another device, another confirmed
// proposal) between when this proposal was RECORDED and when it is
// APPLIED throws `.staleVersion` rather than silently overwriting the
// intervening edit. This mirrors the plan's "version-tokened proposals"
// language for the assistant's write tools generally, and the identical
// stale-version handling `AssistantRemoteWriteTools.swift` documents for
// the Calendar/Gmail RPCs (Part 2) — a caller sees a real conflict, never
// a silent clobber.

import EnchiridionCore
import Foundation

// MARK: - Errors

public enum AssistantTaskMutationApplyError: Error, LocalizedError, Equatable, Sendable {
  /// `.update`/`.complete` require an existing page snapshot; `nil` means
  /// the caller couldn't find one (the page doesn't exist locally, or
  /// hasn't synced yet) — never treated as "create a new page instead."
  case missingExistingSnapshot
  /// The supplied snapshot's version no longer matches the proposal's
  /// `AssistantPageVersionToken` — see this file's header, "VERSION
  /// CONFLICT."
  case staleVersion
  case documentError(String)

  public var errorDescription: String? {
    switch self {
    case .missingExistingSnapshot:
      "The task page could not be found for this update."
    case .staleVersion:
      "This task changed since the proposal was recorded — review the latest version before confirming again."
    case .documentError(let message):
      "The task edit could not be applied: \(message)"
    }
  }
}

// MARK: - Result

/// The outcome of applying one confirmed proposal — enough for a caller to
/// persist the new snapshot (via the same `CRDTEngine`/outbox path any
/// other local edit takes) and update any in-memory projection it's
/// holding.
public struct AssistantTaskMutationApplyResult: Sendable, Equatable {
  public var pageID: PageID
  public var document: Data
  public var version: PageDocumentVersion
  public var projection: PageDocumentProjection

  public init(
    pageID: PageID,
    document: Data,
    version: PageDocumentVersion,
    projection: PageDocumentProjection
  ) {
    self.pageID = pageID
    self.document = document
    self.version = version
    self.projection = projection
  }
}

// MARK: - Applier

public enum AssistantTaskMutationApplier {
  /// Matches `EnchiridionSchema/Generated/CoreSupertags.swift`'s
  /// `CoreTaskFieldIDs.supertagID` — see this file's header.
  static let taskSupertagID = SupertagID(rawValue: "dev.rawkode.enchiridion.core.task")

  private enum Field {
    static let notes = SupertagFieldID(rawValue: "notes")
    static let priority = SupertagFieldID(rawValue: "priority")
    static let placement = SupertagFieldID(rawValue: "placement")
    static let estimatedMinutes = SupertagFieldID(rawValue: "estimated-minutes")
    static let status = SupertagFieldID(rawValue: "status")
    static let completedAt = SupertagFieldID(rawValue: "completed-at")
  }

  /// Applies a confirmed proposal. `existingSnapshot` is required for
  /// `.update`/`.complete` (throws `.missingExistingSnapshot` if `nil`)
  /// and ignored for `.create` (which always makes a fresh page via
  /// `PageID.free()`).
  public static func apply(
    _ proposal: AssistantTaskMutationProposal,
    existingSnapshot: Data?,
    now: Date = Date()
  ) throws -> AssistantTaskMutationApplyResult {
    switch proposal {
    case .create(_, let draft):
      return try applyCreate(draft, now: now)
    case .update(_, let pageID, let version, let patch):
      guard let existingSnapshot else { throw AssistantTaskMutationApplyError.missingExistingSnapshot }
      return try applyUpdate(
        pageID: pageID, expectedVersion: version, patch: patch, snapshot: existingSnapshot)
    case .complete(_, let pageID, let version):
      guard let existingSnapshot else { throw AssistantTaskMutationApplyError.missingExistingSnapshot }
      return try applyComplete(
        pageID: pageID, expectedVersion: version, snapshot: existingSnapshot, now: now)
    }
  }

  // MARK: Create

  private static func applyCreate(
    _ draft: AssistantTaskDraft, now: Date
  ) throws -> AssistantTaskMutationApplyResult {
    let pageID = PageID.free()
    do {
      let created = try PageDocument.create(id: pageID, kind: .free, title: draft.title, createdAt: now)
      let updates = propertyUpdates(
        notes: draft.notes, priority: draft.priority, placement: draft.placement,
        estimatedMinutes: draft.estimatedMinutes)
      let result = try PageDocument.setProperties(updates, ensuring: taskSupertagID, in: created.document)
      return AssistantTaskMutationApplyResult(
        pageID: pageID, document: result.document, version: result.version,
        projection: result.projection)
    } catch let error as PageDocumentError {
      throw AssistantTaskMutationApplyError.documentError(error.localizedDescription)
    }
  }

  // MARK: Update

  private static func applyUpdate(
    pageID: PageID,
    expectedVersion: AssistantPageVersionToken,
    patch: AssistantTaskMutationPatch,
    snapshot: Data
  ) throws -> AssistantTaskMutationApplyResult {
    do {
      try requireCurrentVersion(expectedVersion, in: snapshot)

      var current = snapshot
      if let title = patch.title {
        let existingProjection = try PageDocument.projection(of: current)
        let existingLength = UInt32(existingProjection.title.unicodeScalars.count)
        if existingLength > 0 {
          current = try PageDocument.deleteText(.title, at: 0, length: existingLength, in: current).document
        }
        if !title.isEmpty {
          current = try PageDocument.insertText(.title, at: 0, text: title, in: current).document
        }
      }

      let updates = propertyUpdates(
        notes: patch.notes, priority: patch.priority, placement: patch.placement,
        estimatedMinutes: patch.estimatedMinutes)
      let result = try PageDocument.setProperties(updates, ensuring: taskSupertagID, in: current)
      return AssistantTaskMutationApplyResult(
        pageID: pageID, document: result.document, version: result.version,
        projection: result.projection)
    } catch let error as AssistantTaskMutationApplyError {
      throw error
    } catch let error as PageDocumentError {
      throw AssistantTaskMutationApplyError.documentError(error.localizedDescription)
    }
  }

  // MARK: Complete

  private static func applyComplete(
    pageID: PageID,
    expectedVersion: AssistantPageVersionToken,
    snapshot: Data,
    now: Date
  ) throws -> AssistantTaskMutationApplyResult {
    do {
      try requireCurrentVersion(expectedVersion, in: snapshot)
      let updates: [SupertagPropertyKey: [SupertagValue]] = [
        SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.status): [.select("done")],
        SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.completedAt): [.dateTime(now)],
      ]
      let result = try PageDocument.setProperties(updates, ensuring: taskSupertagID, in: snapshot)
      return AssistantTaskMutationApplyResult(
        pageID: pageID, document: result.document, version: result.version,
        projection: result.projection)
    } catch let error as AssistantTaskMutationApplyError {
      throw error
    } catch let error as PageDocumentError {
      throw AssistantTaskMutationApplyError.documentError(error.localizedDescription)
    }
  }

  // MARK: - Shared helpers

  private static func requireCurrentVersion(
    _ expected: AssistantPageVersionToken, in snapshot: Data
  ) throws {
    let matches = try PageDocument.versionMatches(
      PageDocumentVersion(encoded: expected.encoded), in: snapshot)
    guard matches else { throw AssistantTaskMutationApplyError.staleVersion }
  }

  private static func propertyUpdates(
    notes: String?,
    priority: TaskPriority?,
    placement: AssistantTaskPlacement?,
    estimatedMinutes: Int?
  ) -> [SupertagPropertyKey: [SupertagValue]] {
    var updates: [SupertagPropertyKey: [SupertagValue]] = [:]
    if let notes {
      updates[SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.notes)] =
        notes.isEmpty ? [] : [.text(notes)]
    }
    if let priority {
      updates[SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.priority)] =
        [.select(priority.taskSupertagSelectOption)]
    }
    if let placement {
      updates[SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.placement)] =
        [.select(placement.rawValue)]
    }
    if let estimatedMinutes {
      updates[SupertagPropertyKey(supertagID: taskSupertagID, fieldID: Field.estimatedMinutes)] =
        [.number(Double(estimatedMinutes))]
    }
    return updates
  }
}

extension TaskPriority {
  /// See `CoreTaskFieldIDs.priority`'s select options
  /// (`CoreTaskPriority` in `EnchiridionSchema/Generated/CoreSupertags.swift`)
  /// — raw values already match 1:1 today. An explicit mapping (rather
  /// than reusing `.rawValue` directly) so a future divergence between the
  /// two vocabularies fails to compile here instead of silently writing an
  /// option the generated schema doesn't recognize.
  fileprivate var taskSupertagSelectOption: String {
    switch self {
    case .low: "low"
    case .medium: "medium"
    case .high: "high"
    case .urgent: "urgent"
    }
  }
}
