import Foundation

enum OpenAIJSONValue: Codable, Equatable, Sendable {
  case object([String: OpenAIJSONValue])
  case array([OpenAIJSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([OpenAIJSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: OpenAIJSONValue].self))
    }
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  var objectValue: [String: OpenAIJSONValue]? {
    guard case .object(let value) = self else { return nil }
    return value
  }

  var arrayValue: [OpenAIJSONValue]? {
    guard case .array(let value) = self else { return nil }
    return value
  }

  var stringValue: String? {
    guard case .string(let value) = self else { return nil }
    return value
  }

  var integerValue: Int? {
    guard case .number(let value) = self, value.isFinite,
      value >= Double(Int.min), value <= Double(Int.max)
    else { return nil }
    return Int(value)
  }
}

enum OpenAIResponsesSSEError: Error, Equatable {
  case eventTooLarge
  case streamTooLarge
  case incompleteRecord
}

/// A record-oriented SSE parser. It accepts arbitrary byte fragmentation,
/// joins multiline `data:` fields, ignores comments and unknown fields, and
/// enforces hard per-event and whole-stream ceilings.
struct OpenAIResponsesSSEParser: Sendable {
  static let maximumEventBytes = 256 * 1_024
  static let maximumStreamBytes = 4 * 1_024 * 1_024

  private var lineBuffer: [UInt8] = []
  private var dataLines: [String] = []
  private var eventBytes = 0
  private var streamBytes = 0

  mutating func feed(_ bytes: some Sequence<UInt8>) throws -> [Data] {
    var records: [Data] = []
    for byte in bytes {
      streamBytes += 1
      guard streamBytes <= Self.maximumStreamBytes else {
        throw OpenAIResponsesSSEError.streamTooLarge
      }
      if byte == 0x0A {
        records.append(contentsOf: try consumeLine())
      } else {
        lineBuffer.append(byte)
        guard lineBuffer.count <= Self.maximumEventBytes else {
          throw OpenAIResponsesSSEError.eventTooLarge
        }
      }
    }
    return records
  }

  mutating func finish() throws -> [Data] {
    var records: [Data] = []
    if !lineBuffer.isEmpty { records.append(contentsOf: try consumeLine()) }
    if !dataLines.isEmpty {
      records.append(try dispatch())
    }
    return records
  }

  private mutating func consumeLine() throws -> [Data] {
    if lineBuffer.last == 0x0D { lineBuffer.removeLast() }
    let bytes = lineBuffer
    lineBuffer.removeAll(keepingCapacity: true)
    eventBytes += bytes.count + 1
    guard eventBytes <= Self.maximumEventBytes else {
      throw OpenAIResponsesSSEError.eventTooLarge
    }
    guard !bytes.isEmpty else {
      guard !dataLines.isEmpty else {
        eventBytes = 0
        return []
      }
      return [try dispatch()]
    }
    guard let line = String(bytes: bytes, encoding: .utf8) else {
      throw OpenAIResponsesSSEError.incompleteRecord
    }
    if line.hasPrefix(":") { return [] }
    guard line == "data" || line.hasPrefix("data:") else { return [] }
    var value = line == "data" ? "" : String(line.dropFirst(5))
    if value.first == " " { value.removeFirst() }
    dataLines.append(value)
    return []
  }

  private mutating func dispatch() throws -> Data {
    let value = dataLines.joined(separator: "\n")
    dataLines.removeAll(keepingCapacity: true)
    eventBytes = 0
    guard let data = value.data(using: .utf8) else {
      throw OpenAIResponsesSSEError.incompleteRecord
    }
    return data
  }
}

struct OpenAIResponsesTransportResult: Sendable {
  var statusCode: Int
  var requestID: String?
  var retryAfterSeconds: Int?
  var events: [Data]
  var errorCode: String?
}

protocol OpenAIResponsesTransporting: Sendable {
  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult
}

enum OpenAIResponsesTransportError: Error, Equatable {
  case invalidEndpoint
  case invalidHTTPResponse
  case invalidContentType
  case responseTooLarge
  case redirectBlocked
}

struct OpenAIResponsesHTTPExchange: Sendable {
  let finalURL: URL
  let statusCode: Int
  let headers: [String: String]
  let chunks: [Data]

  func header(_ name: String) -> String? {
    headers[name.lowercased()]
  }
}

protocol OpenAIResponsesHTTPLoading: Sendable {
  func load(_ request: URLRequest) async throws -> OpenAIResponsesHTTPExchange
}

enum OpenAIResponsesURLSessionPolicy {
  static func makeConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.waitsForConnectivity = false
    return configuration
  }
}

actor URLSessionOpenAIResponsesHTTPLoader: OpenAIResponsesHTTPLoading {
  private let session: URLSession

  init(
    configuration: URLSessionConfiguration = OpenAIResponsesURLSessionPolicy.makeConfiguration(),
    delegate: URLSessionTaskDelegate = OpenAIResponsesSessionDelegate()
  ) {
    session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
  }

  deinit {
    session.invalidateAndCancel()
  }

  func load(_ request: URLRequest) async throws -> OpenAIResponsesHTTPExchange {
    let (bytes, response) = try await session.bytes(for: request)
    try Task.checkCancellation()
    guard let http = response as? HTTPURLResponse, let finalURL = http.url else {
      throw OpenAIResponsesTransportError.invalidHTTPResponse
    }

    let maximumBytes =
      (200..<300).contains(http.statusCode)
      ? OpenAIResponsesSSEParser.maximumStreamBytes
      : NativeOpenAIResponsesTransport.maximumErrorBodyBytes
    var chunks: [Data] = []
    var chunk = Data()
    chunk.reserveCapacity(8 * 1_024)
    var byteCount = 0
    for try await byte in bytes {
      try Task.checkCancellation()
      byteCount += 1
      guard byteCount <= maximumBytes else {
        throw OpenAIResponsesTransportError.responseTooLarge
      }
      chunk.append(byte)
      if chunk.count == 8 * 1_024 {
        chunks.append(chunk)
        chunk = Data()
        chunk.reserveCapacity(8 * 1_024)
      }
    }
    if !chunk.isEmpty { chunks.append(chunk) }

    var headers: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      headers[String(describing: key).lowercased()] = String(describing: value)
    }
    return OpenAIResponsesHTTPExchange(
      finalURL: finalURL,
      statusCode: http.statusCode,
      headers: headers,
      chunks: chunks
    )
  }
}

actor NativeOpenAIResponsesTransport: OpenAIResponsesTransporting {
  static let endpoint = URL(string: "https://api.openai.com/v1/responses")!
  static let maximumErrorBodyBytes = 32 * 1_024

  private let loader: any OpenAIResponsesHTTPLoading

  init(loader: any OpenAIResponsesHTTPLoading = URLSessionOpenAIResponsesHTTPLoader()) {
    self.loader = loader
  }

  func send(body: Data, credential: String) async throws -> OpenAIResponsesTransportResult {
    var request = URLRequest(url: Self.endpoint)
    request.httpMethod = "POST"
    request.httpBody = body
    request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    request.timeoutInterval = 90
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")

    let exchange = try await loader.load(request)
    try Task.checkCancellation()
    guard exchange.finalURL == Self.endpoint else {
      throw OpenAIResponsesTransportError.redirectBlocked
    }
    let requestID = exchange.header("x-request-id")
    let retryAfter = Self.retryAfter(exchange.header("retry-after"))

    guard (200..<300).contains(exchange.statusCode) else {
      let data = exchange.chunks.reduce(into: Data()) { $0.append($1) }
      guard data.count <= Self.maximumErrorBodyBytes else {
        throw OpenAIResponsesTransportError.responseTooLarge
      }
      return OpenAIResponsesTransportResult(
        statusCode: exchange.statusCode,
        requestID: requestID,
        retryAfterSeconds: retryAfter,
        events: [],
        errorCode: Self.errorCode(from: data)
      )
    }

    guard exchange.header("content-type")?.lowercased().contains("text/event-stream") == true
    else { throw OpenAIResponsesTransportError.invalidContentType }

    var parser = OpenAIResponsesSSEParser()
    var events: [Data] = []
    for chunk in exchange.chunks {
      try Task.checkCancellation()
      events.append(contentsOf: try parser.feed(chunk))
    }
    events.append(contentsOf: try parser.finish())
    return OpenAIResponsesTransportResult(
      statusCode: exchange.statusCode,
      requestID: requestID,
      retryAfterSeconds: retryAfter,
      events: events,
      errorCode: nil
    )
  }

  private static func retryAfter(_ value: String?) -> Int? {
    guard let value else { return nil }
    if let seconds = Int(value), seconds >= 0 { return seconds }
    guard let date = HTTPDateFormatter.shared.date(from: value) else { return nil }
    return max(0, Int(date.timeIntervalSinceNow.rounded(.up)))
  }

  private static func errorCode(from data: Data) -> String? {
    guard data.count <= maximumErrorBodyBytes,
      let root = try? JSONDecoder().decode(OpenAIJSONValue.self, from: data),
      let error = root.objectValue?["error"]?.objectValue,
      let candidate = error["code"]?.stringValue ?? error["type"]?.stringValue,
      candidate.utf8.count <= 128,
      !candidate.isEmpty,
      candidate.unicodeScalars.allSatisfy({
        CharacterSet.alphanumerics.contains($0)
          || CharacterSet(charactersIn: "-_.").contains($0)
      })
    else { return nil }
    return candidate
  }
}
final class OpenAIResponsesSessionDelegate: NSObject, URLSessionTaskDelegate,
  @unchecked Sendable
{
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
      completionHandler(.performDefaultHandling, nil)
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }
}

private final class HTTPDateFormatter: @unchecked Sendable {
  static let shared = HTTPDateFormatter()
  private let lock = NSLock()
  private let formatter: DateFormatter

  private init() {
    formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
  }

  func date(from value: String) -> Date? {
    lock.withLock { formatter.date(from: value) }
  }
}
