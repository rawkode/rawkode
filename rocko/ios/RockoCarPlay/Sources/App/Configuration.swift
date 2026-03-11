import Foundation

enum RockoConfiguration {
  static let defaultWebSocketURL = URL(string: "wss://rocko.rawkode.academy/carplay/live")!
  static let defaultTextAgentID = "executive-assistant-agent"

  static var webSocketURL: URL {
    if let override = ProcessInfo.processInfo.environment["ROCKO_WS_URL"]
      ?? ProcessInfo.processInfo.environment["ROCKO_CARPLAY_WS_URL"],
       let url = URL(string: override) {
      return url
    }
    return defaultWebSocketURL
  }

  static var authToken: String? {
    ProcessInfo.processInfo.environment["ROCKO_AUTH_TOKEN"]
  }

  static var apiBaseURL: URL {
    if let override = ProcessInfo.processInfo.environment["ROCKO_API_URL"],
       let url = URL(string: override) {
      return url
    }

    guard var components = URLComponents(url: webSocketURL, resolvingAgainstBaseURL: false) else {
      return URL(string: "https://rocko.rawkode.academy")!
    }

    if components.scheme == "wss" {
      components.scheme = "https"
    } else if components.scheme == "ws" {
      components.scheme = "http"
    }

    components.path = ""
    components.query = nil
    components.fragment = nil

    return components.url ?? URL(string: "https://rocko.rawkode.academy")!
  }

  static var agentsURL: URL {
    apiBaseURL.appending(path: "api/agents")
  }

  static func agentGenerateURL(agentID: String) -> URL {
    apiBaseURL.appending(path: "api/agents/\(agentID)/generate")
  }
}
