import Automerge
import XCTest

@testable import EnchiridionCore

final class BookmarkPageDocumentTests: XCTestCase {
  func testConcurrentDistinctCapturesMergeInBothOrders() throws {
    let base = try page()
    let first = try event(id: "00000000-0000-0000-0000-000000000001")
    let second = try event(id: "00000000-0000-0000-0000-000000000002")
    let left = try PageDocument.appendBookmarkCaptureEvent(first, in: base.document)
    let right = try PageDocument.appendBookmarkCaptureEvent(second, in: base.document)

    let forward = try PageDocument.merge(local: left.document, remote: right.document, pageID: pageID)
    let reverse = try PageDocument.merge(local: right.document, remote: left.document, pageID: pageID)

    XCTAssertEqual(try PageDocument.bookmarkCaptureEvents(in: forward.document).events.map(\.event), [first, second])
    XCTAssertEqual(try PageDocument.bookmarkCaptureEvents(in: reverse.document).events.map(\.event), [first, second])
  }

  func testIdenticalReplayIsByteForByteNoOpAndDivergentSameIDIsReported() throws {
    let base = try page()
    let first = try event(id: "00000000-0000-0000-0000-000000000001")
    let replayed = try PageDocument.appendBookmarkCaptureEvent(first, in: base.document)
    let replay = try PageDocument.appendBookmarkCaptureEvent(first, in: replayed.document)
    XCTAssertEqual(replay.document, replayed.document)

    let conflict = try event(id: "00000000-0000-0000-0000-000000000001", submittedURL: "https://example.com/other")
    let other = try PageDocument.appendBookmarkCaptureEvent(conflict, in: base.document)
    let merged = try PageDocument.merge(local: replayed.document, remote: other.document, pageID: pageID)
    let inspection = try PageDocument.bookmarkCaptureEvents(in: merged.document)
    XCTAssertEqual(inspection.events.map(\.event), [first, conflict].sorted { $0.submittedURL < $1.submittedURL })
    XCTAssertEqual(inspection.issues.map(\.kind), [.conflictingValues])
  }

  func testEventSurvivesUnrelatedPageEditsWithoutEnteringPresentationFields() throws {
    let base = try page()
    let capture = try event(id: "00000000-0000-0000-0000-000000000001")
    let appended = try PageDocument.appendBookmarkCaptureEvent(capture, in: base.document)
    let title = try PageDocument.replaceTitle(with: "Renamed", in: appended.document)
    let body = try PageDocument.replaceBody(with: "Body", in: title.document)
    let deleted = try PageDocument.setDeleted(Date(timeIntervalSince1970: 1_754_352_001), in: body.document)

    let rich = try PageDocument.richText(in: deleted.document)
    let projection = try PageDocument.inspect(deleted.document, pageID: pageID)
    XCTAssertEqual(rich.title, "Renamed")
    XCTAssertEqual(String(rich.body.characters), "Body")
    XCTAssertFalse(projection.objectMetadata.properties.values.flatMap { $0 }.contains { "\($0)".contains(capture.captureID.uuidString) })
    XCTAssertEqual(try PageDocument.bookmarkCaptureEvents(in: deleted.document).events.map(\.event), [capture])
  }

  func testInvalidEventValuesAreRejectedBeforeMutation() throws {
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: "https://example.com/article"))
    XCTAssertThrowsError(try BookmarkSyncedCaptureEvent(
      captureID: UUID(), urlKey: key, submittedURL: "https://example.com/article",
      capturedAt: .distantPast, dayKey: .init(rawValue: "2026-02-30"), timeZoneIdentifier: "No/SuchZone"
    ))
  }

  func testFractionalTimestampRoundTripsAndReplaysCanonically() throws {
    let original = try event(
      id: "00000000-0000-0000-0000-000000000003",
      capturedAt: Date(timeIntervalSince1970: 1_754_352_000.123_7)
    )
    let decoded = try JSONDecoder.enchiridion.decode(
      BookmarkSyncedCaptureEvent.self, from: original.canonicalData()
    )
    XCTAssertEqual(decoded, original)
    XCTAssertEqual(decoded.capturedAt.timeIntervalSince1970, 1_754_352_000.124, accuracy: 0.000_001)

    let appended = try PageDocument.appendBookmarkCaptureEvent(original, in: page().document)
    XCTAssertEqual(
      try PageDocument.appendBookmarkCaptureEvent(decoded, in: appended.document).document,
      appended.document
    )
  }

  func testInvalidPrefixedRootKeysCountTowardAppendLimit() throws {
    let base = try page()
    let document = try Document(base.document)
    for index in 0 ..< PageDocument.maximumBookmarkCaptureEvents {
      try document.put(obj: .ROOT, key: "\(PageDocument.bookmarkCaptureEventRootPrefix)invalid-\(index)", value: .String("invalid"))
    }
    document.commitWith(message: "Forge invalid capture keys", timestamp: Date())
    let forged = document.save()

    let inspection = try PageDocument.bookmarkCaptureEvents(in: forged)
    XCTAssertEqual(inspection.rootKeyCount, PageDocument.maximumBookmarkCaptureEvents)
    XCTAssertThrowsError(try PageDocument.appendBookmarkCaptureEvent(
      try event(id: "00000000-0000-0000-0000-000000000004"), in: forged
    )) { XCTAssertEqual($0 as? PageDocumentError, .bookmarkCaptureEventLimit) }
  }

  func testDeletionEnvelopeFractionalTimestampRoundTripsWithoutPrivacyFields() throws {
    let deletion = try deletion(
      id: "00000000-0000-0000-0000-000000000010",
      at: Date(timeIntervalSince1970: 1_754_352_000.123_7)
    )
    let data = try deletion.canonicalData()
    let decoded = try JSONDecoder.enchiridion.decode(BookmarkIdentityDeletionEnvelope.self, from: data)
    XCTAssertEqual(decoded, deletion)
    XCTAssertEqual(decoded.deletedAt.timeIntervalSince1970, 1_754_352_000.124, accuracy: 0.000_001)
    let json = try XCTUnwrap(String(data: data, encoding: .utf8))
    for forbidden in ["canonicalURL", "submittedURL", "pageID", "note", "source", "platform", "vault"] {
      XCTAssertFalse(json.contains(forbidden))
    }
  }

  func testConcurrentDeletionsMergeAndDivergentSameIDIsInspectable() throws {
    let base = try page()
    let first = try deletion(id: "00000000-0000-0000-0000-000000000011")
    let second = try deletion(id: "00000000-0000-0000-0000-000000000012")
    let left = try PageDocument.appendBookmarkIdentityDeletion(first, in: base.document)
    let right = try PageDocument.appendBookmarkIdentityDeletion(second, in: base.document)
    let merged = try PageDocument.merge(local: left.document, remote: right.document, pageID: pageID)
    XCTAssertEqual(try PageDocument.bookmarkIdentityDeletions(in: merged.document).deletions.map(\.envelope), [first, second])

    let conflict = try deletion(id: "00000000-0000-0000-0000-000000000011", digest: String(repeating: "b", count: 64))
    let conflicting = try PageDocument.appendBookmarkIdentityDeletion(conflict, in: base.document)
    let conflictMerge = try PageDocument.merge(local: left.document, remote: conflicting.document, pageID: pageID)
    let reverseConflictMerge = try PageDocument.merge(local: conflicting.document, remote: left.document, pageID: pageID)
    let inspection = try PageDocument.bookmarkIdentityDeletions(in: conflictMerge.document)
    XCTAssertEqual(inspection.issues.map(\.kind), [.conflictingValues])
    XCTAssertEqual(Set(inspection.issues.map(\.id)).count, inspection.issues.count)
    XCTAssertEqual(
      try PageDocument.bookmarkIdentityDeletions(in: reverseConflictMerge.document).issues,
      inspection.issues
    )
  }

  func testFreshDeletionCarrierIsDistinctAndContainsNoCandidateContent() throws {
    let candidate = pageID
    let carrierID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000088")!)
    let deletion = try deletion(id: "00000000-0000-0000-0000-000000000013")
    let carrier = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: carrierID, replacingCandidateID: candidate, deletion: deletion
    )
    let rich = try PageDocument.richText(in: carrier.document)
    let inspection = try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: carrier.document)
    XCTAssertNotEqual(carrierID, candidate)
    XCTAssertEqual(rich.title, PageDocument.bookmarkIdentityDeletionCarrierTitle)
    XCTAssertTrue(rich.body.characters.isEmpty)
    XCTAssertTrue(inspection.isCanonicalCarrier)
    XCTAssertEqual(inspection.canonicalDeletion, deletion)
    XCTAssertTrue(try PageDocument.bookmarkCaptureEvents(in: carrier.document).events.isEmpty)
    let document = try Document(carrier.document)
    let roots = Set(try document.mapEntries(obj: .ROOT).map(\.0))
    XCTAssertEqual(roots, Set([
      "format", "schemaVersion", "pageID", "kind", "createdAt", "deletedAt", "isPinned",
      "objectMetadata", "edges", "title", "body",
      PageDocument.bookmarkIdentityDeletionRootPrefix + deletion.deletionID.uuidString.lowercased(),
    ]))
  }

  func testCarrierRejectsEditedTaggedPropertyAndCaptureBearingDocumentsWhileKeepingDeletionProvenance() throws {
    let deletion = try deletion(id: "00000000-0000-0000-0000-000000000014")
    let carrier = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: .free(), replacingCandidateID: pageID, deletion: deletion
    )
    let edited = try PageDocument.replaceBody(with: "Old client edit", in: carrier.document)
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: edited.document).isCanonicalCarrier)
    XCTAssertEqual(try PageDocument.bookmarkIdentityDeletions(in: edited.document).deletions.map(\.envelope), [deletion])
    let tagged = try PageDocument.addSupertag(BuiltInSupertags.bookmark, in: carrier.document)
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: tagged.document).isCanonicalCarrier)
    let propertyBearing = try PageDocument.setProperty(
      key: .init(supertagID: BuiltInSupertags.bookmark, fieldID: BuiltInSupertags.bookmarkSourceURLField),
      values: [.url("https://example.com")],
      in: carrier.document
    )
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: propertyBearing.document).isCanonicalCarrier)
    let captured = try PageDocument.appendBookmarkCaptureEvent(
      try event(id: "00000000-0000-0000-0000-000000000015"), in: carrier.document
    )
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: captured.document).isCanonicalCarrier)
  }

  func testCarrierRejectsMalformedRestoredAndDifferentDigestMarkers() throws {
    let initialDeletion = try deletion(id: "00000000-0000-0000-0000-000000000016")
    let carrier = try PageDocument.makeBookmarkIdentityDeletionCarrier(
      id: .free(), replacingCandidateID: pageID, deletion: initialDeletion
    )
    let restored = try PageDocument.setDeleted(nil, in: carrier.document)
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: restored.document).isCanonicalCarrier)

    let malformedDocument = try Document(carrier.document)
    try malformedDocument.put(
      obj: .ROOT,
      key: PageDocument.bookmarkIdentityDeletionRootPrefix + "not-a-uuid",
      value: .String("invalid")
    )
    malformedDocument.commitWith(message: "Old client marker", timestamp: Date())
    let malformed = malformedDocument.save()
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: malformed).isCanonicalCarrier)

    let sameDigest = try deletion(id: "00000000-0000-0000-0000-000000000017")
    let sameDigestCarrier = try PageDocument.appendBookmarkIdentityDeletion(sameDigest, in: carrier.document)
    XCTAssertTrue(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: sameDigestCarrier.document).isCanonicalCarrier)

    let otherDigest = try deletion(
      id: "00000000-0000-0000-0000-000000000018", digest: String(repeating: "b", count: 64)
    )
    let multipleDigests = try PageDocument.appendBookmarkIdentityDeletion(otherDigest, in: carrier.document)
    XCTAssertFalse(try PageDocument.bookmarkIdentityDeletionCarrierInspection(in: multipleDigests.document).isCanonicalCarrier)
  }

  func testInvalidDeletionRootKeysCountTowardAppendLimit() throws {
    let base = try page()
    let document = try Document(base.document)
    for index in 0 ..< PageDocument.maximumBookmarkIdentityDeletions {
      try document.put(
        obj: .ROOT,
        key: "\(PageDocument.bookmarkIdentityDeletionRootPrefix)invalid-\(index)",
        value: .String("invalid")
      )
    }
    document.commitWith(message: "Forge invalid deletion keys", timestamp: Date())
    let forged = document.save()

    let inspection = try PageDocument.bookmarkIdentityDeletions(in: forged)
    XCTAssertEqual(inspection.rootKeyCount, PageDocument.maximumBookmarkIdentityDeletions)
    XCTAssertThrowsError(try PageDocument.appendBookmarkIdentityDeletion(
      try deletion(id: "00000000-0000-0000-0000-000000000019"), in: forged
    )) { XCTAssertEqual($0 as? PageDocumentError, .bookmarkIdentityDeletionLimit) }
  }

  private let pageID = PageID.free(UUID(uuidString: "00000000-0000-0000-0000-000000000099")!)

  private func page() throws -> (document: Data, heads: AutomergeHeads) {
    try PageDocument.create(id: pageID, kind: .free, title: "Bookmark", createdAt: Date(timeIntervalSince1970: 1_754_352_000))
  }

  private func event(
    id: String,
    submittedURL: String = "https://example.com/article",
    capturedAt: Date = Date(timeIntervalSince1970: 1_754_352_000)
  ) throws -> BookmarkSyncedCaptureEvent {
    let key = try XCTUnwrap(BookmarkURLKey(submittedURL: submittedURL))
    return try BookmarkSyncedCaptureEvent(
      captureID: try XCTUnwrap(UUID(uuidString: id)), urlKey: key, submittedURL: submittedURL,
      capturedAt: capturedAt, dayKey: .init(rawValue: "2026-08-05"),
      timeZoneIdentifier: "Europe/London"
    )
  }

  private func deletion(
    id: String,
    digest: String = String(repeating: "a", count: 64),
    at: Date = Date(timeIntervalSince1970: 1_754_352_000)
  ) throws -> BookmarkIdentityDeletionEnvelope {
    try BookmarkIdentityDeletionEnvelope(deletionID: try XCTUnwrap(UUID(uuidString: id)), urlKeyDigest: digest, deletedAt: at)
  }
}
