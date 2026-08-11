// AssistantOpenAICredentialStoreTests.swift
// EnchiridionCoreTests
//
// Task #68. Covers `AssistantOpenAICredentialStore`'s Keychain query shape
// (matches the old app's pinned attributes — device-only, non-synchronizable,
// data-protection Keychain) and its actor logic against a fake
// `AssistantKeychainClient`, never the real Keychain.

import Foundation
import Security
import XCTest

@testable import EnchiridionCore

private final class RecordingKeychainClient: AssistantKeychainClient, @unchecked Sendable {
  private let lock = NSLock()
  private var storedData: Data?
  var addCallCount = 0
  var updateCallCount = 0
  var deleteCallCount = 0
  var lastAddAttributes: [String: Any]?
  var lastUpdateAttributes: [String: Any]?

  func add(_ attributes: CFDictionary) -> OSStatus {
    lock.withLock {
      addCallCount += 1
      let dict = attributes as! [String: Any]
      lastAddAttributes = dict
      storedData = dict[kSecValueData as String] as? Data
    }
    return errSecSuccess
  }

  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    lock.withLock {
      guard let storedData else { return }
      result?.pointee = storedData as CFTypeRef
    }
    return lock.withLock { storedData == nil ? errSecItemNotFound : errSecSuccess }
  }

  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
    lock.withLock {
      updateCallCount += 1
      lastUpdateAttributes = attributes as! [String: Any]
      guard storedData != nil else { return }
      storedData = (attributes as! [String: Any])[kSecValueData as String] as? Data
    }
    return lock.withLock { storedData == nil ? errSecItemNotFound : errSecSuccess }
  }

  func delete(_ query: CFDictionary) -> OSStatus {
    lock.withLock {
      deleteCallCount += 1
      let hadValue = storedData != nil
      storedData = nil
      return hadValue ? errSecSuccess : errSecItemNotFound
    }
  }
}

private final class AlwaysFailingKeychainClient: AssistantKeychainClient, @unchecked Sendable {
  let status: OSStatus
  init(status: OSStatus) { self.status = status }
  func add(_ attributes: CFDictionary) -> OSStatus { status }
  func copyMatching(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus { status }
  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus { status }
  func delete(_ query: CFDictionary) -> OSStatus { status }
}

final class AssistantOpenAICredentialStoreTests: XCTestCase {
  func testProductionQueriesUseDeviceOnlyNonSynchronizableDataProtectionKeychain() {
    let data = Data("placeholder".utf8)
    for platform in [AssistantOpenAICredentialPlatform.iOS, .macOS] {
      let add = AssistantOpenAIKeychainQuery.add(credentialData: data, platform: platform)
      XCTAssertEqual(add[kSecClass as String] as? String, kSecClassGenericPassword as String)
      XCTAssertEqual(add[kSecAttrService as String] as? String, AssistantOpenAIKeychainQuery.service)
      XCTAssertEqual(add[kSecAttrAccount as String] as? String, AssistantOpenAIKeychainQuery.account)
      XCTAssertEqual(add[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(add[kSecUseDataProtectionKeychain as String] as? Bool, true)
      XCTAssertEqual(add[kSecValueData as String] as? Data, data)
      let expectedAccessibility: CFString =
        platform == .iOS ? kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      XCTAssertEqual(add[kSecAttrAccessible as String] as? String, expectedAccessibility as String)
    }
  }

  func testReadReturnsNilWhenNothingStored() async throws {
    let store = AssistantOpenAICredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    let value = try await store.readAPIKey()
    XCTAssertNil(value)
  }

  func testSaveThenReadRoundTrips() async throws {
    let client = RecordingKeychainClient()
    let store = AssistantOpenAICredentialStore(client: client, platform: .iOS)

    try await store.save(apiKey: "sk-test-first")
    let firstRead = try await store.readAPIKey()
    XCTAssertEqual(firstRead, "sk-test-first")
    // First save: `update` is attempted and misses, falling back to `add`.
    XCTAssertEqual(client.updateCallCount, 1)
    XCTAssertEqual(client.addCallCount, 1)

    try await store.save(apiKey: "sk-test-second")
    let secondRead = try await store.readAPIKey()
    XCTAssertEqual(secondRead, "sk-test-second")
    // Second save: an item already exists, so `update` alone succeeds.
    XCTAssertEqual(client.updateCallCount, 2)
    XCTAssertEqual(client.addCallCount, 1)
  }

  func testSaveRejectsEmptyString() async throws {
    let store = AssistantOpenAICredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    do {
      try await store.save(apiKey: "")
      XCTFail("expected invalidStoredValue")
    } catch AssistantOpenAICredentialStoreError.invalidStoredValue {
      // expected
    }
  }

  func testDeleteTreatsNotFoundAsSuccessNotAnError() async throws {
    let store = AssistantOpenAICredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    // No item was ever saved — this must not throw.
    try await store.delete()
  }

  func testDeleteRemovesAPreviouslySavedKey() async throws {
    let client = RecordingKeychainClient()
    let store = AssistantOpenAICredentialStore(client: client, platform: .iOS)
    try await store.save(apiKey: "sk-test")
    try await store.delete()
    let value = try await store.readAPIKey()
    XCTAssertNil(value)
    XCTAssertEqual(client.deleteCallCount, 1)
  }

  func testAuthFailedMapsToPasscodeRequiredOnlyOnIOS() async throws {
    let iOSStore = AssistantOpenAICredentialStore(
      client: AlwaysFailingKeychainClient(status: errSecAuthFailed), platform: .iOS)
    do {
      _ = try await iOSStore.readAPIKey()
      XCTFail("expected passcodeRequired")
    } catch AssistantOpenAICredentialStoreError.passcodeRequired {
      // expected
    }

    let macStore = AssistantOpenAICredentialStore(
      client: AlwaysFailingKeychainClient(status: errSecAuthFailed), platform: .macOS)
    do {
      _ = try await macStore.readAPIKey()
      XCTFail("expected unavailable")
    } catch AssistantOpenAICredentialStoreError.unavailable {
      // expected
    }
  }
}
