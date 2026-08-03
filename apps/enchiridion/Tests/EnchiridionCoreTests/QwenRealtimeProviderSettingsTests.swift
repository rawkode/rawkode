import XCTest
@testable import EnchiridionCore

final class QwenRealtimeProviderSettingsTests: XCTestCase {
  func testCanonicalWorkspaceBuildsOnlyBeijingWorkspaceEndpoint() throws {
    let endpoint = try XCTUnwrap(QwenWorkspace.endpoint(workspaceID: "Team-42", model: .flash))
    XCTAssertEqual(endpoint.absoluteString, "wss://team-42.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-flash")
    XCTAssertEqual(QwenWorkspace.canonicalID(" TEAM-42 "), "team-42")
    XCTAssertNil(QwenWorkspace.endpoint(workspaceID: "team.42", model: .plus))
    XCTAssertNil(QwenWorkspace.endpoint(workspaceID: "https://elsewhere", model: .plus))
  }

  func testBothShippedRealtimeTiersAndDefaultVoiceAreStable() {
    XCTAssertEqual(QwenRealtimeModel.allCases.map(\.rawValue), ["qwen-audio-3.0-realtime-flash", "qwen-audio-3.0-realtime-plus"])
    XCTAssertEqual(QwenRealtimeVoice.allCases, [.longanqian, .longanlingxin, .longanlingxi, .longanxiaoxin, .longanlufeng])
    XCTAssertEqual(QwenRealtimeVoice.longanqian.title, "Longanqian")
  }

  func testRouteRequiresFrozenWorkspaceModelVoiceAndCredential() throws {
    let authorized = QwenVoiceRouteSnapshot(workspaceID: "personal", model: .plus, voice: .longanqian, credentialBinding: .init(revision: "r1", fingerprint: "f1"))
    XCTAssertTrue(authorized.isAuthorized)
    let configuration = try QwenRealtimeConfiguration(route: authorized)
    XCTAssertEqual(configuration.endpoint.absoluteString, "wss://personal.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus")
    XCTAssertThrowsError(try QwenRealtimeConfiguration(route: .init(workspaceID: "personal", model: .flash, voice: .longanqian)))
  }

  func testVerificationUsesOnlyCanonicalEndpointAndBearerToken() async throws {
    let transport = VerificationTransport()
    let validator = QwenWorkspaceValidator(transport: transport)
    try await validator.validate(token: "secret", workspaceID: "Workspace-1", model: .flash)
    let request = await transport.request
    XCTAssertEqual(request?.endpoint.absoluteString, "wss://workspace-1.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-flash")
    XCTAssertEqual(request?.authorization, "Bearer secret")
  }

  func testVerificationMapsAuthenticationRedirectAndTimeoutFailures() async {
    for (failure, expected) in [
      (QwenWorkspaceVerificationTransportError.rejected, QwenWorkspaceValidationError.rejected),
      (.redirectBlocked, .redirectBlocked),
      (.timedOut, .timedOut),
    ] {
      let validator = QwenWorkspaceValidator(transport: VerificationTransport(error: failure))
      do {
        try await validator.validate(token: "secret", workspaceID: "workspace", model: .flash)
        XCTFail("Expected validation to fail")
      } catch let error as QwenWorkspaceValidationError { XCTAssertEqual(error, expected) }
      catch { XCTFail("Unexpected error: \(error)") }
    }
  }

  func testVerificationRejectsInvalidWorkspaceBeforeTransport() async {
    let transport = VerificationTransport()
    let validator = QwenWorkspaceValidator(transport: transport)
    do {
      try await validator.validate(token: "secret", workspaceID: "workspace.example", model: .flash)
      XCTFail("Expected validation to fail")
    } catch let error as QwenWorkspaceValidationError { XCTAssertEqual(error, .invalidWorkspace) }
    catch { XCTFail("Unexpected error: \(error)") }
    let request = await transport.request
    XCTAssertNil(request)
  }
}

private actor VerificationTransport: QwenWorkspaceVerificationTransport {
  private(set) var request: QwenWorkspaceVerificationRequest?
  private let error: QwenWorkspaceVerificationTransportError?
  init(error: QwenWorkspaceVerificationTransportError? = nil) { self.error = error }
  func verify(_ request: QwenWorkspaceVerificationRequest) async throws {
    self.request = request
    if let error { throw error }
  }
}
