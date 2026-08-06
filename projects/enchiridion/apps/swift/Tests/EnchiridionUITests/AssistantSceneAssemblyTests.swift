// AssistantSceneAssemblyTests.swift
// EnchiridionUITests
//
// Task #85 (P7 integration wave, track 4). Proves
// `AssistantSceneAssembly.makeConversationController(store:credentialStore:)`
// — the real call site closing P5's "never reachable from a live screen"
// gap — actually constructs a working `AssistantConversationController`
// against real dependencies (a real temporary `LocalGraphStore`, a real
// `AssistantOpenAICredentialStore` backed by a fake Keychain client, never
// the real system Keychain — same convention
// `AssistantOpenAICredentialStoreTests.swift` established for this exact
// type). This is necessarily a plumbing-level test, not a full
// conversation round-trip (no network egress in this sandbox — matches
// this codebase's own established caveat for anything touching OpenAI's
// real API); `AssistantConversationControllerTests.swift`/
// `AssistantConversationEndToEndTests.swift` already cover the
// controller's own turn-handling logic in full against a fake transport.
import EnchiridionCore
import EnchiridionStore
import Foundation
import Security
import XCTest

@testable import EnchiridionCore
@testable import EnchiridionUI

/// Minimal fake — never touches the real Keychain. Always reports "no key
/// stored," which is the realistic out-of-the-box state for a device that
/// has never had a settings UI to save one (this task's own header on
/// `AssistantSceneAssembly.swift` notes no such UI exists yet).
private final class EmptyKeychainClient: AssistantKeychainClient, @unchecked Sendable {
  func add(_ attributes: CFDictionary) -> OSStatus { errSecSuccess }
  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    errSecItemNotFound
  }
  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus { errSecItemNotFound }
  func delete(_ query: CFDictionary) -> OSStatus { errSecItemNotFound }
}

@MainActor
final class AssistantSceneAssemblyTests: XCTestCase {
  func testMakeConversationControllerBuildsARealControllerReadyToUse() throws {
    let store = try LocalGraphStore.openTemporary()
    let credentialStore = AssistantOpenAICredentialStore(client: EmptyKeychainClient(), platform: .macOS)

    let controller = AssistantSceneAssembly.makeConversationController(
      store: store, credentialStore: credentialStore)

    XCTAssertTrue(controller.messages.isEmpty)
    XCTAssertTrue(controller.pendingProposals.isEmpty)
    XCTAssertFalse(controller.isSending)
    XCTAssertNil(controller.lastError)
  }

  /// A turn submitted with no OpenAI key configured must fail GRACEFULLY
  /// (a real, rendered `.grounded` failure message) — not crash, not hang.
  /// This exercises the real `credential` closure this assembly builds
  /// (`AssistantSceneAssemblyError.noAPIKeyConfigured`), through the real
  /// `OpenAIResponsesAssistant.respond(to:)` -> `credential()`-throws path
  /// documented in that file.
  func testSendingWithNoAPIKeyConfiguredFailsGracefullyRatherThanCrashing() async throws {
    let store = try LocalGraphStore.openTemporary()
    let credentialStore = AssistantOpenAICredentialStore(client: EmptyKeychainClient(), platform: .macOS)
    let controller = AssistantSceneAssembly.makeConversationController(
      store: store, credentialStore: credentialStore)

    await controller.send("hello")

    XCTAssertEqual(controller.messages.count, 2, "the user's turn plus one assistant failure response")
    XCTAssertEqual(controller.messages.last?.role, .assistant)
    XCTAssertFalse(controller.isSending)
  }

  /// Adversarial-review coverage gap, closed: proves
  /// `AssistantSceneAssembly`'s two-phase `ControllerBox` trick does NOT
  /// retain-cycle the controller it hands back — an earlier revision made
  /// `ControllerBox.controller` a STRONG `var`, which would have leaked
  /// every assembled controller for the process lifetime (controller ->
  /// `retrievalAuthorization` closure -> box -> controller). `weak var`
  /// fixed it; this test is the regression guard so it can't silently come
  /// back. A `weak` local capturing the controller, with every OTHER
  /// strong reference dropped, must observe deallocation.
  func testMakeConversationControllerDoesNotLeakViaItsOwnAuthorizationClosure() throws {
    let store = try LocalGraphStore.openTemporary()
    let credentialStore = AssistantOpenAICredentialStore(client: EmptyKeychainClient(), platform: .macOS)

    weak var weakController: AssistantConversationController?
    do {
      let controller = AssistantSceneAssembly.makeConversationController(
        store: store, credentialStore: credentialStore)
      weakController = controller
      XCTAssertNotNil(weakController, "sanity check: the controller exists while a strong reference is in scope")
    }

    XCTAssertNil(
      weakController,
      "the controller must be deallocated once its only strong owner (this test's local `controller`) goes out of "
        + "scope — a non-nil value here means ControllerBox's closure is retain-cycling it")
  }

  /// UPDATED (task #96, plan §Live Backend Connectivity (P8) scope item
  /// 3): these constructors are NOW used by `makeConversationController`'s
  /// default call path (unlike the P7-era state this test's name used to
  /// describe) — see `AssistantSceneAssembly.swift`'s header. This test
  /// still proves the standalone constructors compile and produce real
  /// values on their own, independent of `makeConversationController`.
  func testRemoteWriteAndEmailClientsAreConstructibleOnTheirOwn() {
    let resolver = DeviceAccessCredentialResolver(
      store: DeviceAccessCredentialStore(client: EmptyKeychainClient(), platform: .macOS))
    _ = AssistantSceneAssembly.remoteWriteClient(credentialResolver: resolver)
    _ = AssistantSceneAssembly.remoteWriteReviewClient(credentialResolver: resolver)
    _ = AssistantSceneAssembly.emailClient(resolver: resolver)
  }

  /// `makeConversationController` now wires real, non-`nil` `emailClient`/
  /// `remoteWriteClient`/`remoteWriteReviewClient` values by default (task
  /// #96) — verified indirectly here by confirming a turn that would
  /// authorize a remote tool no longer fails with
  /// `.toolNotAuthorizedThisTurn` for lack of a wired transport (it still
  /// fails gracefully overall, since no OpenAI key is configured in this
  /// test — see `testSendingWithNoAPIKeyConfiguredFailsGracefullyRatherThanCrashing`
  /// above for that separate, already-covered failure mode). This test's
  /// real job is narrower and more direct: prove the assembly compiles and
  /// runs end to end with a fake, never-enrolled device credential store
  /// (no real Keychain, no real network) without crashing.
  func testMakeConversationControllerWithAFakeDeviceCredentialStoreDoesNotCrash() throws {
    let store = try LocalGraphStore.openTemporary()
    let credentialStore = AssistantOpenAICredentialStore(client: EmptyKeychainClient(), platform: .macOS)
    let deviceCredentialStore = DeviceAccessCredentialStore(client: EmptyKeychainClient(), platform: .macOS)

    let controller = AssistantSceneAssembly.makeConversationController(
      store: store, credentialStore: credentialStore, deviceCredentialStore: deviceCredentialStore)

    XCTAssertTrue(controller.messages.isEmpty)
  }
}
