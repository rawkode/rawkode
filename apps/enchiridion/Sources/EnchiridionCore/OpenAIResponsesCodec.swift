import Foundation

struct OpenAIConversationAnswer: Decodable, Equatable {
  let answer: String
  let factIDs: [String]
}

enum OpenAITerminalStatus: String, Equatable {
  case completed
  case incomplete
  case failed
}

struct OpenAITerminalResponse: Equatable {
  let id: String?
  let model: String?
  let status: OpenAITerminalStatus
  let output: [OpenAIJSONValue]
  let usage: AssistantTokenUsage?
}

struct OpenAILocalToolCall: Equatable {
  let name: String
  let callID: String
  let arguments: String
}

enum OpenAIResponseContent: Equatable {
  case answer(OpenAIConversationAnswer)
  case refusal(String)
  case none
}

enum OpenAIResponsesCodec {
  static func terminalResponse(from events: [Data]) throws -> OpenAITerminalResponse {
    var terminal: OpenAITerminalResponse?
    var sawDone = false
    for data in events {
      if data == Data("[DONE]".utf8) {
        guard terminal != nil, !sawDone else { throw OpenAIResponsesAssistantError.invalidResponse }
        sawDone = true
        continue
      }
      guard !sawDone, terminal == nil,
        let value = try? JSONDecoder().decode(OpenAIJSONValue.self, from: data),
        let object = value.objectValue,
        let type = object["type"]?.stringValue
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      switch type {
      case "response.completed", "response.incomplete", "response.failed":
        guard let response = object["response"]?.objectValue else {
          throw OpenAIResponsesAssistantError.invalidResponse
        }
        let decoded = try decodeTerminal(response)
        guard type == "response.\(decoded.status.rawValue)" else {
          throw OpenAIResponsesAssistantError.invalidResponse
        }
        terminal = decoded
      case "error":
        throw OpenAIResponsesAssistantError.failed
      default:
        continue
      }
    }
    // Responses streams are complete at their terminal lifecycle event. Some
    // transports also emit the legacy `[DONE]` sentinel; accept it when
    // present, but never require it.
    guard let terminal else { throw OpenAIResponsesAssistantError.invalidResponse }
    return terminal
  }

  static func toolCalls(in output: [OpenAIJSONValue]) throws -> [OpenAILocalToolCall] {
    try output.compactMap { item in
      guard let object = item.objectValue, object["type"]?.stringValue == "function_call" else {
        return nil
      }
      guard let name = object["name"]?.stringValue,
        let callID = sanitizedIdentifier(object["call_id"]?.stringValue),
        let arguments = object["arguments"]?.stringValue
      else { throw OpenAIResponsesAssistantError.invalidResponse }
      return OpenAILocalToolCall(name: name, callID: callID, arguments: arguments)
    }
  }

  static func content(in output: [OpenAIJSONValue]) throws -> OpenAIResponseContent {
    var content: OpenAIResponseContent?
    for item in output {
      guard let object = item.objectValue, object["type"]?.stringValue == "message",
        let parts = object["content"]?.arrayValue
      else { continue }
      for part in parts {
        guard let value = part.objectValue, let type = value["type"]?.stringValue else {
          throw OpenAIResponsesAssistantError.invalidResponse
        }
        let candidate: OpenAIResponseContent
        switch type {
        case "output_text":
          guard let text = value["text"]?.stringValue,
            let data = text.data(using: .utf8),
            let answer = try? JSONDecoder().decode(OpenAIConversationAnswer.self, from: data)
          else { throw OpenAIResponsesAssistantError.invalidResponse }
          candidate = .answer(answer)
        case "refusal":
          guard let raw = value["refusal"]?.stringValue else {
            throw OpenAIResponsesAssistantError.invalidResponse
          }
          let refusal = AssistantBoundedTextNormalizer.normalize(
            raw,
            budget: AssistantBoundedTextNormalizer.priorAssistantBudget
          )
          guard !refusal.isEmpty else { throw OpenAIResponsesAssistantError.invalidResponse }
          candidate = .refusal(refusal)
        default:
          continue
        }
        guard content == nil else { throw OpenAIResponsesAssistantError.invalidResponse }
        content = candidate
      }
    }
    return content ?? .none
  }

  static func sanitizedIdentifier(_ value: String?) -> String? {
    guard let value, !value.isEmpty, value.utf8.count <= 128,
      value.unicodeScalars.allSatisfy({
        CharacterSet.alphanumerics.contains($0)
          || CharacterSet(charactersIn: "-_.:").contains($0)
      })
    else { return nil }
    return value
  }

  static func adding(
    _ lhs: AssistantTokenUsage,
    _ rhs: AssistantTokenUsage
  ) -> AssistantTokenUsage {
    AssistantTokenUsage(
      input: lhs.input + rhs.input,
      cachedInput: lhs.cachedInput + rhs.cachedInput,
      cacheWrite: lhs.cacheWrite + rhs.cacheWrite,
      output: lhs.output + rhs.output,
      reasoning: lhs.reasoning + rhs.reasoning,
      total: lhs.total + rhs.total
    )
  }

  private static func decodeTerminal(
    _ response: [String: OpenAIJSONValue]
  ) throws -> OpenAITerminalResponse {
    guard let rawStatus = response["status"]?.stringValue,
      let status = OpenAITerminalStatus(rawValue: rawStatus),
      let output = response["output"]?.arrayValue
    else { throw OpenAIResponsesAssistantError.invalidResponse }
    return OpenAITerminalResponse(
      id: sanitizedIdentifier(response["id"]?.stringValue),
      model: response["model"]?.stringValue,
      status: status,
      output: output,
      usage: usage(response["usage"]?.objectValue)
    )
  }

  private static func usage(
    _ object: [String: OpenAIJSONValue]?
  ) -> AssistantTokenUsage? {
    guard let object else { return nil }
    let input = object["input_tokens"]?.integerValue ?? 0
    let output = object["output_tokens"]?.integerValue ?? 0
    let total = object["total_tokens"]?.integerValue ?? input + output
    let inputDetails = object["input_tokens_details"]?.objectValue
    let cached = inputDetails?["cached_tokens"]?.integerValue ?? 0
    let cacheWrite = inputDetails?["cache_write_tokens"]?.integerValue ?? 0
    let reasoning =
      object["output_tokens_details"]?.objectValue?["reasoning_tokens"]?.integerValue ?? 0
    return AssistantTokenUsage(
      input: input,
      cachedInput: cached,
      cacheWrite: cacheWrite,
      output: output,
      reasoning: reasoning,
      total: total
    )
  }
}
