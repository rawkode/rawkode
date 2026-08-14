// LocalVaultSyncE2ETests.swift
//
// Opt-in proof against a real `wrangler dev --local` Vault. It is skipped in
// ordinary unit-test runs; `scripts/run-local-prototype.sh` supplies the
// environment and makes this part of the local prototype gate.

import EnchiridionCore
import EnchiridionStore
import EnchiridionSync
import Foundation
import XCTest

@testable import EnchiridionUI

final class LocalVaultSyncE2ETests: XCTestCase {
  func testTwoNativeStoresConvergeThroughTheLocalVault() async throws {
    guard ProcessInfo.processInfo.environment["ENCHIRIDION_RUN_LOCAL_VAULT_E2E"] == "1" else {
      throw XCTSkip("requires scripts/run-local-prototype.sh or an explicitly running local Vault")
    }
    let configuration = try XCTUnwrap(AppBackendConfiguration.localVaultSyncConfiguration)

    let storeA = try LocalGraphStore.openTemporary()
    let storeB = try LocalGraphStore.openTemporary()
    let coordinatorA = LocalVaultSyncCoordinator(store: storeA, configuration: configuration)
    let coordinatorB = LocalVaultSyncCoordinator(store: storeB, configuration: configuration)
    await coordinatorA.start()
    await coordinatorB.start()

    // This proof must exercise a genuinely new document. The restart proof
    // below intentionally uses a stable page id, but reusing that document
    // here would merge two independent Loro replicas and turn this transport
    // test into a title-conflict test on its second run.
    let pageID = PageID.free()
    let created = try PageDocument.create(id: pageID, kind: .free, title: "Local Vault E2E")
    try await storeA.saveDocumentSnapshot(
      pageID: pageID, snapshot: created.document, version: created.version)

    let didConverge = try await waitUntil {
      guard let remote = try await storeB.documentSnapshot(for: pageID) else { return false }
      return try PageDocument.projection(of: remote.snapshot).title == "Local Vault E2E"
    }

    await coordinatorA.stop()
    await coordinatorB.stop()
    XCTAssertTrue(didConverge, "the second native store never received the local Vault snapshot")
  }

  func testNativeStoreDownloadsTheDocumentAfterTheVaultRestarts() async throws {
    guard ProcessInfo.processInfo.environment["ENCHIRIDION_RUN_LOCAL_VAULT_E2E"] == "1" else {
      throw XCTSkip("requires scripts/run-local-prototype.sh or an explicitly running local Vault")
    }
    let configuration = try XCTUnwrap(AppBackendConfiguration.localVaultSyncConfiguration)
    let store = try LocalGraphStore.openTemporary()
    let coordinator = LocalVaultSyncCoordinator(store: store, configuration: configuration)
    let pageID = prototypePageID
    await coordinator.start()

    let didDownload = try await waitUntil {
      guard let remote = try await store.documentSnapshot(for: pageID) else { return false }
      return try PageDocument.projection(of: remote.snapshot).title == "Local Vault E2E"
    }

    await coordinator.stop()
    XCTAssertTrue(didDownload, "the restarted Vault did not return its persisted CRDT document")
  }

  private func waitUntil(
    timeout: Duration = .seconds(10),
    condition: @escaping @Sendable () async throws -> Bool
  ) async throws -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if try await condition() { return true }
      try await Task.sleep(for: .milliseconds(50))
    }
    return false
  }

  private var prototypePageID: PageID {
    if let rawValue = ProcessInfo.processInfo.environment["ENCHIRIDION_LOCAL_VAULT_E2E_PAGE_ID"], !rawValue.isEmpty {
      return PageID(rawValue: rawValue)
    }
    return PageID(rawValue: "page_local_vault_e2e")
  }
}
