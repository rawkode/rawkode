import CryptoKit
import Foundation
import Security

/// Qwen-Audio Realtime is intentionally an additional voice route. Its
/// workspace-specific Beijing endpoint is part of the authorization binding.
public enum QwenRealtimeModel: String, CaseIterable, Codable, Identifiable, Sendable {
  case flash = "qwen-audio-3.0-realtime-flash"
  case plus = "qwen-audio-3.0-realtime-plus"

  public var id: String { rawValue }
  public var title: String { self == .flash ? "Flash" : "Plus" }
}

public enum QwenRealtimeVoice: String, CaseIterable, Codable, Identifiable, Sendable {
  case longanqian
  case longanlingxin
  case longanlingxi
  case longanxiaoxin
  case longanlufeng
  public var id: String { rawValue }
  public var title: String {
    switch self {
    case .longanqian: "Longanqian"
    case .longanlingxin: "Longan Lingxin"
    case .longanlingxi: "Longan Lingxi"
    case .longanxiaoxin: "Longan Xiaoxin"
    case .longanlufeng: "Longan Lufeng"
    }
  }
}

public enum QwenWorkspace: Equatable, Sendable {
  /// Model Studio workspace IDs are DNS labels. Rejecting any other spelling
  /// prevents an API key from ever being sent to a caller-selected host.
  public static func canonicalID(_ value: String) -> String? {
    let id = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard id.count >= 1, id.count <= 63,
      id.unicodeScalars.allSatisfy({
        ($0.value >= 97 && $0.value <= 122) || ($0.value >= 48 && $0.value <= 57) || $0.value == 45
      }), id.first != "-", id.last != "-"
    else { return nil }
    return id
  }

  public static func endpoint(workspaceID: String, model: QwenRealtimeModel) -> URL? {
    guard let workspaceID = canonicalID(workspaceID) else { return nil }
    var components = URLComponents()
    components.scheme = "wss"
    components.host = "\(workspaceID).cn-beijing.maas.aliyuncs.com"
    components.path = "/api-ws/v1/realtime"
    components.queryItems = [URLQueryItem(name: "model", value: model.rawValue)]
    return components.url
  }
}

public struct QwenCredentialBinding: Codable, Equatable, Sendable {
  public let revision: String
  public let fingerprint: String
  public init(revision: String, fingerprint: String) { self.revision = revision; self.fingerprint = fingerprint }
}

public struct QwenVoiceRouteSnapshot: Equatable, Sendable {
  public let workspaceID: String?
  public let model: QwenRealtimeModel?
  public let voice: QwenRealtimeVoice?
  public let credentialBinding: QwenCredentialBinding?

  public init(workspaceID: String? = nil, model: QwenRealtimeModel? = nil, voice: QwenRealtimeVoice? = nil, credentialBinding: QwenCredentialBinding? = nil) {
    self.workspaceID = workspaceID; self.model = model; self.voice = voice; self.credentialBinding = credentialBinding
  }

  public var isAuthorized: Bool {
    workspaceID.flatMap(QwenWorkspace.canonicalID) != nil && model != nil && voice != nil && credentialBinding != nil
  }
}

public enum QwenRealtimeConfigurationError: Error, Equatable, Sendable { case unauthorizedRoute, invalidEndpoint }

public struct QwenRealtimeConfiguration: Equatable, Sendable {
  public let endpoint: URL
  public let modelID: String
  public let voiceID: String
  public let credentialBinding: QwenCredentialBinding
  public let enablesTools: Bool

  public init(route: QwenVoiceRouteSnapshot, enablesTools: Bool = false) throws {
    guard route.isAuthorized, let workspaceID = route.workspaceID, let model = route.model,
      let voice = route.voice, let binding = route.credentialBinding else { throw QwenRealtimeConfigurationError.unauthorizedRoute }
    guard let endpoint = QwenWorkspace.endpoint(workspaceID: workspaceID, model: model) else { throw QwenRealtimeConfigurationError.invalidEndpoint }
    self.endpoint = endpoint; modelID = model.rawValue; voiceID = voice.rawValue; credentialBinding = binding
    self.enablesTools = enablesTools
  }
}

private struct QwenKeychainPayload: Codable { let credential: String; let revision: String }
private enum QwenKeychainQuery {
  static let service = "dev.rawkode.enchiridion.qwen.api-key"
  static let account = "realtime-byok-v1"
  static func match() -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false, kSecUseDataProtectionKeychain as String: true] }
}

public actor QwenCredentialStore {
  public init() {}
  public func replace(_ credential: String) throws -> QwenCredentialBinding {
    let payload = QwenKeychainPayload(credential: credential, revision: UUID().uuidString.lowercased())
    let data = try JSONEncoder().encode(payload)
    let status = SecItemUpdate(QwenKeychainQuery.match() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var add = QwenKeychainQuery.match(); add[kSecValueData as String] = data
      #if os(iOS)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
      #else
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      #endif
      guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw QwenCredentialStoreError.unavailable }
    } else if status != errSecSuccess { throw QwenCredentialStoreError.unavailable }
    return binding(payload)
  }
  public func delete() throws { let status = SecItemDelete(QwenKeychainQuery.match() as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw QwenCredentialStoreError.unavailable } }
  public func binding() throws -> QwenCredentialBinding? {
    var query = QwenKeychainQuery.match(); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
    var output: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &output)
    if status == errSecItemNotFound { return nil }; guard status == errSecSuccess, let data = output as? Data, let payload = try? JSONDecoder().decode(QwenKeychainPayload.self, from: data), !payload.credential.isEmpty else { throw QwenCredentialStoreError.unavailable }
    return binding(payload)
  }
  func runtimeCredential(matching binding: QwenCredentialBinding) throws -> String {
    var query = QwenKeychainQuery.match(); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
    var output: CFTypeRef?; guard SecItemCopyMatching(query as CFDictionary, &output) == errSecSuccess, let data = output as? Data, let payload = try? JSONDecoder().decode(QwenKeychainPayload.self, from: data), Self.binding(payload) == binding else { throw QwenCredentialStoreError.bindingMismatch }
    return payload.credential
  }
  private static func binding(_ payload: QwenKeychainPayload) -> QwenCredentialBinding { QwenCredentialBinding(revision: payload.revision, fingerprint: SHA256.hash(data: Data(payload.credential.utf8)).map { String(format: "%02x", $0) }.joined()) }
  private func binding(_ payload: QwenKeychainPayload) -> QwenCredentialBinding { Self.binding(payload) }
}

public enum QwenCredentialStoreError: Error, Equatable, Sendable { case unavailable, bindingMismatch }
public struct QwenRealtimeCredentialLease: @unchecked Sendable {
  let credential: String; public let binding: QwenCredentialBinding
  public func withSecret<Result>(_ body: (String) throws -> Result) rethrows -> Result { try body(credential) }
}
public protocol QwenRealtimeCredentialReading: Sendable { func qwenRealtimeCredential(matching binding: QwenCredentialBinding) async throws -> QwenRealtimeCredentialLease }
extension QwenCredentialStore: QwenRealtimeCredentialReading { public func qwenRealtimeCredential(matching binding: QwenCredentialBinding) async throws -> QwenRealtimeCredentialLease { QwenRealtimeCredentialLease(credential: try runtimeCredential(matching: binding), binding: binding) } }

public enum QwenWorkspaceValidationError: Error, Equatable, Sendable {
  case invalidWorkspace
  case rejected
  case redirectBlocked
  case timedOut
  case unavailable
}

public struct QwenWorkspaceVerificationRequest: Sendable {
  public let endpoint: URL
  public let authorization: String
  public init(endpoint: URL, authorization: String) {
    self.endpoint = endpoint
    self.authorization = authorization
  }
}

public enum QwenWorkspaceVerificationTransportError: Error, Equatable, Sendable {
  case rejected
  case redirectBlocked
  case timedOut
  case unavailable
  case invalidResponse
}

/// A deliberately narrow test seam: successful verification means the exact
/// endpoint completed an authenticated session and emitted `session.created`.
public protocol QwenWorkspaceVerificationTransport: Sendable {
  func verify(_ request: QwenWorkspaceVerificationRequest) async throws
}

public final class QwenWorkspaceURLSessionTransport: NSObject, QwenWorkspaceVerificationTransport,
  URLSessionTaskDelegate, @unchecked Sendable
{
  private lazy var session = URLSession(
    configuration: OpenAIModelsURLSessionTransport.restrictedConfiguration(),
    delegate: self,
    delegateQueue: nil
  )

  public override init() {}

  public func verify(_ request: QwenWorkspaceVerificationRequest) async throws {
    guard request.endpoint.scheme == "wss",
      request.endpoint.host?.hasSuffix(".cn-beijing.maas.aliyuncs.com") == true,
      request.endpoint.path == "/api-ws/v1/realtime"
    else { throw QwenWorkspaceVerificationTransportError.redirectBlocked }
    var handshake = URLRequest(url: request.endpoint)
    handshake.timeoutInterval = 20
    handshake.setValue(request.authorization, forHTTPHeaderField: "Authorization")
    let task = session.webSocketTask(with: handshake)
    task.resume()
    defer { task.cancel(with: .goingAway, reason: nil) }
    do {
      // Qwen emits `session.created` immediately after the authenticated
      // WebSocket handshake. Verification never configures a session or sends
      // user content, tools, or local state.
      let message = try await firstMessage(from: task)
      guard Self.isSessionCreated(message) else { throw QwenWorkspaceVerificationTransportError.invalidResponse }
    } catch let error as QwenWorkspaceVerificationTransportError { throw error }
    catch is CancellationError { throw QwenWorkspaceVerificationTransportError.timedOut }
    catch { throw QwenWorkspaceVerificationTransportError.rejected }
  }

  public func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }

  private func firstMessage(from task: URLSessionWebSocketTask) async throws -> URLSessionWebSocketTask.Message {
    try await withThrowingTaskGroup(of: URLSessionWebSocketTask.Message.self) { group in
      group.addTask { try await task.receive() }
      group.addTask {
        try await Task.sleep(for: .seconds(20))
        throw QwenWorkspaceVerificationTransportError.timedOut
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw QwenWorkspaceVerificationTransportError.unavailable }
      return first
    }
  }

  private static func isSessionCreated(_ message: URLSessionWebSocketTask.Message) -> Bool {
    let data: Data
    switch message { case .string(let value): data = Data(value.utf8); case .data(let value): data = value; @unknown default: return false }
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = object["type"] as? String
    else { return false }
    return type == "session.created"
  }
}

public protocol QwenWorkspaceValidating: Sendable { func validate(token: String, workspaceID: String, model: QwenRealtimeModel) async throws }
/// Validation connects only to the canonical, workspace-bound Beijing endpoint.
/// The WebSocket handshake authenticates the supplied key; no library content is sent.
public struct QwenWorkspaceValidator: QwenWorkspaceValidating {
  private let transport: any QwenWorkspaceVerificationTransport
  public init(transport: any QwenWorkspaceVerificationTransport = QwenWorkspaceURLSessionTransport()) { self.transport = transport }
  public func validate(token: String, workspaceID: String, model: QwenRealtimeModel) async throws {
    guard !token.isEmpty, let endpoint = QwenWorkspace.endpoint(workspaceID: workspaceID, model: model) else { throw QwenWorkspaceValidationError.invalidWorkspace }
    do {
      try await transport.verify(.init(endpoint: endpoint, authorization: "Bearer \(token)"))
    } catch let error as QwenWorkspaceVerificationTransportError {
      switch error {
      case .redirectBlocked: throw QwenWorkspaceValidationError.redirectBlocked
      case .timedOut: throw QwenWorkspaceValidationError.timedOut
      case .rejected, .invalidResponse: throw QwenWorkspaceValidationError.rejected
      case .unavailable: throw QwenWorkspaceValidationError.unavailable
      }
    } catch {
      throw QwenWorkspaceValidationError.unavailable
    }
  }
}
