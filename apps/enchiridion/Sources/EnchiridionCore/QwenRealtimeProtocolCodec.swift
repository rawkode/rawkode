import Foundation

/// Strict, bounded decoding for the Qwen Audio Realtime JSON protocol. Unknown
/// additive events are ignored, but recognised malformed events never reach a
/// session or tool boundary.
public struct QwenRealtimeProtocolCodec: Sendable {
  public static let maximumEventBytes = 128 * 1024
  public static let maximumAudioBytes = 48 * 1024
  public static let maximumTranscriptBytes = 16 * 1024
  public static let maximumArgumentsBytes = 32 * 1024
  public static let maximumClientEventBytes = 64 * 1024

  public init() {}

  public func decode(_ json: String) throws -> QwenRealtimeServerEvent? {
    guard json.utf8.count <= Self.maximumEventBytes,
      let data = json.data(using: .utf8),
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = bounded(root["type"], maximum: 128), !type.isEmpty
    else { throw QwenRealtimeError.malformedEvent }

    switch type {
    case "session.created", "session.updated":
      let session = try object(root["session"])
      let created = QwenRealtimeSessionCreated(
        sessionID: try required(session["id"]),
        modelID: try required(session["model"]),
        voiceID: bounded(session["voice"], maximum: 128)
      )
      return type == "session.created" ? .sessionCreated(created) : .sessionUpdated(created)
    case "input_audio_buffer.speech_started": return .speechStarted
    case "input_audio_buffer.speech_stopped": return .speechStopped
    case "conversation.item.input_audio_transcription.delta":
      return .inputTranscriptDelta(id: try required(root["item_id"]), text: try transcript(root["delta"]))
    case "conversation.item.input_audio_transcription.completed":
      return .inputTranscriptDone(id: try required(root["item_id"]), text: try transcript(root["transcript"]))
    case "response.audio_transcript.delta", "response.output_audio_transcript.delta":
      return .outputTranscriptDelta(id: try required(root["item_id"]), text: try transcript(root["delta"]))
    case "response.audio_transcript.done", "response.output_audio_transcript.done":
      return .outputTranscriptDone(id: try required(root["item_id"]), text: try transcript(root["transcript"]))
    case "response.audio.delta", "response.output_audio.delta":
      guard let encoded = bounded(root["delta"], maximum: Self.maximumAudioBytes * 2),
        let audio = Data(base64Encoded: encoded), audio.count <= Self.maximumAudioBytes
      else { throw QwenRealtimeError.malformedEvent }
      return .outputAudio(audio)
    case "response.created":
      let response = (try? object(root["response"])) ?? root
      return .responseCreated(id: try required(response["id"]), inputItemID: bounded(root["item_id"] ?? response["input_item_id"], maximum: 256))
    case "response.function_call_arguments.done":
      let arguments = try arguments(root["arguments"])
      return .functionCallArgumentsDone(id: try required(root["call_id"]), argumentsJSON: arguments)
    case "response.output_item.added", "response.function_call.added":
      let item = (try? object(root["item"])) ?? root
      guard bounded(item["type"], maximum: 128) == "function_call" || type == "response.function_call.added" else { return nil }
      return .functionCallAdded(
        id: try required(item["call_id"] ?? item["id"]),
        name: try required(item["name"]),
        responseID: bounded(root["response_id"] ?? item["response_id"], maximum: 256)
      )
    case "response.done":
      let response = (try? object(root["response"])) ?? root
      let status = bounded(response["status"], maximum: 64)
      return .responseDone(id: bounded(response["id"], maximum: 256), cancelled: status == "cancelled")
    case "error":
      let error = (try? object(root["error"])) ?? root
      return .error(code: bounded(error["code"] ?? error["type"], maximum: 128), message: bounded(error["message"], maximum: 512) ?? "Qwen Realtime reported an error.")
    default: return nil
    }
  }

  public func encode(_ event: QwenRealtimeClientEvent) throws -> String {
    let object: [String: Any]
    switch event {
    case let .sessionUpdate(modelID, voiceID, enablesTools):
      var session: [String: Any] = [
        "model": modelID, "modalities": ["text", "audio"], "voice": voiceID,
        "input_audio_format": "pcm", "output_audio_format": "pcm",
        "input_audio_transcription": ["model": "fun-asr"],
        "turn_detection": ["type": "smart_turn"],
        "instructions": "Use Enchiridion tools only when the finalized user request needs local data or a task change. For read-tool query fields, copy the complete user transcript verbatim. Never claim a local mutation succeeded until its function output reports success.",
      ]
      if enablesTools {
        session["tools"] = Self.toolDefinitions
        session["tool_choice"] = "auto"
      }
      object = ["type": "session.update", "session": session]
    case let .appendInputAudio(audio):
      guard !audio.isEmpty, audio.count <= Self.maximumAudioBytes else { throw QwenRealtimeError.eventTooLarge }
      object = ["type": "input_audio_buffer.append", "audio": audio.base64EncodedString()]
    case .responseCreate: object = ["type": "response.create"]
    case .responseCancel: object = ["type": "response.cancel"]
    case .inputAudioBufferClear: object = ["type": "input_audio_buffer.clear"]
    case .outputAudioBufferClear: object = ["type": "output_audio_buffer.clear"]
    case let .functionOutput(callID, outputJSON):
      guard !callID.isEmpty, outputJSON.utf8.count <= Self.maximumArgumentsBytes,
        JSONSerialization.isValidJSONObject((try? JSONSerialization.jsonObject(with: Data(outputJSON.utf8))) as Any)
      else { throw QwenRealtimeError.malformedEvent }
      object = ["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": callID, "output": outputJSON]]
    }
    guard JSONSerialization.isValidJSONObject(object),
      let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
      data.count <= Self.maximumClientEventBytes,
      let encoded = String(data: data, encoding: .utf8)
    else { throw QwenRealtimeError.eventTooLarge }
    return encoded
  }

  private func object(_ value: Any?) throws -> [String: Any] {
    guard let object = value as? [String: Any], object.count <= 64 else { throw QwenRealtimeError.malformedEvent }
    return object
  }
  private func bounded(_ value: Any?, maximum: Int) -> String? {
    guard let string = value as? String, string.utf8.count <= maximum else { return nil }
    return string
  }
  private func required(_ value: Any?) throws -> String {
    guard let value = bounded(value, maximum: 256), !value.isEmpty else { throw QwenRealtimeError.malformedEvent }
    return value
  }
  private func transcript(_ value: Any?) throws -> String {
    guard let value = bounded(value, maximum: Self.maximumTranscriptBytes) else { throw QwenRealtimeError.malformedEvent }
    return value
  }
  private func arguments(_ value: Any?) throws -> String {
    guard let value = bounded(value, maximum: Self.maximumArgumentsBytes),
      JSONSerialization.isValidJSONObject((try? JSONSerialization.jsonObject(with: Data(value.utf8))) as Any)
    else { throw QwenRealtimeError.malformedEvent }
    return value
  }

  private static var toolDefinitions: [[String: Any]] { [
    function(
      "findCalendarEvents",
      "Find a bounded set of local calendar events. Query must be the complete user transcript.",
      properties: [
        "query": string(), "start": string(format: "date-time"),
        "end": string(format: "date-time"), "limit": integer(minimum: 1, maximum: 10),
        "includeOngoing": ["type": "boolean"],
      ],
      required: ["query", "start", "end", "limit", "includeOngoing"]
    ),
    function(
      "briefCalendarEvent",
      "Brief one event returned by findCalendarEvents in this same turn.",
      properties: [
        "sourceID": string(), "peopleLimit": integer(minimum: 1, maximum: 8),
      ],
      required: ["sourceID", "peopleLimit"]
    ),
    function(
      "searchTasks",
      "Find bounded local tasks. Use the locally inferred scope and copy the complete transcript as query, or use an empty query for that scope.",
      properties: [
        "scope": ["type": "string", "enum": AssistantTaskScope.allCases.map(\.rawValue)],
        "query": string(), "limit": integer(minimum: 1, maximum: 5),
      ],
      required: ["scope", "query", "limit"]
    ),
    function(
      "searchNotes",
      "Search a bounded local note index. Query must be the complete user transcript.",
      properties: ["query": string(), "limit": integer(minimum: 1, maximum: 5)],
      required: ["query", "limit"]
    ),
    function(
      "create_task",
      "Propose creating a local task. Enchiridion asks for native confirmation before writing.",
      properties: [
        "title": string(maximumLength: 240), "notes": string(maximumLength: 2_000),
        "data": taskDataSchema,
      ],
      required: ["title", "notes", "data"]
    ),
    function(
      "update_task",
      "Propose a small edit to a task returned by searchTasks in this turn. Copy its version exactly. Enchiridion asks for native confirmation.",
      properties: [
        "pageID": string(), "version": taskVersionSchema,
        "patch": [
          "type": "object",
          "properties": [
            "title": nullableString(maximumLength: 240),
            "notes": nullableString(maximumLength: 2_000),
            "priority": nullableEnum(TaskPriority.allCases.map(\.rawValue)),
            "placement": nullableEnum(TaskPlacement.allCases.map(\.rawValue)),
            "estimatedMinutes": ["type": ["integer", "null"], "minimum": 1, "maximum": 1_440],
          ],
          "required": ["title", "notes", "priority", "placement", "estimatedMinutes"],
          "additionalProperties": false,
        ],
      ],
      required: ["pageID", "version", "patch"]
    ),
    function(
      "complete_task",
      "Propose completing a task returned by searchTasks in this turn. Copy its version exactly. Enchiridion asks for native confirmation.",
      properties: ["pageID": string(), "version": taskVersionSchema],
      required: ["pageID", "version"]
    ),
  ] }

  private static var taskVersionSchema: [String: Any] { [
    "type": "object",
    "properties": [
      "id": string(),
      "heads": [
        "type": "object",
        "properties": ["values": ["type": "array", "items": string(), "maxItems": 32]],
        "required": ["values"], "additionalProperties": false,
      ],
      "dirtyGeneration": ["type": "integer", "minimum": 0],
    ],
    "required": ["id", "heads", "dirtyGeneration"],
    "additionalProperties": false,
  ] }

  private static var taskDataSchema: [String: Any] { [
    "type": "object",
    "properties": [
      "state": ["type": "string", "enum": ["active"]],
      "placement": ["type": "string", "enum": TaskPlacement.allCases.map(\.rawValue)],
      "scheduleGranularity": ["type": "string", "enum": TaskScheduleGranularity.allCases.map(\.rawValue)],
      "priority": ["type": "string", "enum": TaskPriority.allCases.map(\.rawValue)],
      "tags": ["type": "array", "items": string(maximumLength: 64), "maxItems": 16],
      "estimatedMinutes": ["type": ["integer", "null"], "minimum": 1, "maximum": 1_440],
    ],
    "required": ["state", "placement", "scheduleGranularity", "priority", "tags", "estimatedMinutes"],
    "additionalProperties": false,
  ] }

  private static func function(
    _ name: String,
    _ description: String,
    properties: [String: Any],
    required: [String]
  ) -> [String: Any] {
    [
      "type": "function", "name": name, "description": description,
      "parameters": [
        "type": "object", "properties": properties, "required": required,
        "additionalProperties": false,
      ],
    ]
  }

  private static func string(
    format: String? = nil,
    maximumLength: Int? = nil
  ) -> [String: Any] {
    var value: [String: Any] = ["type": "string"]
    if let format { value["format"] = format }
    if let maximumLength { value["maxLength"] = maximumLength }
    return value
  }

  private static func integer(minimum: Int, maximum: Int) -> [String: Any] {
    ["type": "integer", "minimum": minimum, "maximum": maximum]
  }

  private static func nullableString(maximumLength: Int) -> [String: Any] {
    ["type": ["string", "null"], "maxLength": maximumLength]
  }

  private static func nullableEnum(_ values: [String]) -> [String: Any] {
    ["type": ["string", "null"], "enum": values.map { $0 as Any } + [NSNull()]]
  }
}
