import EnchiridionCore
import Foundation

/// A page-local replica used by a rich-text editor.
///
/// The session keeps the user's working Automerge document separate from the
/// last durable document.  Every write is encoded as a delta from the durable
/// heads, so the repository can validate it and merge it with concurrent
/// changes instead of replacing a newer document.
@MainActor
final class EditorPersistenceSession {
  enum Failure: LocalizedError, Equatable {
    case invalidDocument(String)
    case persistence(String)

    var errorDescription: String? {
      switch self {
      case .invalidDocument(let message), .persistence(let message): message
      }
    }
  }

  typealias Persist = @MainActor (EditorCommit) async throws -> PageSnapshot

  private let persist: Persist
  private(set) var pageID: PageID
  private(set) var loadGeneration: Int
  private(set) var durableSnapshot: PageSnapshot
  private var workingDocument: Data
  private var workingHeads: AutomergeHeads
  private(set) var revision: UInt64 = 0
  private(set) var durableRevision: UInt64 = 0
  private var generation = UUID()
  /// There is deliberately one commit loop for the session.  `flush()` is
  /// called by debouncing, navigation, lifecycle and explicit actions; making
  /// each caller start a journal append permitted out-of-order adoption.
  private var activeCommit: (id: UUID, task: Task<PageSnapshot, Error>)?

  init(snapshot: PageSnapshot, loadGeneration: Int = 0, persist: @escaping Persist) {
    self.persist = persist
    pageID = snapshot.id
    self.loadGeneration = loadGeneration
    durableSnapshot = snapshot
    workingDocument = snapshot.document
    workingHeads = snapshot.heads
  }

  var isDirty: Bool { revision != durableRevision }

  func currentRichText() throws -> PageRichTextDocument {
    try PageDocument.richText(in: workingDocument)
  }

  func durableRichText() throws -> PageRichTextDocument {
    try PageDocument.richText(in: durableSnapshot.document)
  }

  func replace(title: String, body: AttributedString) throws {
    do {
      let replacement = try PageDocument.replaceRichText(title: title, body: body, in: workingDocument)
      workingDocument = replacement.document
      workingHeads = replacement.heads
      revision &+= 1
    } catch {
      throw Failure.invalidDocument(error.localizedDescription)
    }
  }

  /// Makes all edits known at the start (and any edits made while saving)
  /// durable.  A failed commit leaves the working replica intact for retry.
  func flush() async throws -> PageSnapshot {
    if let activeCommit {
      return try await activeCommit.task.value
    }

    let commitID = UUID()
    let task = Task { @MainActor [weak self] () throws -> PageSnapshot in
      guard let self else { throw CancellationError() }
      defer { self.clearActiveCommit(id: commitID) }
      return try await self.flushUntilDurable(generation: self.generation)
    }
    activeCommit = (commitID, task)
    return try await task.value
  }

  /// Commits every revision that exists when the final persistence await
  /// returns.  The method is only ever run by `activeCommit`.
  private func flushUntilDurable(generation sessionGeneration: UUID) async throws -> PageSnapshot {
    while durableRevision < revision {
      guard sessionGeneration == generation else {
        throw Failure.persistence("The editor session changed before its save completed.")
      }
      let targetRevision = revision
      let targetDocument = workingDocument
      let targetHeads = workingHeads
      let base = durableSnapshot
      let changes: Data
      do {
        changes = try PageDocument.encodedChanges(from: targetDocument, since: base.heads)
      } catch {
        throw Failure.invalidDocument(error.localizedDescription)
      }
      guard !changes.isEmpty else {
        durableRevision = targetRevision
        continue
      }
      let commit = EditorCommit(
        pageID: pageID,
        loadGeneration: loadGeneration,
        journalID: UUID().uuidString,
        baseHeads: base.heads,
        encodedChanges: changes,
        advertisedHeads: targetHeads
      )
      let returned: PageSnapshot
      do {
        returned = try await persist(commit)
      } catch {
        throw Failure.persistence(error.localizedDescription)
      }
      guard sessionGeneration == generation else {
        throw Failure.persistence("The editor session changed before its save completed.")
      }

      // A store update can arrive while the journal append is in flight.  Do
      // not replace that known durable state with the older returned snapshot:
      // merge the two durable replicas, then make the UI adopt that merged
      // document below.
      let adopted: PageSnapshot
      if durableSnapshot.heads == returned.heads {
        adopted = returned
      } else {
        do {
          let merged = try PageDocument.merge(
            local: durableSnapshot.document,
            remote: returned.document,
            pageID: pageID
          )
          adopted = snapshot(from: merged, replacing: returned)
        } catch {
          throw Failure.persistence("Could not merge a concurrent page update: \(error.localizedDescription)")
        }
      }
      durableSnapshot = adopted
      durableRevision = targetRevision
      do {
        let merged = try PageDocument.merge(
          local: workingDocument,
          remote: adopted.document,
          pageID: pageID
        )
        workingDocument = merged.document
        workingHeads = merged.heads
      } catch {
        throw Failure.persistence("Could not merge edits made while saving: \(error.localizedDescription)")
      }
    }
    return durableSnapshot
  }

  /// Adopts a live/store update. Clean editors reload it; dirty editors merge
  /// it into their local replica so a remote update can never be overwritten.
  func receive(_ snapshot: PageSnapshot) throws -> PageRichTextDocument? {
    guard snapshot.id == pageID, snapshot.heads != durableSnapshot.heads else { return nil }
    if !isDirty {
      durableSnapshot = snapshot
      workingDocument = snapshot.document
      workingHeads = snapshot.heads
      durableRevision = revision
      return try PageDocument.richText(in: snapshot.document)
    }
    do {
      let merged = try PageDocument.merge(local: workingDocument, remote: snapshot.document, pageID: pageID)
      durableSnapshot = snapshot
      workingDocument = merged.document
      workingHeads = merged.heads
      // The editor must render the merged working replica immediately.  A
      // dirty editor that kept displaying its pre-sync body could later apply
      // commands or follow a stale link range.
      return try PageDocument.richText(in: merged.document)
    } catch {
      throw Failure.persistence("Could not merge an incoming page update: \(error.localizedDescription)")
    }
  }

  /// Stops any prior generation from adopting a late save result.
  func invalidate() {
    generation = UUID()
    activeCommit?.task.cancel()
    activeCommit = nil
  }

  private func clearActiveCommit(id: UUID) {
    guard activeCommit?.id == id else { return }
    activeCommit = nil
  }

  private func snapshot(
    from result: (document: Data, heads: AutomergeHeads, projection: PageDocumentProjection),
    replacing previous: PageSnapshot
  ) -> PageSnapshot {
    PageSnapshot(
      id: previous.id,
      kind: previous.kind,
      title: result.projection.title,
      plainText: result.projection.plainText,
      document: result.document,
      heads: result.heads,
      createdAt: previous.createdAt,
      modifiedAt: previous.modifiedAt,
      deletedAt: result.projection.deletedAt,
      isPinned: result.projection.isPinned,
      objectMetadata: result.projection.objectMetadata
    )
  }
}
