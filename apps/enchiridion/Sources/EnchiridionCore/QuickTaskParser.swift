import Foundation

public struct QuickTaskParseResult: Hashable, Sendable {
  public var draft: TaskDraft
  public var recognizedTokens: [String]

  public init(draft: TaskDraft, recognizedTokens: [String]) {
    self.draft = draft
    self.recognizedTokens = recognizedTokens
  }
}

/// A deliberately small, predictable parser for fast capture. It recognizes portable task syntax
/// without making the saved title depend on locale-sensitive natural-language heuristics.
public enum QuickTaskParser {
  public static func parse(
    _ input: String,
    now: Date = Date(),
    calendar: Calendar = .current
  ) -> QuickTaskParseResult {
    var title = input.trimmingCharacters(in: .whitespacesAndNewlines)
    var data = TaskData()
    var tokens: [String] = []

    let tagMatches = captures(pattern: #"(?:^|\s)#([\p{L}\p{N}_-]+)"#, in: title)
    if !tagMatches.isEmpty {
      data.tags = TaskData.normalizedTags(tagMatches.map(\.capture))
      title = removing(tagMatches.map(\.full), from: title)
      tokens.append(contentsOf: tagMatches.map { "#\($0.capture)" })
    }

    let priorities: [(token: String, priority: TaskPriority)] = [
      ("!urgent", .urgent), ("!high", .high), ("!medium", .medium), ("!low", .low),
      ("!4", .urgent), ("!3", .high), ("!2", .medium), ("!1", .low),
    ]
    for candidate in priorities where containsToken(candidate.token, in: title) {
      data.priority = candidate.priority
      title = removingToken(candidate.token, from: title)
      tokens.append(candidate.token)
      break
    }

    let recurrenceCandidates: [(phrase: String, rule: TaskRecurrenceRule)] = [
      ("every weekday", .init(unit: .week, weekdays: [.monday, .tuesday, .wednesday, .thursday, .friday])),
      ("every day", .init(unit: .day)),
      ("daily", .init(unit: .day)),
      ("every week", .init(unit: .week)),
      ("weekly", .init(unit: .week)),
      ("every month", .init(unit: .month)),
      ("monthly", .init(unit: .month)),
      ("every year", .init(unit: .year)),
      ("yearly", .init(unit: .year)),
    ]
    for candidate in recurrenceCandidates where containsPhrase(candidate.phrase, in: title) {
      data.recurrence = candidate.rule
      title = removingPhrase(candidate.phrase, from: title)
      tokens.append(candidate.phrase)
      break
    }

    let startOfToday = calendar.startOfDay(for: now)
    let tomorrow = calendar.date(byAdding: .day, value: 1, to: startOfToday)
    let nextWeek = calendar.date(byAdding: .weekOfYear, value: 1, to: startOfToday)

    for candidate in ["today", "tomorrow"] {
      let phrase = "by \(candidate)"
      guard containsPhrase(phrase, in: title) else { continue }
      data.deadline = candidate == "today" ? startOfToday : tomorrow
      title = removingPhrase(phrase, from: title)
      tokens.append(phrase)
      break
    }

    let scheduleCandidates: [(phrase: String, date: Date?, placement: TaskPlacement)] = [
      ("this evening", calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now), .anytime),
      ("tonight", calendar.date(bySettingHour: 18, minute: 0, second: 0, of: now), .anytime),
      ("tomorrow", tomorrow, .anytime),
      ("next week", nextWeek, .anytime),
      ("today", startOfToday, .anytime),
      ("someday", nil, .someday),
    ]
    for candidate in scheduleCandidates where containsPhrase(candidate.phrase, in: title) {
      data.scheduledAt = candidate.date
      data.placement = candidate.placement
      title = removingPhrase(candidate.phrase, from: title)
      tokens.append(candidate.phrase)
      break
    }

    title = normalizedWhitespace(title)
    if title.isEmpty { title = "Untitled task" }
    return QuickTaskParseResult(
      draft: TaskDraft(title: title, data: data),
      recognizedTokens: tokens
    )
  }

  private struct Match {
    var full: Range<String.Index>
    var capture: String
  }

  private static func captures(pattern: String, in value: String) -> [Match] {
    guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
      return []
    }
    let range = NSRange(value.startIndex..<value.endIndex, in: value)
    return expression.matches(in: value, range: range).compactMap { match in
      guard let full = Range(match.range(at: 0), in: value),
        let capture = Range(match.range(at: 1), in: value)
      else { return nil }
      return Match(full: full, capture: String(value[capture]))
    }
  }

  private static func removing(_ ranges: [Range<String.Index>], from value: String) -> String {
    var result = value
    for range in ranges.sorted(by: { $0.lowerBound > $1.lowerBound }) {
      result.removeSubrange(range)
    }
    return result
  }

  private static func containsToken(_ token: String, in value: String) -> Bool {
    value.range(of: #"(?i)(?:^|\s)"# + NSRegularExpression.escapedPattern(for: token) + #"(?:$|\s)"#,
      options: .regularExpression) != nil
  }

  private static func removingToken(_ token: String, from value: String) -> String {
    value.replacingOccurrences(
      of: #"(?i)(?:^|\s)"# + NSRegularExpression.escapedPattern(for: token) + #"(?=$|\s)"#,
      with: " ",
      options: .regularExpression
    )
  }

  private static func containsPhrase(_ phrase: String, in value: String) -> Bool {
    value.range(of: #"(?i)\b"# + NSRegularExpression.escapedPattern(for: phrase) + #"\b"#,
      options: .regularExpression) != nil
  }

  private static func removingPhrase(_ phrase: String, from value: String) -> String {
    value.replacingOccurrences(
      of: #"(?i)\b"# + NSRegularExpression.escapedPattern(for: phrase) + #"\b"#,
      with: " ",
      options: .regularExpression
    )
  }

  private static func normalizedWhitespace(_ value: String) -> String {
    value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
