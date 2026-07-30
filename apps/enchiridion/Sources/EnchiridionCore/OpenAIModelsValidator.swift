import Foundation

public struct OpenAIModelsHTTPResponse: Sendable {
  public let data: Data
  public let statusCode: Int
  public let headers: [String: String]

  public init(data: Data, statusCode: Int, headers: [String: String] = [:]) {
    self.data = data
    self.statusCode = statusCode
    self.headers = headers
  }
}

public protocol OpenAIModelsTransport: Sendable {
  func send(_ request: URLRequest) async throws -> OpenAIModelsHTTPResponse
}

public enum OpenAIValidationError: Error, Equatable, Sendable {
  case invalidCredential(requestID: String?)
  case forbidden(requestID: String?)
  case rateLimited(retryAfterSeconds: Int?, requestID: String?)
  case redirectBlocked
  case networkUnavailable
  case timedOut
  case invalidResponse(requestID: String?)
  case serviceUnavailable(requestID: String?)
  case transportFailure
}

public struct OpenAIValidationResult: Equatable, Sendable {
  public let capabilities: OpenAIVerifiedCapabilities
  public let requestID: String?

  public init(capabilities: OpenAIVerifiedCapabilities, requestID: String?) {
    self.capabilities = capabilities
    self.requestID = requestID
  }
}

public struct OpenAIModelsValidator: Sendable {
  public static let modelsURL = URL(string: "https://api.openai.com/v1/models")!

  private let transport: any OpenAIModelsTransport
  private let now: @Sendable () -> Date

  public init(
    transport: any OpenAIModelsTransport = OpenAIModelsURLSessionTransport(),
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    self.transport = transport
    self.now = now
  }

  public func validate(credential: String) async throws -> OpenAIValidationResult {
    let request = Self.request(credential: credential)
    let response: OpenAIModelsHTTPResponse
    do {
      response = try await transport.send(request)
    } catch let error as URLError {
      switch error.code {
      case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
        .cannotConnectToHost, .dnsLookupFailed:
        throw OpenAIValidationError.networkUnavailable
      case .timedOut:
        throw OpenAIValidationError.timedOut
      case .cancelled:
        throw CancellationError()
      default:
        throw OpenAIValidationError.transportFailure
      }
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw OpenAIValidationError.transportFailure
    }

    let requestID = response.headers.first { key, _ in
      key.caseInsensitiveCompare("x-request-id") == .orderedSame
    }?.value

    switch response.statusCode {
    case 200:
      let availableIDs = try decodeModelIDs(from: response.data, requestID: requestID)
      return OpenAIValidationResult(
        capabilities: OpenAIModelCatalog.intersect(availableModelIDs: availableIDs),
        requestID: requestID
      )
    case 300..<400:
      throw OpenAIValidationError.redirectBlocked
    case 401:
      throw OpenAIValidationError.invalidCredential(requestID: requestID)
    case 403:
      throw OpenAIValidationError.forbidden(requestID: requestID)
    case 429:
      throw OpenAIValidationError.rateLimited(
        retryAfterSeconds: retryAfterSeconds(response.headers),
        requestID: requestID
      )
    default:
      throw OpenAIValidationError.serviceUnavailable(requestID: requestID)
    }
  }

  static func request(credential: String) -> URLRequest {
    var request = URLRequest(
      url: modelsURL,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 20
    )
    request.httpMethod = "GET"
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
    return request
  }

  private func decodeModelIDs(from data: Data, requestID: String?) throws -> Set<String> {
    struct Response: Decodable {
      struct Model: Decodable { let id: String }
      let data: [Model]
    }

    guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
      throw OpenAIValidationError.invalidResponse(requestID: requestID)
    }
    guard response.data.allSatisfy({ !$0.id.isEmpty }) else {
      throw OpenAIValidationError.invalidResponse(requestID: requestID)
    }
    return Set(response.data.map(\.id))
  }

  private func retryAfterSeconds(_ headers: [String: String]) -> Int? {
    guard
      let value = headers.first(where: { key, _ in
        key.caseInsensitiveCompare("retry-after") == .orderedSame
      })?.value
    else { return nil }

    if let seconds = Int(value), seconds >= 0 { return min(seconds, 86_400) }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
    guard let date = formatter.date(from: value) else { return nil }
    return min(max(Int(date.timeIntervalSince(now()).rounded(.up)), 0), 86_400)
  }
}

public final class OpenAIModelsURLSessionTransport: NSObject, OpenAIModelsTransport,
  URLSessionTaskDelegate, @unchecked Sendable
{
  private lazy var session = URLSession(
    configuration: Self.restrictedConfiguration(),
    delegate: self,
    delegateQueue: nil
  )

  public override init() {}

  public func send(_ request: URLRequest) async throws -> OpenAIModelsHTTPResponse {
    guard request.url == OpenAIModelsValidator.modelsURL,
      request.httpMethod == "GET",
      request.url?.scheme == "https",
      request.url?.host == "api.openai.com"
    else {
      throw OpenAIValidationError.redirectBlocked
    }

    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw OpenAIValidationError.invalidResponse(requestID: nil)
    }
    let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, pair in
      guard let key = pair.key as? String, let value = pair.value as? String else { return }
      result[key] = value
    }
    return OpenAIModelsHTTPResponse(
      data: data,
      statusCode: response.statusCode,
      headers: headers
    )
  }

  public static func restrictedConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.waitsForConnectivity = false
    return configuration
  }

  public func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
