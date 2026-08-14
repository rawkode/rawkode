import Foundation
import XCTest

@testable import EnchiridionUI

final class AppBackendConfigurationTests: XCTestCase {
  func testLocalVaultConfigurationBuildsAWebSocketSyncURLForLoopback() throws {
    let configuration = try XCTUnwrap(
      AppBackendConfiguration.localVaultSyncConfiguration(
        environment: [
          "ENCHIRIDION_LOCAL_VAULT_URL": "http://127.0.0.1:8787",
          "ENCHIRIDION_LOCAL_VAULT_TOKEN": "prototype-token",
          "ENCHIRIDION_LOCAL_STORE_PATH": "/private/tmp/enchiridion-test.sqlite",
        ]))

    XCTAssertEqual(configuration.baseURL, URL(string: "http://127.0.0.1:8787")!)
    XCTAssertEqual(configuration.syncURL, URL(string: "ws://127.0.0.1:8787/sync")!)
    XCTAssertEqual(configuration.token, "prototype-token")
    XCTAssertEqual(configuration.storePath, "/private/tmp/enchiridion-test.sqlite")
  }

  func testLocalVaultConfigurationRejectsMissingCredentialsAndRemoteHosts() {
    XCTAssertNil(
      AppBackendConfiguration.localVaultSyncConfiguration(
        environment: ["ENCHIRIDION_LOCAL_VAULT_URL": "http://127.0.0.1:8787"]))
    XCTAssertNil(
      AppBackendConfiguration.localVaultSyncConfiguration(
        environment: [
          "ENCHIRIDION_LOCAL_VAULT_URL": "https://vault.example.com",
          "ENCHIRIDION_LOCAL_VAULT_TOKEN": "prototype-token",
        ]))
  }
}
