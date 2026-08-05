import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class MeetingTranscriptionSettingsTests: XCTestCase {
  func testDefaultsPersistPromptAndRoute() {
    let defaults = UserDefaults(suiteName: "MeetingTranscriptionSettingsTests.persist")!
    let key = UUID().uuidString
    let store = MeetingTranscriptionSettingsDefaultsStore(defaults: defaults, key: key)
    let settings = MeetingTranscriptionSettings(store: store)
    XCTAssertTrue(settings.promptsEnabled)
    XCTAssertEqual(settings.route, .onDevice)

    settings.promptsEnabled = false
    settings.route = .cloud

    let reloaded = MeetingTranscriptionSettings(store: store)
    XCTAssertFalse(reloaded.promptsEnabled)
    XCTAssertEqual(reloaded.route, .cloud)
    XCTAssertEqual(reloaded.routeSnapshot().cloudReadiness, .requiresProviderConfiguration)
    defaults.removeObject(forKey: key)
  }

  func testAuthorityFreezesRoutesAndCompletionBindsTranscriptOnlyAfterStart() {
    let defaults = UserDefaults(suiteName: "MeetingTranscriptionSettingsTests.snapshot")!
    let store = MeetingTranscriptionSettingsDefaultsStore(defaults: defaults, key: UUID().uuidString)
    let settings = MeetingTranscriptionSettings(store: store)
    let authority = MeetingAutomationAuthority(
      vaultID: .personal, eventPageID: .init(rawValue: "event_1"), occurrenceKey: "opaque", sessionID: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!,
      transcriptionRoute: .init(route: .onDevice, cloudReadiness: .notRequired), analysisRoute: .init(route: .onDevice),
      issuedAt: Date(timeIntervalSince1970: 100), expiresAt: Date(timeIntervalSince1970: 200)
    )
    XCTAssertNil(authority.completion(transcriptHash: "hash", completedAt: Date(timeIntervalSince1970: 201)))
    XCTAssertEqual(authority.completion(transcriptHash: "hash", completedAt: Date(timeIntervalSince1970: 150))?.transcriptHash, "hash")
    settings.route = .cloud
    XCTAssertEqual(authority.transcriptionRoute.route, .onDevice)
  }

  func testReconcileDedupesAndCancelsStaleRevisions() async {
    let center = PromptCenterSpy(pending: ["dev.rawkode.enchiridion.meeting.old"])
    let scheduler = MeetingTranscriptionPromptScheduler(center: center)
    let occurrence = fixture(revision: 2)
    await scheduler.reconcile([occurrence, occurrence], promptsEnabled: true, now: Date(timeIntervalSince1970: 0))
    let identifier = scheduler.identifier(for: occurrence)
    let scheduled = await center.scheduled
    let cancelled = await center.cancelled
    XCTAssertEqual(scheduled, [identifier])
    XCTAssertEqual(cancelled, [["dev.rawkode.enchiridion.meeting.old"]])
  }

  func testStaleNotificationActionIsRejectedAfterRevalidation() async {
    let occurrence = fixture(revision: 1)
    let scheduler = MeetingTranscriptionPromptScheduler(center: PromptCenterSpy())
    let id = scheduler.identifier(for: occurrence)
    let resolver = Resolver(occurrence: occurrence)
    let route = MeetingPromptNotificationRoute(notificationID: id, action: .start)
    let value = await MeetingTranscriptionPromptScheduler.revalidatedAction(
      route, resolver: resolver, settings: .init(), now: occurrence.startsAt.addingTimeInterval(16 * 60)
    )
    XCTAssertNil(value)
  }

  private func fixture(revision: Int) -> MeetingPromptOccurrence {
    .init(vaultID: .personal, eventPageID: .init(rawValue: "event_1"), occurrenceKey: "opaque", revision: revision, startsAt: Date(timeIntervalSince1970: 1_000), title: "Planning")
  }
}

private actor PromptCenterSpy: MeetingPromptNotificationCenter {
  var pending: [String]
  var scheduled: [String] = []
  var cancelled: [[String]] = []
  init(pending: [String] = []) { self.pending = pending }
  func pendingIdentifiers() async -> [String] { pending }
  func schedule(identifier: String, occurrence _: MeetingPromptOccurrence) async throws { scheduled.append(identifier) }
  func cancel(identifiers: [String]) async { cancelled.append(identifiers) }
}

private struct Resolver: MeetingPromptOccurrenceResolving {
  let occurrence: MeetingPromptOccurrence?
  func occurrence(forNotificationID _: String) async -> MeetingPromptOccurrence? { occurrence }
}
