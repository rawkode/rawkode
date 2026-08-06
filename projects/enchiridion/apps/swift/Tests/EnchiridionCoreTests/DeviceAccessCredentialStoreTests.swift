// DeviceAccessCredentialStoreTests.swift
// EnchiridionCoreTests
//
// Mirrors AssistantOpenAICredentialStoreTests.swift's structure exactly
// (same fake-Keychain-client approach, reused from that file since both
// stores share `AssistantKeychainClient`) — covers the Keychain query
// shape and the actor's save/read/delete logic against a fake, never the
// real Keychain.

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

  func add(_ attributes: CFDictionary) -> OSStatus {
    lock.withLock {
      addCallCount += 1
      let dict = attributes as! [String: Any]
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

private func sampleCredential(deviceName: String = "David's iPhone") -> DeviceAccessCredential {
  DeviceAccessCredential(
    clientId: "abc123.access",
    clientSecret: "shh-secret",
    deviceName: deviceName,
    mintedAt: Date(timeIntervalSince1970: 1_700_000_000),
    expiresAt: Date(timeIntervalSince1970: 1_700_000_000 + 8760 * 60 * 60)
  )
}

final class DeviceAccessCredentialStoreTests: XCTestCase {
  func testKeychainQueryShapeIsDeviceOnlyNonSynchronizableDataProtectionKeychain() {
    let data = Data("placeholder".utf8)
    for platform in [AssistantOpenAICredentialPlatform.iOS, .macOS] {
      let add = DeviceAccessKeychainQuery.add(credentialData: data, platform: platform)
      XCTAssertEqual(add[kSecClass as String] as? String, kSecClassGenericPassword as String)
      XCTAssertEqual(add[kSecAttrService as String] as? String, DeviceAccessKeychainQuery.service)
      XCTAssertEqual(add[kSecAttrAccount as String] as? String, DeviceAccessKeychainQuery.account)
      XCTAssertEqual(add[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(add[kSecUseDataProtectionKeychain as String] as? Bool, true)
      let expectedAccessibility: CFString =
        platform == .iOS ? kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      XCTAssertEqual(add[kSecAttrAccessible as String] as? String, expectedAccessibility as String)
    }
  }

  func testServiceStringDoesNotCollideWithTheOpenAICredentialStore() {
    XCTAssertNotEqual(DeviceAccessKeychainQuery.service, AssistantOpenAIKeychainQuery.service)
  }

  func testReadReturnsNilWhenNothingStored() async throws {
    let store = DeviceAccessCredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    let value = try await store.readCredential()
    XCTAssertNil(value)
  }

  func testSaveThenReadRoundTripsAllFields() async throws {
    let client = RecordingKeychainClient()
    let store = DeviceAccessCredentialStore(client: client, platform: .iOS)
    let credential = sampleCredential()

    try await store.save(credential: credential)
    let read = try await store.readCredential()

    XCTAssertEqual(read, credential)
    XCTAssertEqual(client.updateCallCount, 1)
    XCTAssertEqual(client.addCallCount, 1)
  }

  func testSavingASecondCredentialReplacesTheFirst() async throws {
    let client = RecordingKeychainClient()
    let store = DeviceAccessCredentialStore(client: client, platform: .iOS)

    try await store.save(credential: sampleCredential(deviceName: "Old Device"))
    try await store.save(credential: sampleCredential(deviceName: "New Device"))

    let read = try await store.readCredential()
    XCTAssertEqual(read?.deviceName, "New Device")
    XCTAssertEqual(client.updateCallCount, 2)
    XCTAssertEqual(client.addCallCount, 1)
  }

  func testSaveRejectsAnEmptyClientIdOrSecret() async throws {
    let store = DeviceAccessCredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    var credential = sampleCredential()
    credential.clientId = ""
    do {
      try await store.save(credential: credential)
      XCTFail("expected invalidStoredValue")
    } catch DeviceAccessCredentialStoreError.invalidStoredValue {
      // expected
    }
  }

  func testDeleteTreatsNotFoundAsSuccessNotAnError() async throws {
    let store = DeviceAccessCredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    try await store.delete()
  }

  func testDeleteRemovesAPreviouslySavedCredential() async throws {
    let client = RecordingKeychainClient()
    let store = DeviceAccessCredentialStore(client: client, platform: .iOS)
    try await store.save(credential: sampleCredential())
    try await store.delete()
    let value = try await store.readCredential()
    XCTAssertNil(value)
    XCTAssertEqual(client.deleteCallCount, 1)
  }

  func testAuthFailedMapsToPasscodeRequiredOnlyOnIOS() async throws {
    let iOSStore = DeviceAccessCredentialStore(
      client: AlwaysFailingKeychainClient(status: errSecAuthFailed), platform: .iOS)
    do {
      _ = try await iOSStore.readCredential()
      XCTFail("expected passcodeRequired")
    } catch DeviceAccessCredentialStoreError.passcodeRequired {
      // expected
    }

    let macStore = DeviceAccessCredentialStore(
      client: AlwaysFailingKeychainClient(status: errSecAuthFailed), platform: .macOS)
    do {
      _ = try await macStore.readCredential()
      XCTFail("expected unavailable")
    } catch DeviceAccessCredentialStoreError.unavailable {
      // expected
    }
  }

  func testCorruptedStoredDataThrowsInvalidStoredValueRatherThanCrashing() async throws {
    let client = RecordingKeychainClient()
    // Prime the fake with data that isn't valid encoded JSON for
    // `DeviceAccessCredential` — simulates a corrupted/foreign Keychain
    // item, distinct from "the OpenAI store's plain-string item" (which
    // this store must not attempt to decode as its own JSON shape).
    _ = client.add(
      [kSecValueData as String: Data("not json".utf8)] as CFDictionary)
    let store = DeviceAccessCredentialStore(client: client, platform: .iOS)

    do {
      _ = try await store.readCredential()
      XCTFail("expected invalidStoredValue")
    } catch DeviceAccessCredentialStoreError.invalidStoredValue {
      // expected
    }
  }
}

// MARK: - DeviceAccessCredentialResolver (task #96, plan §Live Backend
// Connectivity (P8) scope item 2/4) — the shared "resolve this device's
// credential, or throw a real, distinct 'not enrolled' error" seam every
// real client (`AssistantRemoteWriteClient`, `VaultEmailSearchClient`,
// `BlobCache` via `PageCanvasEmbedding.swift`) is wired through.

final class DeviceAccessCredentialResolverTests: XCTestCase {
  func testResolveCredentialThrowsDeviceNotEnrolledWhenNothingIsStored() async throws {
    let store = DeviceAccessCredentialStore(client: RecordingKeychainClient(), platform: .iOS)
    let resolver = DeviceAccessCredentialResolver(store: store)

    do {
      _ = try await resolver.resolveCredential()
      XCTFail("expected deviceNotEnrolled")
    } catch DeviceAccessCredentialResolutionError.deviceNotEnrolled {
      // expected — a real, catchable, distinct error, not a crash or silent no-op.
    }
  }

  func testResolveCredentialReturnsTheStoredCredentialWhenOneExists() async throws {
    let client = RecordingKeychainClient()
    let store = DeviceAccessCredentialStore(client: client, platform: .iOS)
    let credential = sampleCredential()
    try await store.save(credential: credential)
    let resolver = DeviceAccessCredentialResolver(store: store)

    let resolved = try await resolver.resolveCredential()

    XCTAssertEqual(resolved, credential)
  }

  func testResolveCredentialWrapsAGenuineKeychainLayerFailureDistinctlyFromNotEnrolled() async throws {
    let store = DeviceAccessCredentialStore(
      client: AlwaysFailingKeychainClient(status: errSecAuthFailed), platform: .iOS)
    let resolver = DeviceAccessCredentialResolver(store: store)

    do {
      _ = try await resolver.resolveCredential()
      XCTFail("expected storeUnavailable")
    } catch DeviceAccessCredentialResolutionError.storeUnavailable(let underlying) {
      XCTAssertEqual(underlying, .passcodeRequired)
    }
  }
}
