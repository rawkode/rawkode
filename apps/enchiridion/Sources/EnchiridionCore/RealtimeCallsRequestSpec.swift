import Foundation

public struct RealtimeCallsRequestSpec: Equatable, Sendable {
  public let endpoint: URL
  public let method: String
  public let contentType: String
  public let cacheControl: String
  public let body: Data

  fileprivate init(
    endpoint: URL,
    method: String,
    contentType: String,
    cacheControl: String,
    body: Data
  ) {
    self.endpoint = endpoint
    self.method = method
    self.contentType = contentType
    self.cacheControl = cacheControl
    self.body = body
  }
}

public enum RealtimeCallsRequestSpecError: Error, Equatable, Sendable {
  case unauthorizedRoute
  case invalidOffer
  case invalidSession
  case invalidBoundary
  case invalidAnswer
}

/// Pure, non-networking construction of the only request shape the native
/// Realtime calls executor may use. This type never accepts a credential and
/// cannot perform egress.
public enum RealtimeCallsRequestSpecBuilder {
  public static let endpoint = URL(string: "https://api.openai.com/v1/realtime/calls")!
  public static let maximumOfferBytes = 128 * 1024
  public static let maximumSessionBytes = 32 * 1024
  public static let maximumAnswerBytes = 128 * 1024

  public static func build(
    offerSDP: String,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration
  ) throws -> RealtimeCallsRequestSpec {
    try buildForTesting(
      offerSDP: offerSDP,
      route: route,
      configuration: configuration,
      boundary: "Enchiridion-\(UUID().uuidString)"
    )
  }

  static func buildForTesting(
    offerSDP: String,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    boundary: String
  ) throws -> RealtimeCallsRequestSpec {
    guard route.isAuthorizedOpenAIRealtime else {
      throw RealtimeCallsRequestSpecError.unauthorizedRoute
    }
    guard !offerSDP.isEmpty, offerSDP.utf8.count <= maximumOfferBytes else {
      throw RealtimeCallsRequestSpecError.invalidOffer
    }
    guard isValidBoundary(boundary) else { throw RealtimeCallsRequestSpecError.invalidBoundary }
    do {
      try configuration.validateActual(
        modelID: route.modelID ?? "",
        voiceID: route.voiceID ?? ""
      )
    } catch {
      throw RealtimeCallsRequestSpecError.invalidSession
    }
    let session = try sessionJSON(configuration)
    guard session.count <= maximumSessionBytes else {
      throw RealtimeCallsRequestSpecError.invalidSession
    }
    let delimiter = Data("\r\n--\(boundary)".utf8)
    guard
      Data(offerSDP.utf8).range(of: delimiter) == nil,
      session.range(of: delimiter) == nil
    else { throw RealtimeCallsRequestSpecError.invalidBoundary }
    return RealtimeCallsRequestSpec(
      endpoint: endpoint,
      method: "POST",
      contentType: "multipart/form-data; boundary=\(boundary)",
      cacheControl: "no-store",
      body: multipartBody(
        boundary: boundary,
        offerSDP: Data(offerSDP.utf8),
        sessionJSON: session
      )
    )
  }

  public static func sessionJSON(_ configuration: RealtimeVoiceConfiguration) throws -> Data {
    let object: [String: Any] = [
      "type": "realtime",
      "model": configuration.modelID,
      "instructions": configuration.instructions,
      "output_modalities": configuration.outputModalities,
      "audio": [
        "input": [
          "transcription": ["model": configuration.inputAudioTranscriptionModelID],
          "turn_detection": [
            "type": configuration.turnDetection.type,
            "eagerness": configuration.turnDetection.eagerness,
            "create_response": configuration.turnDetection.createResponse,
            "interrupt_response": configuration.turnDetection.interruptResponse,
          ] as [String: Any],
        ] as [String: Any],
        "output": ["voice": configuration.voiceID],
      ] as [String: Any],
      "max_output_tokens": configuration.maxOutputTokens,
      "tracing": NSNull(),
      "tools": configuration.tools,
      "tool_choice": configuration.toolChoice,
    ]
    guard JSONSerialization.isValidJSONObject(object) else {
      throw RealtimeCallsRequestSpecError.invalidSession
    }
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  public static func acceptsEndpoint(_ candidate: URL) -> Bool {
    candidate.scheme == endpoint.scheme
      && candidate.host == endpoint.host
      && candidate.port == nil
      && candidate.path == endpoint.path
      && candidate.query == nil
      && candidate.fragment == nil
      && candidate.user == nil
      && candidate.password == nil
  }

  public static func acceptsRedirect(from: URL, to: URL) -> Bool {
    false
  }

  public static func ephemeralConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.urlCredentialStorage = nil
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 30
    configuration.waitsForConnectivity = false
    return configuration
  }

  public static func validateAnswer(_ data: Data) throws -> String {
    guard
      !data.isEmpty,
      data.count <= maximumAnswerBytes,
      let answer = String(data: data, encoding: .utf8),
      !answer.isEmpty
    else {
      throw RealtimeCallsRequestSpecError.invalidAnswer
    }
    return answer
  }

  private static func isValidBoundary(_ boundary: String) -> Bool {
    !boundary.isEmpty
      && boundary.utf8.count <= 70
      && boundary.unicodeScalars.allSatisfy {
        (65...90).contains($0.value)
          || (97...122).contains($0.value)
          || (48...57).contains($0.value)
          || $0.value == 45
      }
  }

  private static func multipartBody(boundary: String, offerSDP: Data, sessionJSON: Data) -> Data {
    var body = Data()
    func append(_ string: String) { body.append(Data(string.utf8)) }
    append("--\(boundary)\r\n")
    append("Content-Disposition: form-data; name=\"sdp\"\r\n")
    append("Content-Type: application/sdp\r\n\r\n")
    body.append(offerSDP)
    append("\r\n--\(boundary)\r\n")
    append("Content-Disposition: form-data; name=\"session\"\r\n")
    append("Content-Type: application/json\r\n\r\n")
    body.append(sessionJSON)
    append("\r\n--\(boundary)--\r\n")
    return body
  }
}
