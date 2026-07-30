import Foundation
import XCTest

@testable import EnchiridionCore

@MainActor
final class AssistantVoicePreferencePersistenceTests: XCTestCase {
  func testAbsentPayloadDefaultsToAutomatic() {
    withStore { store, _ in
      XCTAssertEqual(store.load(), .automatic)
    }
  }

  func testCorruptPayloadDefaultsToAutomatic() {
    withStore { store, defaults in
      defaults.set(Data("not-json".utf8), forKey: AssistantVoicePreferenceDefaultsStore.defaultKey)
      XCTAssertEqual(store.load(), .automatic)
    }
  }

  func testUnsupportedPayloadVersionDefaultsToAutomatic() throws {
    try withStore { store, defaults in
      let payload = AssistantVoicePreferencePayload(
        version: AssistantVoicePreferencePayload.currentVersion + 1,
        preference: .specific(identifier: "future-voice")
      )
      defaults.set(
        try JSONEncoder().encode(payload),
        forKey: AssistantVoicePreferenceDefaultsStore.defaultKey
      )
      XCTAssertEqual(store.load(), .automatic)
    }
  }

  func testAutomaticAndSpecificPreferencesRoundTrip() {
    withStore { store, _ in
      store.save(.automatic)
      XCTAssertEqual(store.load(), .automatic)

      store.save(.specific(identifier: "installed-voice"))
      XCTAssertEqual(store.load(), .specific(identifier: "installed-voice"))
    }
  }

  private func withStore(
    _ body: (
      AssistantVoicePreferenceDefaultsStore,
      UserDefaults
    ) throws -> Void
  ) rethrows {
    let suiteName = "AssistantVoicePreferencePersistenceTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suiteName)!
    defer { defaults.removePersistentDomain(forName: suiteName) }
    try body(AssistantVoicePreferenceDefaultsStore(defaults: defaults), defaults)
  }
}
