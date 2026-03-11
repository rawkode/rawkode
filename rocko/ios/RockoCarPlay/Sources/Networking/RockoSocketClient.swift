import Foundation

enum SocketConnectionState: Equatable {
  case disconnected
  case connecting
  case connected
}

struct ClientEnvelope: Encodable {
  let type: String
  let sessionId: String?
  let threadId: String?
  let resourceId: String?
  let agentHint: String?

  static func sessionStart(sessionId: String, threadId: String, resourceId: String, agentHint: String?) -> ClientEnvelope {
    ClientEnvelope(
      type: "session.start",
      sessionId: sessionId,
      threadId: threadId,
      resourceId: resourceId,
      agentHint: agentHint
    )
  }

  static func agentHint(_ agentKey: String) -> ClientEnvelope {
    ClientEnvelope(type: "agent.hint", sessionId: nil, threadId: nil, resourceId: nil, agentHint: agentKey)
  }

  static let sessionInterrupt = ClientEnvelope(type: "session.interrupt", sessionId: nil, threadId: nil, resourceId: nil, agentHint: nil)
  static let sessionEnd = ClientEnvelope(type: "session.end", sessionId: nil, threadId: nil, resourceId: nil, agentHint: nil)
}

final class RockoSocketClient: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
  var onStateChange: ((SocketConnectionState) -> Void)?
  var onEvent: ((ServerEvent) -> Void)?
  var onBinaryMessage: ((Data) -> Void)?
  var onTransportError: ((String) -> Void)?

  private let url: URL
  private let authToken: String?
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private var urlSession: URLSession?
  private var task: URLSessionWebSocketTask?

  init(url: URL, authToken: String?) {
    self.url = url
    self.authToken = authToken
    super.init()
  }

  func connect() {
    guard task == nil else { return }

    onStateChange?(.connecting)

    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: url)

    if let authToken, !authToken.isEmpty {
      request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    }

    let task = session.webSocketTask(with: request)

    self.urlSession = session
    self.task = task

    task.resume()
  }

  func disconnect() {
    guard let task else {
      onStateChange?(.disconnected)
      return
    }

    task.cancel(with: .goingAway, reason: nil)
    self.task = nil
    self.urlSession = nil
    onStateChange?(.disconnected)
  }

  func send(_ envelope: ClientEnvelope) {
    guard let task else { return }

    do {
      let payload = try encoder.encode(envelope)
      let text = String(decoding: payload, as: UTF8.self)
      task.send(.string(text)) { [weak self] error in
        guard let error else { return }
        self?.onTransportError?(error.localizedDescription)
      }
    } catch {
      onTransportError?(error.localizedDescription)
    }
  }

  func sendBinary(_ payload: Data) {
    guard let task else { return }

    task.send(.data(payload)) { [weak self] error in
      guard let error else { return }
      self?.onTransportError?(error.localizedDescription)
    }
  }

  // MARK: - URLSessionWebSocketDelegate

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    onStateChange?(.connected)
    receiveNextMessage()
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    task = nil
    urlSession = nil
    onStateChange?(.disconnected)
  }

  // MARK: - URLSessionTaskDelegate

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: (any Error)?
  ) {
    guard let error else { return }
    self.task = nil
    self.urlSession = nil
    onTransportError?(error.localizedDescription)
    onStateChange?(.disconnected)
  }

  // MARK: - Private

  private func receiveNextMessage() {
    guard let task else { return }

    task.receive { [weak self] result in
      guard let self else { return }

      switch result {
      case let .success(message):
        switch message {
        case let .string(text):
          self.decodeEvent(from: text)
        case let .data(data):
          self.onBinaryMessage?(data)
        @unknown default:
          self.onTransportError?("Unsupported websocket message type.")
        }

        self.receiveNextMessage()

      case let .failure(error):
        self.onTransportError?(error.localizedDescription)
        self.disconnect()
      }
    }
  }

  private func decodeEvent(from text: String) {
    let data = Data(text.utf8)

    do {
      let event = try decoder.decode(ServerEvent.self, from: data)
      onEvent?(event)
    } catch {
      onTransportError?("Failed to decode server event: \(error.localizedDescription)")
    }
  }
}
