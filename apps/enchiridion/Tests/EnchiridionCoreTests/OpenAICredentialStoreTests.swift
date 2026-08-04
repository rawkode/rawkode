import Foundation
import Security
import XCTest

@testable import EnchiridionCore

final class OpenAICredentialStoreTests: XCTestCase {
  func testProductionQueriesUseExactIdentityAndNeverSynchronizeOrDeclareAccessGroup() {
    let data = Data("credential-placeholder".utf8)
    for platform in [OpenAICredentialPlatform.iOS, .macOS] {
      let add = OpenAIKeychainQuery.add(credentialData: data, platform: platform)
      XCTAssertEqual(add[kSecClass as String] as? String, kSecClassGenericPassword as String)
      XCTAssertEqual(add[kSecAttrService as String] as? String, OpenAIKeychainQuery.service)
      XCTAssertEqual(add[kSecAttrAccount as String] as? String, OpenAIKeychainQuery.account)
      XCTAssertEqual(add[kSecAttrSynchronizable as String] as? Bool, false)
      XCTAssertEqual(add[kSecUseDataProtectionKeychain as String] as? Bool, true)
      XCTAssertNil(add[kSecAttrAccessGroup as String])
      XCTAssertEqual(add[kSecValueData as String] as? Data, data)
      XCTAssertEqual(
        add[kSecAttrAccessible as String] as? String,
        expectedAccessibility(platform) as String
      )
    }

    let match = OpenAIKeychainQuery.match()
    XCTAssertEqual(
      Set(match.keys),
      keySet(
        kSecClass,
        kSecAttrService,
        kSecAttrAccount,
        kSecAttrSynchronizable,
        kSecUseDataProtectionKeychain
      ))
    XCTAssertNil(match[kSecAttrAccessGroup as String])

    let read = OpenAIKeychainQuery.read()
    XCTAssertEqual(read[kSecReturnData as String] as? Bool, true)
    XCTAssertEqual(read[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
    XCTAssertNil(read[kSecAttrAccessGroup as String])

    let contains = OpenAIKeychainQuery.contains()
    XCTAssertEqual(contains[kSecReturnAttributes as String] as? Bool, true)
    XCTAssertNil(contains[kSecReturnData as String])
    XCTAssertNil(contains[kSecAttrAccessGroup as String])
  }

  func testReplaceUsesUpdateBeforeAddAndDeleteTreatsNotFoundAsSuccess() async throws {
    let revisions = FixedRevisionGenerator(["first-revision", "replacement-revision"])
    let client = RecordingKeychainClient(
      updateStatuses: [errSecItemNotFound, errSecSuccess],
      deleteStatuses: [errSecItemNotFound]
    )
    let store = OpenAICredentialStore(
      client: client,
      platform: .iOS,
      revisionGenerator: { revisions.next() }
    )

    let first = try await store.replace(with: "first-placeholder", generation: 1)
    let replacement = try await store.replace(with: "replacement-placeholder", generation: 2)
    let deletion = try await store.deleteCredential(generation: 3)
    let stale = try await store.replace(with: "stale-placeholder", generation: 2)
    guard case .inserted(let firstBinding) = first else {
      return XCTFail("Expected an inserted credential")
    }
    guard case .replaced(let replacementBinding) = replacement else {
      return XCTFail("Expected a replaced credential")
    }
    XCTAssertEqual(firstBinding.revision, "first-revision")
    XCTAssertEqual(replacementBinding.revision, "replacement-revision")
    XCTAssertNotEqual(firstBinding.fingerprint, replacementBinding.fingerprint)
    XCTAssertEqual(deletion, .deleted)
    XCTAssertEqual(stale, .superseded)

    let snapshot = client.snapshot()
    XCTAssertEqual(snapshot.updates.count, 2)
    XCTAssertEqual(snapshot.adds.count, 1)
    XCTAssertEqual(snapshot.deletes.count, 1)
    XCTAssertEqual(
      snapshot.updates[0].attributes[kSecAttrAccessible as String] as? String,
      kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as String
    )
    XCTAssertNil(snapshot.updates[0].query[kSecAttrAccessGroup as String])
    XCTAssertNil(snapshot.deletes[0][kSecAttrAccessGroup as String])

    let insertedData = try XCTUnwrap(
      snapshot.adds[0][kSecValueData as String] as? Data
    )
    let insertedPayload = try JSONDecoder().decode(
      OpenAIKeychainCredentialPayload.self,
      from: insertedData
    )
    XCTAssertEqual(insertedPayload.credential, "first-placeholder")
    XCTAssertEqual(insertedPayload.revision, "first-revision")
    XCTAssertNotEqual(insertedData, Data("first-placeholder".utf8))
  }

  func testReadBindingAcceptsStructuredRecordAndRejectsLegacyAndMalformedValues() async throws {
    let validData = try JSONEncoder().encode(
      OpenAIKeychainCredentialPayload(
        credential: "credential-placeholder",
        revision: "record-revision"
      )
    )
    let validStore = OpenAICredentialStore(
      client: RecordingKeychainClient(copyResults: [.init(status: errSecSuccess, data: validData)]),
      platform: .macOS
    )
    let valid = try await validStore.readBinding(generation: 1)
    guard case .available(let binding) = valid else {
      return XCTFail("Expected a valid binding")
    }
    XCTAssertEqual(binding.revision, "record-revision")
    XCTAssertEqual(binding.fingerprint.count, 64)

    let legacyStore = OpenAICredentialStore(
      client: RecordingKeychainClient(
        copyResults: [.init(status: errSecSuccess, data: Data("legacy-raw-key".utf8))]
      ),
      platform: .macOS
    )
    let legacy = try await legacyStore.readBinding(generation: 1)
    XCTAssertEqual(legacy, .invalid)

    let malformedData = try JSONEncoder().encode(
      OpenAIKeychainCredentialPayload(credential: "credential-placeholder", revision: "")
    )
    let malformedStore = OpenAICredentialStore(
      client: RecordingKeychainClient(
        copyResults: [.init(status: errSecSuccess, data: malformedData)]
      ),
      platform: .macOS
    )
    let malformed = try await malformedStore.readBinding(generation: 1)
    XCTAssertEqual(malformed, .invalid)
  }

  func testReadAndMutationsShareGenerationAuthority() async throws {
    let data = try JSONEncoder().encode(
      OpenAIKeychainCredentialPayload(
        credential: "credential-placeholder",
        revision: "record-revision"
      )
    )
    let store = OpenAICredentialStore(
      client: RecordingKeychainClient(
        updateStatuses: [errSecSuccess],
        copyResults: [.init(status: errSecSuccess, data: data)]
      ),
      platform: .macOS,
      revisionGenerator: { "replacement-revision" }
    )

    _ = try await store.replace(with: "new-placeholder", generation: 2)
    let staleRead = try await store.readBinding(generation: 1)
    let staleDelete = try await store.deleteCredential(generation: 1)
    XCTAssertEqual(staleRead, .superseded)
    XCTAssertEqual(staleDelete, .superseded)
  }

  func testRevalidateSavedCredentialReturnsSameBindingWithoutMutation() async throws {
    let data = try credentialData("saved", revision: "stable")
    let client = RecordingKeychainClient(copyResults: [
      .init(status: errSecSuccess, data: data), .init(status: errSecSuccess, data: data),
    ])
    let store = OpenAICredentialStore(
      client: client, platform: .macOS, revalidationValidator: ImmediateStoreValidator()
    )
    let outcome = try await store.revalidateSavedCredential(generation: 1)
    guard case let .validated(_, binding) = outcome else { return XCTFail("Expected validation") }
    XCTAssertEqual(binding.revision, "stable")
    let snapshot = client.snapshot()
    XCTAssertTrue(snapshot.adds.isEmpty)
    XCTAssertTrue(snapshot.updates.isEmpty)
    XCTAssertTrue(snapshot.deletes.isEmpty)
  }

  func testRevalidateIsSupersededWhenNewerDeleteWinsWhileValidatorIsBlocked() async throws {
    let data = try credentialData("saved", revision: "stable")
    let validator = GatedStoreValidator()
    let store = OpenAICredentialStore(
      client: RecordingKeychainClient(copyResults: [.init(status: errSecSuccess, data: data)]),
      platform: .macOS, revalidationValidator: validator
    )
    let task = Task { try await store.revalidateSavedCredential(generation: 1) }
    await validator.waitForRequest()
    _ = try await store.deleteCredential(generation: 2)
    await validator.resume()
    guard case .superseded = try await task.value else { return XCTFail("Expected superseded") }
  }

  func testRevalidateIsSupersededWhenNewerReplaceWinsWhileValidatorIsBlocked() async throws {
    let data = try credentialData("saved", revision: "stable")
    let validator = GatedStoreValidator()
    let client = RecordingKeychainClient(
      updateStatuses: [errSecSuccess], copyResults: [.init(status: errSecSuccess, data: data)]
    )
    let store = OpenAICredentialStore(
      client: client, platform: .macOS, revalidationValidator: validator
    )
    let task = Task { try await store.revalidateSavedCredential(generation: 1) }
    await validator.waitForRequest()
    _ = try await store.replace(with: "new", generation: 2)
    await validator.resume()
    guard case .superseded = try await task.value else { return XCTFail("Expected superseded") }
  }

  func testRevalidateIsSupersededWhenKeychainPayloadChangesBetweenReads() async throws {
    let first = try credentialData("saved", revision: "stable")
    let second = try credentialData("other", revision: "new")
    let store = OpenAICredentialStore(
      client: RecordingKeychainClient(copyResults: [
        .init(status: errSecSuccess, data: first), .init(status: errSecSuccess, data: second),
      ]),
      platform: .macOS, revalidationValidator: ImmediateStoreValidator()
    )
    let outcome = try await store.revalidateSavedCredential(generation: 1)
    guard case .superseded = outcome else { return XCTFail("Expected superseded") }
  }

  func testRevalidateRejectsStaleGenerationBeforeCallingValidator() async throws {
    let data = try credentialData("saved", revision: "stable")
    let validator = ImmediateStoreValidator()
    let store = OpenAICredentialStore(
      client: RecordingKeychainClient(copyResults: [.init(status: errSecSuccess, data: data)]),
      platform: .macOS, revalidationValidator: validator
    )
    _ = try await store.readBinding(generation: 2)
    let outcome = try await store.revalidateSavedCredential(generation: 1)
    guard case .superseded = outcome else { return XCTFail("Expected superseded") }
    let requestCount = await validator.requestCount()
    XCTAssertEqual(requestCount, 0)
  }

  func testIOSAuthenticationFailureIsReportedAsPasscodeRequired() async {
    let client = RecordingKeychainClient(
      updateStatuses: [errSecItemNotFound], addStatuses: [errSecAuthFailed])
    let store = OpenAICredentialStore(client: client, platform: .iOS)

    do {
      _ = try await store.replace(with: "credential-placeholder", generation: 1)
      XCTFail("Expected passcode refusal")
    } catch {
      XCTAssertEqual(error as? OpenAICredentialStoreError, .passcodeRequired)
    }
  }

  func testSystemKeychainUniqueServiceSaveReadDeleteRoundTrip() throws {
    #if os(macOS)
      let service = "dev.rawkode.enchiridion.openai.test.\(UUID().uuidString)"
      let account = "runtime-test"
      let data = Data("credential-placeholder".utf8)
      let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecUseDataProtectionKeychain as String: true,
      ]
      defer { SecItemDelete(base as CFDictionary) }

      var add = base
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      add[kSecValueData as String] = data
      let addStatus = SecItemAdd(add as CFDictionary, nil)
      if addStatus == errSecMissingEntitlement || addStatus == errSecNotAvailable {
        throw XCTSkip("The test host cannot access the data-protection Keychain.")
      }
      XCTAssertEqual(addStatus, errSecSuccess)

      var read = base
      read[kSecReturnData as String] = true
      read[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, &result), errSecSuccess)
      XCTAssertEqual(result as? Data, data)
      XCTAssertEqual(SecItemDelete(base as CFDictionary), errSecSuccess)
      XCTAssertEqual(SecItemCopyMatching(read as CFDictionary, nil), errSecItemNotFound)
    #else
      throw XCTSkip("The Swift package test host is not an iOS Simulator app.")
    #endif
  }

  private func expectedAccessibility(_ platform: OpenAICredentialPlatform) -> CFString {
    switch platform {
    case .iOS: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
    case .macOS: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    }
  }

  private func keySet(_ values: CFString...) -> Set<String> {
    Set(values.map { $0 as String })
  }

  private func credentialData(_ credential: String, revision: String) throws -> Data {
    try JSONEncoder().encode(OpenAIKeychainCredentialPayload(credential: credential, revision: revision))
  }
}

private actor ImmediateStoreValidator: OpenAICredentialValidating {
  private var count = 0
  func validate(credential: String) async throws -> OpenAIValidationResult {
    count += 1
    return .init(capabilities: .init(catalogVersion: OpenAIModelCatalog.version, textModelIDs: [], realtimeModelIDs: []), requestID: nil)
  }
  func requestCount() -> Int { count }
}

private actor GatedStoreValidator: OpenAICredentialValidating {
  private var continuation: CheckedContinuation<Void, Never>?
  func validate(credential: String) async throws -> OpenAIValidationResult {
    await withCheckedContinuation { continuation in self.continuation = continuation }
    return .init(capabilities: .init(catalogVersion: OpenAIModelCatalog.version, textModelIDs: [], realtimeModelIDs: []), requestID: nil)
  }
  func waitForRequest() async { while continuation == nil { await Task.yield() } }
  func resume() { continuation?.resume(); continuation = nil }
}

private final class RecordingKeychainClient: KeychainClient, @unchecked Sendable {
  struct CopyResult {
    let status: OSStatus
    let data: Data?
  }

  struct Update {
    let query: [String: Any]
    let attributes: [String: Any]
  }

  private let lock = NSLock()
  private var updateStatuses: [OSStatus]
  private var addStatuses: [OSStatus]
  private var deleteStatuses: [OSStatus]
  private var copyResults: [CopyResult]
  private var recordedAdds: [[String: Any]] = []
  private var recordedUpdates: [Update] = []
  private var recordedDeletes: [[String: Any]] = []

  init(
    updateStatuses: [OSStatus] = [],
    addStatuses: [OSStatus] = [errSecSuccess],
    deleteStatuses: [OSStatus] = [errSecSuccess],
    copyResults: [CopyResult] = []
  ) {
    self.updateStatuses = updateStatuses
    self.addStatuses = addStatuses
    self.deleteStatuses = deleteStatuses
    self.copyResults = copyResults
  }

  func add(_ attributes: CFDictionary) -> OSStatus {
    lock.withLock {
      recordedAdds.append(attributes as NSDictionary as! [String: Any])
      return addStatuses.isEmpty ? errSecSuccess : addStatuses.removeFirst()
    }
  }

  func copyMatching(
    _ query: CFDictionary,
    result: UnsafeMutablePointer<CFTypeRef?>?
  ) -> OSStatus {
    lock.withLock {
      guard !copyResults.isEmpty else { return errSecItemNotFound }
      let copy = copyResults.removeFirst()
      if let data = copy.data {
        result?.pointee = data as CFData
      }
      return copy.status
    }
  }

  func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
    lock.withLock {
      recordedUpdates.append(
        .init(
          query: query as NSDictionary as! [String: Any],
          attributes: attributes as NSDictionary as! [String: Any]
        ))
      return updateStatuses.isEmpty ? errSecSuccess : updateStatuses.removeFirst()
    }
  }

  func delete(_ query: CFDictionary) -> OSStatus {
    lock.withLock {
      recordedDeletes.append(query as NSDictionary as! [String: Any])
      return deleteStatuses.isEmpty ? errSecSuccess : deleteStatuses.removeFirst()
    }
  }

  func snapshot() -> (adds: [[String: Any]], updates: [Update], deletes: [[String: Any]]) {
    lock.withLock { (recordedAdds, recordedUpdates, recordedDeletes) }
  }
}

private final class FixedRevisionGenerator: @unchecked Sendable {
  private let lock = NSLock()
  private var revisions: [String]

  init(_ revisions: [String]) {
    self.revisions = revisions
  }

  func next() -> String {
    lock.withLock { revisions.removeFirst() }
  }
}
