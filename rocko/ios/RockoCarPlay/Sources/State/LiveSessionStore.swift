import Foundation
import SwiftUI

enum LiveSessionPhase: String, Codable {
  case idle
  case connecting
  case listening
  case thinking
  case speaking
  case followUpWindow = "followup_window"
  case error

  var displayName: String {
    switch self {
    case .idle:
      return "Idle"
    case .connecting:
      return "Connecting"
    case .listening:
      return "Listening"
    case .thinking:
      return "Thinking"
    case .speaking:
      return "Speaking"
    case .followUpWindow:
      return "Follow-up Window"
    case .error:
      return "Error"
    }
  }
}

struct AgentCatalogEntry: Decodable {
  let agentKey: String
  let displayName: String
  let spokenSummary: String
  let allowedWhileDriving: Bool
}

struct ServerEvent: Decodable {
  let type: String
  let state: String?
  let text: String?
  let agentId: String?
  let agentName: String?
  let message: String?
  let code: String?
  let phase: String?
  let tool: String?
  let agentKey: String?
  let displayName: String?
  let detail: String?
  let sessionId: String?
  let resourceId: String?
  let threadId: String?
  let activeAgent: String?
  let agents: [AgentCatalogEntry]?
  let isFinal: Bool?

  enum CodingKeys: String, CodingKey {
    case type, state, text, agentId, agentName, message, code
    case phase, tool, agentKey, displayName, detail
    case sessionId, resourceId, threadId, activeAgent, agents
    case isFinal = "final"
  }
}

struct ConversationMessage: Identifiable, Equatable {
  enum Channel: String, Equatable {
    case text
    case liveVoice
    case system
  }

  enum Role: String {
    case user
    case assistant
    case system
  }

  enum Status: Equatable {
    case streaming
    case final
  }

  let id: UUID
  let role: Role
  let channel: Channel
  var text: String
  var status: Status
  var agentName: String?
  let createdAt: Date

  init(
    id: UUID = UUID(),
    role: Role,
    channel: Channel = .text,
    text: String,
    status: Status = .final,
    agentName: String? = nil,
    createdAt: Date = .now
  ) {
    self.id = id
    self.role = role
    self.channel = channel
    self.text = text
    self.status = status
    self.agentName = agentName
    self.createdAt = createdAt
  }

  var isStreaming: Bool {
    status == .streaming
  }
}

struct TextAgentCatalogEntry: Identifiable, Equatable {
  let id: String
  let name: String
  let description: String?
}

struct TextConversationThread: Identifiable, Equatable {
  let id: String
  var agent: TextAgentCatalogEntry
  var messages: [ConversationMessage]
  let threadID: String
  let resourceID: String
  var updatedAt: Date
  var isAwaitingResponse: Bool

  init(
    agent: TextAgentCatalogEntry,
    messages: [ConversationMessage] = [],
    threadID: String = "rocko-text-thread-\(UUID().uuidString)",
    resourceID: String? = nil,
    updatedAt: Date = .distantPast,
    isAwaitingResponse: Bool = false
  ) {
    self.id = agent.id
    self.agent = agent
    self.messages = messages
    self.threadID = threadID
    self.resourceID = resourceID ?? "rocko-text-resource-\(agent.id)"
    self.updatedAt = updatedAt
    self.isAwaitingResponse = isAwaitingResponse
  }

  var lastMessage: ConversationMessage? {
    messages.last
  }

  var lastActivityAt: Date? {
    lastMessage?.createdAt
  }

  var previewText: String {
    if isAwaitingResponse {
      return "\(agent.name) is replying…"
    }

    guard let lastMessage else {
      return agent.description ?? "Start a conversation"
    }

    let prefix = lastMessage.role == .user ? "You: " : ""
    let normalized = lastMessage.text.replacingOccurrences(of: "\n", with: " ")
    return prefix + normalized
  }

  var hasMessages: Bool {
    !messages.isEmpty
  }
}

private struct RemoteAgentSummary: Decodable {
  let name: String
  let description: String?
}

private struct AgentGenerateMemoryOptions: Encodable {
  let thread: String
  let resource: String
}

private struct AgentGenerateRequest: Encodable {
  let messages: String
  let memory: AgentGenerateMemoryOptions
}

private struct AgentGenerateResponse: Decodable {
  let text: String?
}

private struct RockoAPIErrorResponse: Decodable {
  let error: String?
  let message: String?
}

final class LiveSessionStore: ObservableObject {
  static let shared = LiveSessionStore()

  @Published private(set) var connectionState: SocketConnectionState = .disconnected
  @Published private(set) var phase: LiveSessionPhase = .idle
  @Published private(set) var activeAgentName = "Auto"
  @Published private(set) var lastUserUtterance = "Awaiting driver input"
  @Published private(set) var lastAssistantUtterance = "Ready when you are"
  @Published private(set) var errorMessage: String?
  @Published private(set) var isSessionOpen = false
  @Published private(set) var activeToolStatus: String?
  @Published private(set) var availableAgents: [AgentCatalogEntry] = []
  @Published private(set) var selectedAgentKey: String?
  @Published private(set) var availableTextAgents: [TextAgentCatalogEntry] = []
  @Published private(set) var selectedTextAgentID: String? = RockoConfiguration.defaultTextAgentID
  @Published private(set) var isLoadingTextAgents = false
  @Published private(set) var sendingTextAgentID: String?
  @Published private(set) var textThreads: [TextConversationThread] = []
  @Published private(set) var liveVoiceMessages: [ConversationMessage] = []

  private let socketClient: RockoSocketClient
  private let audioCapture = AudioCaptureEngine()
  private let audioPlayback = AudioPlaybackEngine()
  private var sessionId = UUID().uuidString
  private var lastAgentHint: String?
  private var pendingSessionStart = false
  private var followUpTimer: Task<Void, Never>?
  private var reconnectAttempt = 0
  private var reconnectTask: Task<Void, Never>?
  private var currentUserMessageID: UUID?
  private var currentAssistantMessageID: UUID?
  private static let maxReconnectAttempts = 5
  private static let baseReconnectDelay: TimeInterval = 1.0

  private init() {
    socketClient = RockoSocketClient(
      url: RockoConfiguration.webSocketURL,
      authToken: RockoConfiguration.authToken
    )

    socketClient.onStateChange = { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        self.connectionState = state
        if state == .disconnected {
          if self.isSessionOpen {
            self.scheduleReconnect()
          } else if self.phase != .error {
            self.phase = .idle
          }
        } else if state == .connected {
          self.reconnectAttempt = 0
          self.reconnectTask?.cancel()
          if self.pendingSessionStart {
            self.pendingSessionStart = false
            self.sendSessionStart()
          }
        }
      }
    }

    socketClient.onEvent = { [weak self] event in
      Task { @MainActor in
        self?.handle(event: event)
      }
    }

    socketClient.onBinaryMessage = { [weak self] data in
      Task { @MainActor in
        self?.followUpTimer?.cancel()
        self?.phase = .speaking
        self?.audioPlayback.enqueuePCM16Mono(data)
      }
    }

    socketClient.onTransportError = { [weak self] message in
      Task { @MainActor in
        self?.errorMessage = message
        self?.phase = .error
        self?.finalizeDraftMessages()
      }
    }

    audioCapture.onPCMChunk = { [weak self] chunk in
      self?.socketClient.sendBinary(chunk)
    }

    audioCapture.onInterruption = { [weak self] began in
      Task { @MainActor in
        if began {
          self?.phase = .idle
        }
      }
    }

    audioPlayback.onPlaybackDrained = { [weak self] in
      Task { @MainActor in
        self?.enterFollowUpWindow()
      }
    }
  }

  func startSession(agentHint: String? = nil) {
    sessionId = UUID().uuidString
    lastAgentHint = agentHint ?? selectedAgentKey
    errorMessage = nil
    activeToolStatus = nil
    finalizeDraftMessages()
    followUpTimer?.cancel()
    reconnectTask?.cancel()
    reconnectAttempt = 0

    do {
      try audioCapture.start()
      isSessionOpen = true
      phase = .listening
    } catch {
      errorMessage = error.localizedDescription
      phase = .error
      return
    }

    if connectionState == .connected {
      sendSessionStart()
    } else {
      pendingSessionStart = true
      if connectionState == .disconnected {
        socketClient.connect()
      }
    }
  }

  private func sendSessionStart() {
    let threadId = "rocko-thread-\(sessionId)"
    let resourceId = "rocko-live"
    socketClient.send(.sessionStart(sessionId: sessionId, threadId: threadId, resourceId: resourceId, agentHint: lastAgentHint))
  }

  func stopSession() {
    pendingSessionStart = false
    followUpTimer?.cancel()
    followUpTimer = nil
    reconnectTask?.cancel()
    reconnectTask = nil
    reconnectAttempt = 0
    audioCapture.stop()
    audioPlayback.stop()
    socketClient.send(.sessionEnd)
    isSessionOpen = false
    phase = .idle
    activeToolStatus = nil
    finalizeDraftMessages()
  }

  func reconnect() {
    followUpTimer?.cancel()
    reconnectTask?.cancel()
    reconnectAttempt = 0
    audioCapture.stop()
    audioPlayback.stop()
    socketClient.disconnect()
    phase = .connecting
    finalizeDraftMessages()
    socketClient.connect()
  }

  func interruptAssistant() {
    socketClient.send(.sessionInterrupt)
    finalizeDraftMessages()
    phase = .listening
  }

  func selectAgent(_ agentKey: String) {
    selectedAgentKey = agentKey
    lastAgentHint = agentKey
    if let agent = availableAgents.first(where: { $0.agentKey == agentKey }) {
      activeAgentName = agent.displayName
    }
    socketClient.send(.agentHint(agentKey))
  }

  @MainActor
  func loadTextAgentsIfNeeded() async {
    guard availableTextAgents.isEmpty || textThreads.isEmpty else { return }
    await refreshTextAgents()
  }

  @MainActor
  func refreshTextAgents() async {
    guard !isLoadingTextAgents else { return }

    isLoadingTextAgents = true
    defer { isLoadingTextAgents = false }

    do {
      var request = URLRequest(url: RockoConfiguration.agentsURL)
      request.httpMethod = "GET"
      applyAuthorization(to: &request)

      let (data, response) = try await URLSession.shared.data(for: request)
      try validateAPIResponse(response, data: data)

      let decoded = try JSONDecoder().decode([String: RemoteAgentSummary].self, from: data)
      let agents = decoded
        .map { key, value in
          TextAgentCatalogEntry(id: key, name: value.name, description: value.description)
        }
        .sorted { left, right in
          left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
        }

      availableTextAgents = agents
      mergeTextThreads(with: agents)
      ensureSelectedTextAgent()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectTextAgent(_ agentID: String) {
    guard textThreads.contains(where: { $0.id == agentID }) else { return }
    selectedTextAgentID = agentID
  }

  @MainActor
  func sendTextMessage(_ rawText: String, to agentID: String? = nil) async -> Bool {
    let trimmedText = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else { return false }
    if availableTextAgents.isEmpty || textThreads.isEmpty {
      await loadTextAgentsIfNeeded()
    }

    let resolvedAgentID = agentID ?? selectedTextAgentID ?? textThreads.first?.id
    guard let resolvedAgentID else { return false }
    guard sendingTextAgentID == nil else { return false }
    guard let thread = textThread(for: resolvedAgentID) else { return false }

    selectedTextAgentID = resolvedAgentID
    sendingTextAgentID = resolvedAgentID
    errorMessage = nil
    appendTextConversationMessage(role: .user, text: trimmedText, to: resolvedAgentID)
    setAwaitingResponse(true, for: resolvedAgentID)

    defer {
      sendingTextAgentID = nil
      setAwaitingResponse(false, for: resolvedAgentID)
    }

    do {
      var request = URLRequest(url: RockoConfiguration.agentGenerateURL(agentID: resolvedAgentID))
      request.httpMethod = "POST"
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      applyAuthorization(to: &request)

      let payload = AgentGenerateRequest(
        messages: trimmedText,
        memory: AgentGenerateMemoryOptions(
          thread: thread.threadID,
          resource: thread.resourceID
        )
      )

      request.httpBody = try JSONEncoder().encode(payload)

      let (data, response) = try await URLSession.shared.data(for: request)
      try validateAPIResponse(response, data: data)

      let decoded = try JSONDecoder().decode(AgentGenerateResponse.self, from: data)
      let responseText = decoded.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

      guard !responseText.isEmpty else {
        throw NSError(
          domain: "RockoAPI",
          code: -1,
          userInfo: [NSLocalizedDescriptionKey: "The agent returned an empty response."]
        )
      }

      appendTextConversationMessage(
        role: .assistant,
        text: responseText,
        agentName: thread.agent.name,
        to: resolvedAgentID
      )

      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  private func handle(event: ServerEvent) {
    switch event.type {
    case "session.ready":
      connectionState = .connected
      reconnectAttempt = 0
      if let agents = event.agents {
        availableAgents = agents
      }
      if let activeAgent = event.activeAgent, !activeAgent.isEmpty {
        updateActiveAgent(named: activeAgent)
      }
      phase = isSessionOpen ? .listening : .idle

    case "session.state":
      if let rawState = event.state, let parsed = LiveSessionPhase(rawValue: rawState) {
        phase = parsed
        if parsed == .followUpWindow {
          scheduleFollowUpWindow()
        }
      }
      if let activeAgent = event.activeAgent, !activeAgent.isEmpty {
        updateActiveAgent(named: activeAgent)
      }

    case "transcript.partial", "transcript.final":
      if let text = event.text, !text.isEmpty {
        lastUserUtterance = text
        updateConversation(
          role: .user,
          channel: .liveVoice,
          text: text,
          isFinal: event.type == "transcript.final"
        )
      }
      phase = event.type == "transcript.final" ? .thinking : .listening

    case "assistant.text":
      if let text = event.text, !text.isEmpty {
        lastAssistantUtterance = text
        let resolvedAgentName = event.agentName ?? event.activeAgent ?? activeAgentName
        updateConversation(
          role: .assistant,
          channel: .liveVoice,
          text: text,
          isFinal: event.isFinal ?? false,
          agentName: resolvedAgentName
        )
      }
      if let activeAgent = event.activeAgent, !activeAgent.isEmpty {
        updateActiveAgent(named: activeAgent)
      }
      if let agentName = event.agentName, !agentName.isEmpty {
        updateActiveAgent(named: agentName)
      }
      if !audioPlayback.isPlaying {
        enterFollowUpWindow()
      }

    case "tool.status":
      if let toolName = event.displayName ?? event.tool, let toolPhase = event.phase {
        switch toolPhase {
        case "started":
          activeToolStatus = "\(toolName)..."
        case "completed":
          activeToolStatus = nil
        case "failed":
          activeToolStatus = "\(toolName) failed"
        default:
          break
        }
      }

    case "error":
      errorMessage = event.message ?? "The live session reported an unspecified error."
      phase = .error
      finalizeDraftMessages()

    case "session.closed":
      isSessionOpen = false
      phase = .idle
      audioCapture.stop()
      activeToolStatus = nil
      finalizeDraftMessages()

    default:
      break
    }
  }

  private func enterFollowUpWindow() {
    guard isSessionOpen else {
      phase = .idle
      return
    }

    phase = .followUpWindow
    scheduleFollowUpWindow()
  }

  private func scheduleFollowUpWindow() {
    followUpTimer?.cancel()
    followUpTimer = Task { [weak self] in
      try? await Task.sleep(for: .seconds(10))
      guard !Task.isCancelled else { return }
      guard let self else { return }
      await MainActor.run {
        self.stopSession()
      }
    }
  }

  private func scheduleReconnect() {
    guard isSessionOpen else { return }
    guard reconnectAttempt < Self.maxReconnectAttempts else {
      errorMessage = "Connection lost after \(Self.maxReconnectAttempts) attempts"
      phase = .error
      return
    }

    reconnectTask?.cancel()
    reconnectAttempt += 1
    let delay = Self.baseReconnectDelay * pow(2.0, Double(reconnectAttempt - 1))
    phase = .connecting

    reconnectTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      guard let self else { return }
      await MainActor.run {
        self.pendingSessionStart = true
        self.socketClient.connect()
      }
    }
  }

  private func updateActiveAgent(named name: String) {
    activeAgentName = name
    if let matchedAgent = availableAgents.first(where: { $0.displayName == name }) {
      selectedAgentKey = matchedAgent.agentKey
    }
  }

  private func updateConversation(
    role: ConversationMessage.Role,
    channel: ConversationMessage.Channel,
    text: String,
    isFinal: Bool,
    agentName: String? = nil
  ) {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else { return }

    let currentMessageID: UUID?
    switch role {
    case .user:
      currentMessageID = currentUserMessageID
    case .assistant:
      currentMessageID = currentAssistantMessageID
    case .system:
      currentMessageID = nil
    }

    let status: ConversationMessage.Status = isFinal ? .final : .streaming

    if let currentMessageID,
       let index = liveVoiceMessages.firstIndex(where: { $0.id == currentMessageID }) {
      liveVoiceMessages[index].text = trimmedText
      liveVoiceMessages[index].status = status
      if let agentName {
        liveVoiceMessages[index].agentName = agentName
      }
    } else {
      let message = ConversationMessage(
        role: role,
        channel: channel,
        text: trimmedText,
        status: status,
        agentName: agentName
      )
      liveVoiceMessages.append(message)

      switch role {
      case .user:
        currentUserMessageID = message.id
      case .assistant:
        currentAssistantMessageID = message.id
      case .system:
        break
      }
    }

    if isFinal {
      switch role {
      case .user:
        currentUserMessageID = nil
      case .assistant:
        currentAssistantMessageID = nil
      case .system:
        break
      }
    }
  }

  private func finalizeDraftMessages() {
    if let currentUserMessageID,
       let index = liveVoiceMessages.firstIndex(where: { $0.id == currentUserMessageID }) {
      liveVoiceMessages[index].status = .final
    }

    if let currentAssistantMessageID,
       let index = liveVoiceMessages.firstIndex(where: { $0.id == currentAssistantMessageID }) {
      liveVoiceMessages[index].status = .final
    }

    currentUserMessageID = nil
    currentAssistantMessageID = nil
  }

  private func mergeTextThreads(with agents: [TextAgentCatalogEntry]) {
    let existingThreads = Dictionary(uniqueKeysWithValues: textThreads.map { ($0.id, $0) })

    textThreads = agents.map { agent in
      if var existingThread = existingThreads[agent.id] {
        existingThread.agent = agent
        return existingThread
      }

      return TextConversationThread(agent: agent)
    }

    sortTextThreads()
  }

  private func ensureSelectedTextAgent() {
    if let selectedTextAgentID,
       textThreads.contains(where: { $0.id == selectedTextAgentID }) {
      return
    }

    if textThreads.contains(where: { $0.id == RockoConfiguration.defaultTextAgentID }) {
      selectedTextAgentID = RockoConfiguration.defaultTextAgentID
    } else {
      selectedTextAgentID = textThreads.first?.id
    }
  }

  private func textThread(for agentID: String) -> TextConversationThread? {
    textThreads.first(where: { $0.id == agentID })
  }

  private func updateTextThread(for agentID: String, update: (inout TextConversationThread) -> Void) {
    guard let index = textThreads.firstIndex(where: { $0.id == agentID }) else { return }

    update(&textThreads[index])
    sortTextThreads()
  }

  private func appendTextConversationMessage(
    role: ConversationMessage.Role,
    text: String,
    agentName: String? = nil,
    to agentID: String
  ) {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedText.isEmpty else { return }

    updateTextThread(for: agentID) { thread in
      thread.messages.append(
        ConversationMessage(
          role: role,
          channel: .text,
          text: trimmedText,
          status: .final,
          agentName: agentName ?? thread.agent.name
        )
      )
      thread.updatedAt = .now
    }
  }

  private func setAwaitingResponse(_ isAwaitingResponse: Bool, for agentID: String) {
    updateTextThread(for: agentID) { thread in
      thread.isAwaitingResponse = isAwaitingResponse
      if isAwaitingResponse {
        thread.updatedAt = .now
      }
    }
  }

  private func sortTextThreads() {
    textThreads.sort(by: Self.threadSort)
  }

  private static func threadSort(_ lhs: TextConversationThread, _ rhs: TextConversationThread) -> Bool {
    let lhsHasActivity = lhs.lastActivityAt != nil
    let rhsHasActivity = rhs.lastActivityAt != nil

    if lhsHasActivity != rhsHasActivity {
      return lhsHasActivity && !rhsHasActivity
    }

    if let lhsLastActivity = lhs.lastActivityAt,
       let rhsLastActivity = rhs.lastActivityAt,
       lhsLastActivity != rhsLastActivity {
      return lhsLastActivity > rhsLastActivity
    }

    if lhs.updatedAt != rhs.updatedAt {
      return lhs.updatedAt > rhs.updatedAt
    }

    return lhs.agent.name.localizedCaseInsensitiveCompare(rhs.agent.name) == .orderedAscending
  }

  private func applyAuthorization(to request: inout URLRequest) {
    guard let authToken = RockoConfiguration.authToken, !authToken.isEmpty else {
      return
    }

    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
  }

  private func validateAPIResponse(_ response: URLResponse, data: Data) throws {
    guard let httpResponse = response as? HTTPURLResponse else { return }
    guard 200 ..< 300 ~= httpResponse.statusCode else {
      let decodedError = try? JSONDecoder().decode(RockoAPIErrorResponse.self, from: data)
      let message = decodedError?.message
        ?? decodedError?.error
        ?? "Request failed with status \(httpResponse.statusCode)."

      throw NSError(
        domain: "RockoAPI",
        code: httpResponse.statusCode,
        userInfo: [NSLocalizedDescriptionKey: message]
      )
    }
  }

  var isSendingText: Bool {
    sendingTextAgentID != nil
  }

  var liveVoiceConversation: [ConversationMessage] {
    liveVoiceMessages
  }

  var textConversationThreads: [TextConversationThread] {
    textThreads
  }

  var selectedTextThread: TextConversationThread? {
    guard let selectedTextAgentID else { return nil }
    return textThread(for: selectedTextAgentID)
  }

  var selectedTextConversation: [ConversationMessage] {
    selectedTextThread?.messages ?? []
  }

  var selectedTextAgentName: String {
    selectedTextThread?.agent.name ?? selectedTextAgentID ?? "Agent"
  }

  var selectedTextAgentDescription: String? {
    selectedTextThread?.agent.description
  }

  func isSendingText(to agentID: String) -> Bool {
    sendingTextAgentID == agentID
  }

  func textThread(agentID: String) -> TextConversationThread? {
    textThread(for: agentID)
  }
}

extension SocketConnectionState {
  var displayName: String {
    switch self {
    case .disconnected:
      return "Disconnected"
    case .connecting:
      return "Connecting"
    case .connected:
      return "Connected"
    }
  }
}
