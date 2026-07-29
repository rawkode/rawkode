import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

public struct QuickTaskParseResult: Hashable, Sendable {
  public var draft: TaskDraft
  public var recognizedTokens: [String]

  public init(draft: TaskDraft, recognizedTokens: [String]) {
    self.draft = draft
    self.recognizedTokens = recognizedTokens
  }
}

/// Compatibility for callers that cannot present an interpretation review UI.
///
/// This deliberately performs no natural-language parsing. Metadata must come from
/// `FoundationTaskInterpreter` and be confirmed by the person capturing the task.
public enum QuickTaskParser {
  public static func parse(
    _ input: String,
    now _: Date = Date(),
    calendar _: Calendar = .current
  ) -> QuickTaskParseResult {
    QuickTaskParseResult(
      draft: TaskDraft(title: Self.literalTitle(input)),
      recognizedTokens: []
    )
  }

  private static func literalTitle(_ input: String) -> String {
    let literal = input.trimmingCharacters(in: .whitespacesAndNewlines)
    return literal.isEmpty ? "Untitled task" : literal
  }
}

public struct TaskInterpretationContext: Hashable, Sendable {
  public var projectNames: [String]
  public var areaNames: [String]
  public var parentTaskTitles: [String]
  public var personNames: [String]

  public init(
    projectNames: [String] = [],
    areaNames: [String] = [],
    parentTaskTitles: [String] = [],
    personNames: [String] = []
  ) {
    self.projectNames = projectNames
    self.areaNames = areaNames
    self.parentTaskTitles = parentTaskTitles
    self.personNames = personNames
  }
}

public enum TaskInterpretationField: String, CaseIterable, Hashable, Sendable {
  case title
  case scheduledDate
  case deadline
  case reminder
  case recurrence
  case tag
  case priority
  case project
  case area
  case parentTask
  case person
  case estimatedDuration

  public var title: String {
    switch self {
    case .title: "Suggested title"
    case .scheduledDate: "Schedule"
    case .deadline: "Deadline"
    case .reminder: "Reminder"
    case .recurrence: "Repeat"
    case .tag: "Tag"
    case .priority: "Priority"
    case .project: "Project"
    case .area: "Area"
    case .parentTask: "Parent task"
    case .person: "Person"
    case .estimatedDuration: "Estimate"
    }
  }
}

public enum TaskInterpretationSuggestionState: String, Hashable, Sendable {
  /// The value is representable in `TaskData` and has been applied to the draft.
  case applied
  /// The value needs a local match or has no current `TaskData` representation.
  case unresolved
  /// The model returned a value that trusted normalization rejected.
  case invalid
}

public struct TaskInterpretationSuggestion: Identifiable, Hashable, Sendable {
  public var id: String
  public var field: TaskInterpretationField
  public var value: String
  public var sourceText: String
  public var state: TaskInterpretationSuggestionState
  public var explanation: String?

  public init(
    id: String,
    field: TaskInterpretationField,
    value: String,
    sourceText: String,
    state: TaskInterpretationSuggestionState,
    explanation: String? = nil
  ) {
    self.id = id
    self.field = field
    self.value = value
    self.sourceText = sourceText
    self.state = state
    self.explanation = explanation
  }
}

public enum TaskInterpretationConfirmation: Hashable, Sendable {
  case literal
  case extractedFields
  case unresolvedHints
}

public struct TaskInterpretation: Hashable, Sendable {
  public var originalInput: String
  public var draft: TaskDraft
  public var suggestions: [TaskInterpretationSuggestion]

  public init(
    originalInput: String,
    draft: TaskDraft,
    suggestions: [TaskInterpretationSuggestion]
  ) {
    self.originalInput = originalInput
    self.draft = draft
    self.suggestions = suggestions
  }

  public var recognizedTokens: [String] {
    suggestions.compactMap { suggestion in
      let token = suggestion.sourceText.trimmingCharacters(in: .whitespacesAndNewlines)
      return token.isEmpty ? nil : token
    }
  }

  public var confirmation: TaskInterpretationConfirmation {
    if suggestions.contains(where: { $0.state != .applied }) { return .unresolvedHints }
    if !suggestions.isEmpty { return .extractedFields }
    return .literal
  }

  public var requiresConfirmation: Bool { confirmation != .literal }

  public static func literal(_ input: String) -> Self {
    let parsed = QuickTaskParser.parse(input)
    return Self(originalInput: input, draft: parsed.draft, suggestions: [])
  }
}

public enum TaskInterpretationResponse: Sendable {
  case interpreted(TaskInterpretation)
  case unavailable(TaskInterpretation, AssistantAvailability)
  case failed(String)
}

public protocol TaskInputInterpreting: Sendable {
  func interpret(
    _ input: String,
    context: TaskInterpretationContext,
    now: Date,
    calendar: Calendar,
    locale: Locale
  ) async -> TaskInterpretationResponse
}

/// Converts an explicitly requested interpretation into an editable proposal without writing it.
/// Local associations are accepted only when one existing catalog entry has the same canonical
/// name. Ambiguous and missing names remain unresolved suggestions and never create pages.
public enum TaskClarificationProposalBuilder {
  public static func result(
    seed: TaskClarificationSeed,
    response: TaskInterpretationResponse
  ) -> TaskClarificationProposalResult {
    let fallback = TaskClarificationManualFallback(
      taskID: seed.taskID,
      expectedVersion: seed.expectedVersion,
      draft: seed.literalDraft
    )
    switch response {
    case .unavailable(_, let availability):
      return .unavailable(fallback, availability)
    case .failed(let message):
      return .failed(fallback, message)
    case .interpreted(let interpretation):
      return .proposed(proposal(seed: seed, interpretation: interpretation))
    }
  }

  private static func proposal(
    seed: TaskClarificationSeed,
    interpretation: TaskInterpretation
  ) -> TaskClarificationProposal {
    var draft = seed.literalDraft
    var resolved = interpretation
    let interpretedData = interpretation.draft.data
    let appliedFields = Set(
      interpretation.suggestions.lazy
        .filter { $0.state == .applied }
        .map(\.field)
    )

    draft.title = interpretation.draft.title
    if appliedFields.contains(.scheduledDate) {
      draft.scheduledAt = interpretedData.scheduledAt
      draft.scheduleGranularity = interpretedData.scheduleGranularity
    }
    if appliedFields.contains(.deadline) { draft.deadline = interpretedData.deadline }
    if appliedFields.contains(.reminder) { draft.reminder = interpretedData.reminder }
    if appliedFields.contains(.recurrence) { draft.recurrence = interpretedData.recurrence }
    if appliedFields.contains(.priority) { draft.priority = interpretedData.priority }
    if appliedFields.contains(.estimatedDuration) {
      draft.estimatedMinutes = interpretedData.estimatedMinutes
    }
    if appliedFields.contains(.tag) {
      draft.tags = TaskData.normalizedTags(draft.tags + interpretedData.tags)
    }

    for index in resolved.suggestions.indices where resolved.suggestions[index].state == .unresolved {
      let suggestion = resolved.suggestions[index]
      let match: TaskClarificationNamedReference?
      switch suggestion.field {
      case .project:
        match = uniqueExactMatch(suggestion.value, in: seed.references.projects)
        if let match { draft.projectID = match.id }
      case .area:
        match = uniqueExactMatch(suggestion.value, in: seed.references.areas)
        if let match { draft.areaID = match.id }
      case .parentTask:
        match = uniqueExactMatch(suggestion.value, in: seed.references.parentTasks)
        if let match { draft.parentTaskID = match.id }
      case .person:
        match = uniqueExactMatch(suggestion.value, in: seed.references.people)
        if let match {
          draft.assigneeIDs = TaskData.normalizedPageIDs(draft.assigneeIDs + [match.id])
        }
      default:
        match = nil
      }
      if let match {
        resolved.suggestions[index].state = .applied
        resolved.suggestions[index].value = match.title
        resolved.suggestions[index].explanation = "Matched an existing local item."
      }
    }

    return TaskClarificationProposal(
      taskID: seed.taskID,
      expectedVersion: seed.expectedVersion,
      draft: draft,
      interpretation: resolved
    )
  }

  private static func uniqueExactMatch(
    _ name: String,
    in candidates: [TaskClarificationNamedReference]
  ) -> TaskClarificationNamedReference? {
    let canonical = canonicalName(name)
    guard !canonical.isEmpty else { return nil }
    let matches = candidates.filter { canonicalName($0.title) == canonical }
    guard matches.count == 1 else { return nil }
    return matches[0]
  }

  private static func canonicalName(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
      .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
  }
}

public actor FoundationTaskInterpreter: TaskInputInterpreting {
  public init() {}

  public nonisolated static func availability(for locale: Locale = .current) -> AssistantAvailability {
#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      let model = SystemLanguageModel.default
      guard model.supportsLocale(locale) else { return .unsupportedLanguage }
      switch model.availability {
      case .available:
        return .available
      case .unavailable(.deviceNotEligible):
        return .deviceNotEligible
      case .unavailable(.appleIntelligenceNotEnabled):
        return .appleIntelligenceNotEnabled
      case .unavailable(.modelNotReady):
        return .modelNotReady
      @unknown default:
        return .modelNotReady
      }
    }
#endif
    return .unsupportedOperatingSystem
  }

  /// Uses only Apple's on-device system model. There are no tools, network calls,
  /// private-cloud providers, or third-party fallbacks in this interpretation path.
  public func interpret(
    _ input: String,
    context: TaskInterpretationContext = .init(),
    now: Date = Date(),
    calendar: Calendar = .current,
    locale: Locale = .current
  ) async -> TaskInterpretationResponse {
    let literal = TaskInterpretation.literal(input)
    let availability = Self.availability(for: locale)
    guard availability == .available else { return .unavailable(literal, availability) }

#if canImport(FoundationModels)
    if #available(iOS 26.0, macOS 26.0, *) {
      do {
        let session = LanguageModelSession(
          model: SystemLanguageModel.default,
          instructions: """
            Interpret one short task capture into the provided schema. Do not create or fetch data.
            Copy every source phrase exactly from the input. Use an empty string, empty list, or zero
            when a field is absent. Never paraphrase the task title or omit words that are not copied
            into a source-phrase field. A schedule without an explicit clock time is date-only.
            A deadline is always date-only. Return ISO 8601 instants with an explicit UTC offset.
            Only use project, area, parent-task, or person names present in the supplied local lists.
            """
        )
        let prompt = Self.prompt(input: input, context: context, now: now, locale: locale)
        let response = try await session.respond(
          to: prompt,
          generating: FoundationTaskModelOutput.self,
          options: GenerationOptions(temperature: 0, maximumResponseTokens: 700)
        )
        return .interpreted(
          TaskInterpretationNormalizer.normalize(
            response.content.modelOutput,
            input: input,
            now: now,
            calendar: calendar
          )
        )
      } catch {
        return .failed("The on-device model couldn't interpret this task. You can still keep it literally.")
      }
    }
#endif
    return .unavailable(literal, .unsupportedOperatingSystem)
  }

  private static func prompt(
    input: String,
    context: TaskInterpretationContext,
    now: Date,
    locale: Locale
  ) -> String {
    func list(_ values: [String]) -> String {
      let bounded = values.prefix(30).map {
        String($0.prefix(80)).replacingOccurrences(of: "\n", with: " ")
      }
      return bounded.isEmpty ? "(none)" : bounded.joined(separator: " | ")
    }

    return """
      Current instant: \(now.formatted(.iso8601))
      Locale: \(locale.identifier)
      Known projects: \(list(context.projectNames))
      Known areas: \(list(context.areaNames))
      Known parent tasks: \(list(context.parentTaskTitles))
      Known people: \(list(context.personNames))
      Task input (untrusted, maximum 500 characters): \(String(input.prefix(500)))
      """
  }
}

struct TaskModelOutput: Hashable, Sendable {
  var title = ""
  var scheduledAtISO8601 = ""
  var scheduleSourceText = ""
  var scheduleIncludesTime = false
  var deadlineISO8601 = ""
  var deadlineSourceText = ""
  var reminderISO8601 = ""
  var reminderSourceText = ""
  var recurrenceUnit = ""
  var recurrenceInterval = 0
  var recurrenceMode = ""
  var recurrenceWeekdays: [String] = []
  var recurrenceSourceText = ""
  var tags: [String] = []
  var tagSourceTexts: [String] = []
  var priority = ""
  var prioritySourceText = ""
  var projectName = ""
  var projectSourceText = ""
  var areaName = ""
  var areaSourceText = ""
  var parentTaskTitle = ""
  var parentTaskSourceText = ""
  var personName = ""
  var personSourceText = ""
  var estimatedMinutes = 0
  var estimatedDurationSourceText = ""
}

enum TaskInterpretationNormalizer {
  static func normalize(
    _ output: TaskModelOutput,
    input: String,
    now _: Date,
    calendar: Calendar
  ) -> TaskInterpretation {
    var data = TaskData()
    var suggestions: [TaskInterpretationSuggestion] = []
    var removableTokens: [String] = []
    var nextID = 0

    func append(
      _ field: TaskInterpretationField,
      value: String,
      sourceText: String,
      state: TaskInterpretationSuggestionState,
      explanation: String? = nil,
      removesSource: Bool = false
    ) {
      let boundedValue = clean(value, maximumLength: 300)
      let rawSource = clean(sourceText, maximumLength: 300)
      let boundedSource = exactSource(sourceText, in: input) ?? rawSource
      guard !boundedValue.isEmpty || !rawSource.isEmpty else { return }
      nextID += 1
      suggestions.append(
        TaskInterpretationSuggestion(
          id: "\(field.rawValue)-\(nextID)",
          field: field,
          value: boundedValue,
          sourceText: boundedSource,
          state: state,
          explanation: explanation
        )
      )
      if removesSource, state == .applied, !boundedSource.isEmpty { removableTokens.append(boundedSource) }
    }

    if !clean(output.scheduledAtISO8601).isEmpty || !clean(output.scheduleSourceText).isEmpty {
      if let date = date(output.scheduledAtISO8601), hasExactSource(output.scheduleSourceText, in: input) {
        data.scheduledAt = output.scheduleIncludesTime ? date : calendar.startOfDay(for: date)
        data.scheduleGranularity = output.scheduleIncludesTime ? .dateTime : .dateOnly
        data.placement = .anytime
        append(
          .scheduledDate,
          value: data.scheduledAt?.formatted(.iso8601) ?? output.scheduledAtISO8601,
          sourceText: output.scheduleSourceText,
          state: .applied,
          explanation: output.scheduleIncludesTime ? "Includes an explicit time" : "Date only",
          removesSource: true
        )
      } else {
        append(
          .scheduledDate,
          value: output.scheduledAtISO8601,
          sourceText: output.scheduleSourceText,
          state: .invalid,
          explanation: "The schedule needs a valid ISO 8601 date and an exact source phrase."
        )
      }
    }

    if !clean(output.deadlineISO8601).isEmpty || !clean(output.deadlineSourceText).isEmpty {
      if let date = date(output.deadlineISO8601), hasExactSource(output.deadlineSourceText, in: input) {
        data.deadline = calendar.startOfDay(for: date)
        append(
          .deadline,
          value: data.deadline?.formatted(.iso8601) ?? output.deadlineISO8601,
          sourceText: output.deadlineSourceText,
          state: .applied,
          explanation: "Date only",
          removesSource: true
        )
      } else {
        append(
          .deadline,
          value: output.deadlineISO8601,
          sourceText: output.deadlineSourceText,
          state: .invalid,
          explanation: "The deadline needs a valid ISO 8601 date and an exact source phrase."
        )
      }
    }

    if !clean(output.reminderISO8601).isEmpty || !clean(output.reminderSourceText).isEmpty {
      if let date = date(output.reminderISO8601), hasExactSource(output.reminderSourceText, in: input) {
        data.reminder = date
        append(
          .reminder,
          value: date.formatted(.iso8601),
          sourceText: output.reminderSourceText,
          state: .applied,
          removesSource: true
        )
      } else {
        append(
          .reminder,
          value: output.reminderISO8601,
          sourceText: output.reminderSourceText,
          state: .invalid,
          explanation: "The reminder needs a valid ISO 8601 instant and an exact source phrase."
        )
      }
    }

    normalizeRecurrence(
      output,
      data: &data,
      append: append,
      input: input,
      calendar: calendar
    )

    var validTags: [String] = []
    for (index, rawTag) in output.tags.prefix(20).enumerated() {
      let normalized = TaskData.normalizedTags([clean(rawTag, maximumLength: 64)]).first
      let rawSource = output.tagSourceTexts.indices.contains(index) ? output.tagSourceTexts[index] : ""
      if let normalized, hasExactSource(rawSource, in: input) {
        validTags.append(normalized)
        append(.tag, value: "#\(normalized)", sourceText: rawSource, state: .applied)
        if let source = exactSource(rawSource, in: input) { removableTokens.append(source) }
      } else {
        append(
          .tag,
          value: rawTag,
          sourceText: rawSource,
          state: .invalid,
          explanation: "A tag needs a valid name and an exact source phrase."
        )
      }
    }
    if output.tagSourceTexts.count > min(output.tags.count, 20) {
      for rawSource in output.tagSourceTexts.dropFirst(min(output.tags.count, 20)).prefix(20) {
        append(
          .tag,
          value: "",
          sourceText: rawSource,
          state: .invalid,
          explanation: "The model returned a tag source without a tag value."
        )
      }
    }
    data.tags = TaskData.normalizedTags(validTags)

    if !clean(output.priority).isEmpty || !clean(output.prioritySourceText).isEmpty {
      if let priority = TaskPriority(rawValue: clean(output.priority).lowercased()), priority != .none,
        hasExactSource(output.prioritySourceText, in: input)
      {
        data.priority = priority
        append(
          .priority,
          value: priority.title,
          sourceText: output.prioritySourceText,
          state: .applied,
          removesSource: true
        )
      } else {
        append(
          .priority,
          value: output.priority,
          sourceText: output.prioritySourceText,
          state: .invalid,
          explanation: "Priority needs a supported value and an exact source phrase."
        )
      }
    }

    appendNameHint(.project, value: output.projectName, source: output.projectSourceText, input: input, append: append)
    appendNameHint(.area, value: output.areaName, source: output.areaSourceText, input: input, append: append)
    appendNameHint(.parentTask, value: output.parentTaskTitle, source: output.parentTaskSourceText, input: input, append: append)
    appendNameHint(.person, value: output.personName, source: output.personSourceText, input: input, append: append)

    if output.estimatedMinutes != 0 || !clean(output.estimatedDurationSourceText).isEmpty {
      if (1...10_080).contains(output.estimatedMinutes),
        hasExactSource(output.estimatedDurationSourceText, in: input)
      {
        data.estimatedMinutes = output.estimatedMinutes
        append(
          .estimatedDuration,
          value: "\(output.estimatedMinutes) minutes",
          sourceText: output.estimatedDurationSourceText,
          state: .applied,
          removesSource: true
        )
      } else {
        append(
          .estimatedDuration,
          value: "\(output.estimatedMinutes) minutes",
          sourceText: output.estimatedDurationSourceText,
          state: .invalid,
          explanation: "The estimate must be between 1 minute and 7 days and cite an exact source phrase."
        )
      }
    }

    let derivedTitle = removingExactSources(removableTokens, from: input)
    let literal = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = derivedTitle.isEmpty ? (literal.isEmpty ? "Untitled task" : literal) : derivedTitle

    let suggestedTitle = clean(output.title, maximumLength: 500)
    if !suggestedTitle.isEmpty, normalizedWords(suggestedTitle) != normalizedWords(title) {
      nextID += 1
      suggestions.append(
        TaskInterpretationSuggestion(
          id: "title-\(nextID)",
          field: .title,
          value: suggestedTitle,
          sourceText: "",
          state: .invalid,
          explanation: "The model's rewritten title was ignored so no unrecognized words are lost."
        )
      )
    }

    return TaskInterpretation(
      originalInput: input,
      draft: TaskDraft(title: title, data: data),
      suggestions: suggestions
    )
  }

  private static func normalizeRecurrence(
    _ output: TaskModelOutput,
    data: inout TaskData,
    append: (TaskInterpretationField, String, String, TaskInterpretationSuggestionState, String?, Bool) -> Void,
    input: String,
    calendar: Calendar
  ) {
    let unitValue = clean(output.recurrenceUnit).lowercased()
    let hasRecurrence = !unitValue.isEmpty || !clean(output.recurrenceSourceText).isEmpty
    guard hasRecurrence else { return }
    guard let unit = TaskRecurrenceUnit(rawValue: unitValue),
      (1...99).contains(output.recurrenceInterval),
      hasExactSource(output.recurrenceSourceText, in: input)
    else {
      append(
        .recurrence,
        unitValue.isEmpty ? "Invalid recurrence" : "Every \(output.recurrenceInterval) \(unitValue)",
        output.recurrenceSourceText,
        .invalid,
        "Repeat needs a supported unit, an interval from 1 through 99, and an exact source phrase.",
        false
      )
      return
    }
    let mode: TaskRecurrenceMode
    switch clean(output.recurrenceMode).lowercased() {
    case "", "fixedschedule", "fixed schedule", "on schedule": mode = .fixedSchedule
    case "aftercompletion", "after completion": mode = .afterCompletion
    default:
      append(
        .recurrence,
        output.recurrenceMode,
        output.recurrenceSourceText,
        .invalid,
        "Repeat mode must be on schedule or after completion.",
        false
      )
      return
    }
    let weekdayMap = Dictionary(uniqueKeysWithValues: TaskWeekday.allCases.map {
      ($0.shortTitle.lowercased(), $0)
    })
    let weekdayValues = output.recurrenceWeekdays.map { clean($0).lowercased().prefix(3) }
    let weekdays = Set(weekdayValues.compactMap { weekdayMap[String($0)] })
    guard weekdays.count == Set(weekdayValues).count else {
      append(
        .recurrence,
        output.recurrenceWeekdays.joined(separator: ", "),
        output.recurrenceSourceText,
        .invalid,
        "One or more repeat weekdays were not recognized.",
        false
      )
      return
    }
    guard unit == .week || weekdays.isEmpty else {
      append(
        .recurrence,
        output.recurrenceWeekdays.joined(separator: ", "),
        output.recurrenceSourceText,
        .invalid,
        "Repeat weekdays are valid only with a weekly recurrence.",
        false
      )
      return
    }
    data.recurrence = TaskTemporalPolicy.normalized(
      TaskRecurrenceRule(
        mode: mode,
        interval: output.recurrenceInterval,
        unit: unit,
        weekdays: weekdays
      ),
      calendar: calendar
    )
    let days = weekdays.sorted().map(\.shortTitle).joined(separator: ", ")
    let value = "Every \(output.recurrenceInterval) \(unit.rawValue)" + (days.isEmpty ? "" : " on \(days)")
    append(.recurrence, value, output.recurrenceSourceText, .applied, nil, true)
  }

  private static func appendNameHint(
    _ field: TaskInterpretationField,
    value: String,
    source: String,
    input: String,
    append: (TaskInterpretationField, String, String, TaskInterpretationSuggestionState, String?, Bool) -> Void
  ) {
    let value = clean(value, maximumLength: 200)
    let source = clean(source, maximumLength: 200)
    guard !value.isEmpty || !source.isEmpty else { return }
    let sourceMatches = hasExactSource(source, in: input)
    append(
      field,
      value,
      source,
      value.isEmpty || !sourceMatches ? .invalid : .unresolved,
      value.isEmpty || !sourceMatches
        ? "The hint needs a usable name and an exact source phrase."
        : "Confirm this against a local item before saving.",
      false
    )
  }

  private static func date(_ value: String) -> Date? {
    try? Date(clean(value), strategy: .iso8601)
  }

  private static func clean(_ value: String, maximumLength: Int = 1_000) -> String {
    String(value.prefix(maximumLength)).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func exactSource(_ source: String, in input: String) -> String? {
    let source = clean(source, maximumLength: 300)
    guard !source.isEmpty,
      let range = input.range(of: source, options: [.caseInsensitive, .diacriticInsensitive])
    else { return nil }
    return String(input[range])
  }

  private static func hasExactSource(_ source: String, in input: String) -> Bool {
    exactSource(source, in: input) != nil
  }

  private static func removingExactSources(_ sources: [String], from input: String) -> String {
    var result = input
    for source in sources.sorted(by: { $0.count > $1.count }) {
      guard let range = result.range(of: source, options: [.caseInsensitive, .diacriticInsensitive]) else {
        continue
      }
      result.replaceSubrange(range, with: " ")
    }
    return result.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private static func normalizedWords(_ value: String) -> [String] {
    value.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
  }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
@Generable(description: "A structured interpretation of one task capture")
private struct FoundationTaskModelOutput {
  @Guide(description: "Task title copied from the input, excluding only phrases copied into source fields")
  var title: String
  @Guide(description: "Scheduled ISO 8601 instant, or empty")
  var scheduledAtISO8601: String
  @Guide(description: "Exact input phrase that supplied the schedule, or empty")
  var scheduleSourceText: String
  @Guide(description: "True only when the schedule phrase explicitly includes a clock time")
  var scheduleIncludesTime: Bool
  @Guide(description: "Deadline ISO 8601 instant at the start of its date, or empty")
  var deadlineISO8601: String
  @Guide(description: "Exact input phrase that supplied the deadline, or empty")
  var deadlineSourceText: String
  @Guide(description: "Reminder ISO 8601 instant, or empty")
  var reminderISO8601: String
  @Guide(description: "Exact input phrase that supplied the reminder, or empty")
  var reminderSourceText: String
  @Guide(description: "Repeat unit day, week, month, year, or empty")
  var recurrenceUnit: String
  @Guide(description: "Repeat interval, or zero when absent")
  var recurrenceInterval: Int
  @Guide(description: "Repeat mode fixedSchedule, afterCompletion, or empty")
  var recurrenceMode: String
  @Guide(description: "Three-letter weekday names for a weekly repeat")
  var recurrenceWeekdays: [String]
  @Guide(description: "Exact input phrase that supplied recurrence, or empty")
  var recurrenceSourceText: String
  @Guide(description: "Tag names without hash marks")
  var tags: [String]
  @Guide(description: "Exact input phrases for tags, in the same order")
  var tagSourceTexts: [String]
  @Guide(description: "Priority low, medium, high, urgent, or empty")
  var priority: String
  @Guide(description: "Exact input phrase that supplied priority, or empty")
  var prioritySourceText: String
  @Guide(description: "Exact known project name, or empty")
  var projectName: String
  @Guide(description: "Exact input phrase that supplied the project, or empty")
  var projectSourceText: String
  @Guide(description: "Exact known area name, or empty")
  var areaName: String
  @Guide(description: "Exact input phrase that supplied the area, or empty")
  var areaSourceText: String
  @Guide(description: "Exact known parent-task title, or empty")
  var parentTaskTitle: String
  @Guide(description: "Exact input phrase that supplied the parent task, or empty")
  var parentTaskSourceText: String
  @Guide(description: "Exact known person name hinted by the task, or empty")
  var personName: String
  @Guide(description: "Exact input phrase that supplied the person, or empty")
  var personSourceText: String
  @Guide(description: "Estimated duration in whole minutes, or zero")
  var estimatedMinutes: Int
  @Guide(description: "Exact input phrase that supplied estimated duration, or empty")
  var estimatedDurationSourceText: String

  var modelOutput: TaskModelOutput {
    TaskModelOutput(
      title: title,
      scheduledAtISO8601: scheduledAtISO8601,
      scheduleSourceText: scheduleSourceText,
      scheduleIncludesTime: scheduleIncludesTime,
      deadlineISO8601: deadlineISO8601,
      deadlineSourceText: deadlineSourceText,
      reminderISO8601: reminderISO8601,
      reminderSourceText: reminderSourceText,
      recurrenceUnit: recurrenceUnit,
      recurrenceInterval: recurrenceInterval,
      recurrenceMode: recurrenceMode,
      recurrenceWeekdays: recurrenceWeekdays,
      recurrenceSourceText: recurrenceSourceText,
      tags: tags,
      tagSourceTexts: tagSourceTexts,
      priority: priority,
      prioritySourceText: prioritySourceText,
      projectName: projectName,
      projectSourceText: projectSourceText,
      areaName: areaName,
      areaSourceText: areaSourceText,
      parentTaskTitle: parentTaskTitle,
      parentTaskSourceText: parentTaskSourceText,
      personName: personName,
      personSourceText: personSourceText,
      estimatedMinutes: estimatedMinutes,
      estimatedDurationSourceText: estimatedDurationSourceText
    )
  }
}
#endif
