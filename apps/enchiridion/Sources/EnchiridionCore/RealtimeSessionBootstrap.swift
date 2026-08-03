import Foundation

public enum RealtimeSessionBootstrapError: Error, Equatable, Sendable {
  case invalidEndpoint
  case redirectBlocked
  case invalidHTTPResponse
  case responseTooLarge
  case rejected(statusCode: Int, requestID: String?)
  case invalidAnswer
  case connectionFailed
}

public struct RealtimeSessionBootstrapResult: Equatable, Sendable {
  public let answerSDP: String
  public let requestID: String?

  public init(answerSDP: String, requestID: String?) {
    self.answerSDP = answerSDP
    self.requestID = requestID
  }
}

/// Produces an answer SDP for the frozen native Realtime BYOK route.
public protocol RealtimeSessionBootstrap: Sendable {
  func bootstrap(
    offerSDP: String,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws -> RealtimeSessionBootstrapResult
}

public struct RealtimeCallsHTTPExchange: Sendable {
  public let finalURL: URL
  public let statusCode: Int
  public let headers: [String: String]
  public let body: Data

  public init(finalURL: URL, statusCode: Int, headers: [String: String], body: Data) {
    self.finalURL = finalURL
    self.statusCode = statusCode
    self.headers = headers
    self.body = body
  }

  public func header(_ name: String) -> String? {
    headers[name.lowercased()]
  }
}

public protocol RealtimeCallsHTTPLoading: Sendable {
  func load(_ request: URLRequest) async throws -> RealtimeCallsHTTPExchange
}

/// Native-only HTTP loader. The shared redirect-rejecting delegate prevents a
/// request that carries the Platform key from following a redirect.
public actor URLSessionRealtimeCallsHTTPLoader: RealtimeCallsHTTPLoading {
  private let session: URLSession

  public init(
    configuration: URLSessionConfiguration = RealtimeCallsRequestSpecBuilder.ephemeralConfiguration()
  ) {
    session = URLSession(
      configuration: configuration,
      delegate: OpenAIResponsesSessionDelegate(),
      delegateQueue: nil
    )
  }

  deinit {
    session.invalidateAndCancel()
  }

  public func load(_ request: URLRequest) async throws -> RealtimeCallsHTTPExchange {
    guard let requestURL = request.url,
      RealtimeCallsRequestSpecBuilder.acceptsEndpoint(requestURL)
    else {
      throw RealtimeSessionBootstrapError.invalidEndpoint
    }

    let (bytes, response) = try await session.bytes(for: request)
    try Task.checkCancellation()
    guard let http = response as? HTTPURLResponse, let finalURL = http.url else {
      throw RealtimeSessionBootstrapError.invalidHTTPResponse
    }
    guard RealtimeCallsRequestSpecBuilder.acceptsEndpoint(finalURL) else {
      throw RealtimeSessionBootstrapError.redirectBlocked
    }

    let maximumBytes = (200..<300).contains(http.statusCode)
      ? RealtimeCallsRequestSpecBuilder.maximumAnswerBytes
      : 32 * 1024
    var body = Data()
    body.reserveCapacity(min(maximumBytes, 8 * 1024))
    for try await byte in bytes {
      try Task.checkCancellation()
      guard body.count < maximumBytes else {
        throw RealtimeSessionBootstrapError.responseTooLarge
      }
      body.append(byte)
    }

    var headers: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      headers[String(describing: key).lowercased()] = String(describing: value)
    }
    return RealtimeCallsHTTPExchange(
      finalURL: finalURL,
      statusCode: http.statusCode,
      headers: headers,
      body: body
    )
  }
}

/// Uses the verified Platform key only while constructing a native
/// Authorization header for the pinned OpenAI Realtime endpoint.
public actor DirectBYOKBootstrap: RealtimeSessionBootstrap {
  private let loader: any RealtimeCallsHTTPLoading

  public init(
    loader: any RealtimeCallsHTTPLoading = URLSessionRealtimeCallsHTTPLoader()
  ) {
    self.loader = loader
  }

  public func bootstrap(
    offerSDP: String,
    route: RealtimeVoiceRouteSnapshot,
    configuration: RealtimeVoiceConfiguration,
    credential: RealtimeCredentialLease
  ) async throws -> RealtimeSessionBootstrapResult {
    guard credential.binding == route.credentialBinding else {
      throw RealtimeSessionBootstrapError.invalidEndpoint
    }

    let spec = try RealtimeCallsRequestSpecBuilder.build(
      offerSDP: offerSDP,
      route: route,
      configuration: configuration
    )
    var request = URLRequest(url: spec.endpoint)
    request.httpMethod = spec.method
    request.httpBody = spec.body
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.timeoutInterval = 30
    request.setValue(spec.contentType, forHTTPHeaderField: "Content-Type")
    request.setValue(spec.cacheControl, forHTTPHeaderField: "Cache-Control")
    request.setValue("application/sdp", forHTTPHeaderField: "Accept")
    credential.withSecret { secret in
      request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization")
    }

    let exchange: RealtimeCallsHTTPExchange
    do {
      exchange = try await loader.load(request)
    } catch let error as RealtimeSessionBootstrapError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw RealtimeSessionBootstrapError.connectionFailed
    }
    try Task.checkCancellation()
    guard RealtimeCallsRequestSpecBuilder.acceptsEndpoint(exchange.finalURL) else {
      throw RealtimeSessionBootstrapError.redirectBlocked
    }
    let requestID = Self.sanitizedRequestID(exchange.header("x-request-id"))
    guard (200..<300).contains(exchange.statusCode) else {
      throw RealtimeSessionBootstrapError.rejected(
        statusCode: exchange.statusCode,
        requestID: requestID
      )
    }
    do {
      return RealtimeSessionBootstrapResult(
        answerSDP: try RealtimeCallsRequestSpecBuilder.validateAnswer(exchange.body),
        requestID: requestID
      )
    } catch {
      throw RealtimeSessionBootstrapError.invalidAnswer
    }
  }

  private static func sanitizedRequestID(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.utf8.count <= 256,
      value.unicodeScalars.allSatisfy({ scalar in
        (48...57).contains(scalar.value)
          || (65...90).contains(scalar.value)
          || (97...122).contains(scalar.value)
          || "-_.".unicodeScalars.contains(scalar)
      })
    else { return nil }
    return value
  }
}
