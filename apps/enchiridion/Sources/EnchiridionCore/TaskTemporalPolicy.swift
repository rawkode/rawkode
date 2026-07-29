import Foundation

/// Canonical calendar semantics for task scheduling and recurrence.
///
/// Repository writes pass through this policy so app UI, system intents, widgets, and sync all
/// persist the same representation. Fixed schedules skip missed intervals and advance to the first
/// occurrence strictly after completion. Concurrent after-completion writes use the earliest
/// completion as the canonical event because the first completion of an occurrence is authoritative.
public enum TaskTemporalPolicy {
  private static let maximumFastForwardAdjustments = 10_000

  public static func normalized(
    _ rule: TaskRecurrenceRule,
    calendar: Calendar = .current
  ) -> TaskRecurrenceRule {
    var normalized = rule
    normalized.interval = min(99, max(1, rule.interval))
    if normalized.unit != .week {
      normalized.weekdays = []
    }
    if let endDate = normalized.endDate {
      normalized.endDate = calendar.startOfDay(for: endDate)
    }
    return normalized
  }

  public static func normalized(
    _ data: TaskData,
    calendar: Calendar = .current
  ) -> TaskData {
    var normalized = data
    if data.scheduleGranularity == .dateOnly, let scheduledAt = data.scheduledAt {
      normalized.scheduledAt = calendar.startOfDay(for: scheduledAt)
    }
    if let deadline = data.deadline {
      normalized.deadline = calendar.startOfDay(for: deadline)
    }
    if let recurrence = data.recurrence {
      normalized.recurrence = Self.normalized(recurrence, calendar: calendar)
    }
    return normalized
  }

  public static func nextDate(
    for rawRule: TaskRecurrenceRule,
    after date: Date,
    calendar: Calendar = .current
  ) -> Date? {
    let rule = normalized(rawRule, calendar: calendar)
    let candidate: Date?
    if rule.unit == .week, !rule.weekdays.isEmpty {
      candidate = nextSelectedWeekday(for: rule, after: date, calendar: calendar)
    } else {
      let component = recurrenceComponent(for: rule.unit)
      candidate = calendar.date(byAdding: component, value: rule.interval, to: date)
    }
    guard let candidate, candidate > date,
      isWithinEndDate(candidate, rule: rule, calendar: calendar)
    else { return nil }
    return candidate
  }

  /// Produces the next active occurrence without assigning its series sequence or page identity.
  public static func successorData(
    from rawData: TaskData,
    createdAt: Date,
    completedAt: Date,
    calendar: Calendar = .current
  ) -> TaskData? {
    var data = rawData
    guard let rawRecurrence = data.recurrence else { return nil }
    let recurrence = normalized(rawRecurrence, calendar: calendar)
    data.recurrence = recurrence

    let originalAnchor = data.scheduledAt ?? data.deadline ?? data.reminder ?? createdAt
    let nextDate: Date?
    switch recurrence.mode {
    case .fixedSchedule:
      nextDate = firstDate(
        for: recurrence,
        after: originalAnchor,
        strictlyAfter: completedAt,
        calendar: calendar
      )
    case .afterCompletion:
      nextDate = Self.nextDate(for: recurrence, after: completedAt, calendar: calendar)
    }
    guard let nextDate else { return nil }

    var successor = data
    successor.state = .active
    successor.completedAt = nil

    if data.scheduledAt != nil {
      successor.scheduledAt = normalizedSchedule(
        nextDate, granularity: data.scheduleGranularity, calendar: calendar)
    }
    if let deadline = data.deadline {
      if let scheduledAt = data.scheduledAt, let successorSchedule = successor.scheduledAt {
        successor.deadline = shiftedDeadline(
          deadline,
          from: scheduledAt,
          to: successorSchedule,
          calendar: calendar
        )
      } else {
        successor.deadline = calendar.startOfDay(for: nextDate)
      }
    }
    if let reminder = data.reminder {
      if let scheduledAt = data.scheduledAt, let successorSchedule = successor.scheduledAt {
        successor.reminder = shifted(
          reminder,
          relativeTo: scheduledAt,
          onto: successorSchedule,
          calendar: calendar
        )
      } else if let deadline = data.deadline, let successorDeadline = successor.deadline {
        successor.reminder = shifted(
          reminder,
          relativeTo: deadline,
          onto: successorDeadline,
          calendar: calendar
        )
      } else {
        successor.reminder = nextDate
      }
    }
    if data.scheduledAt == nil, data.deadline == nil {
      successor.scheduledAt = normalizedSchedule(
        nextDate,
        granularity: data.scheduleGranularity,
        calendar: calendar
      )
    }
    if successor.placement == .inbox {
      successor.placement = .anytime
    }
    return Self.normalized(successor, calendar: calendar)
  }

  static func completionSuccessorGeneration(
    from source: TaskData,
    successor: TaskData,
    completedAt: Date
  ) -> TaskCompletionSuccessorGeneration? {
    guard let recurrence = source.recurrence, recurrence.mode == .afterCompletion,
      let seriesID = source.recurrenceSeriesID,
      let sourceSequence = source.recurrenceSequence,
      let successorSeriesID = successor.recurrenceSeriesID,
      let successorSequence = successor.recurrenceSequence,
      seriesID == successorSeriesID
    else { return nil }
    let (expectedSuccessorSequence, overflow) = sourceSequence.addingReportingOverflow(1)
    guard !overflow, successorSequence == expectedSuccessorSequence else { return nil }

    return TaskCompletionSuccessorGeneration(
      seriesID: seriesID,
      sourceSequence: sourceSequence,
      successorSequence: successorSequence,
      recurrence: recurrence,
      sourceTiming: TaskRecurrenceTiming(data: source),
      completedAt: completedAt,
      successorTiming: TaskRecurrenceTiming(data: successor)
    )
  }

  /// Resolves only conflicts proven to come from concurrent completions of the same occurrence.
  /// The earliest completion's entire generation wins; manual and mixed edits remain conflicts.
  static func canonicalAfterCompletionConflictValues(
    in metadata: PageObjectMetadata
  ) -> [SupertagPropertyKey: [SupertagValue]] {
    guard metadata.supertagIDs.contains(BuiltInSupertags.task) else { return [:] }
    guard
      let provenanceConflict = metadata.conflicts.first(where: {
        $0.key == TaskFields.temporalProvenance
      })
    else { return [:] }

    let candidates = provenanceConflict.candidates.compactMap(generationCandidate(from:))
    guard candidates.count == provenanceConflict.candidates.count,
      candidates.count > 1,
      let first = candidates.first,
      isValidGenerationLineage(candidates.map(\.generation))
    else { return [:] }

    let generation = first.generation
    guard let role = generationRole(for: generation, metadata: metadata),
      matchesRecurrence(generation.recurrence, in: metadata),
      matchesExpectedCandidates(
        for: TaskFields.recurrenceSeriesID,
        expected: candidates.map { [.text($0.generation.seriesID.rawValue)] },
        in: metadata
      ),
      matchesExpectedCandidates(
        for: TaskFields.recurrenceSequence,
        expected: candidates.map {
          let sequence =
            role == .source
            ? $0.generation.sourceSequence
            : $0.generation.successorSequence
          return [.number(Double(sequence))]
        },
        in: metadata
      ),
      timingCandidatesMatch(candidates.map(\.generation), role: role, metadata: metadata)
    else { return [:] }

    let winner = candidates.min(by: generationPrecedes) ?? first
    var resolutions = [
      TaskFields.temporalProvenance: winner.values
    ]
    for key in resolvedTemporalKeys(for: role) {
      guard let values = temporalValues(for: key, generation: winner.generation, role: role)
      else { return [:] }
      resolutions[key] = values
    }
    return resolutions
  }

  private static func firstDate(
    for rule: TaskRecurrenceRule,
    after anchor: Date,
    strictlyAfter cutoff: Date,
    calendar: Calendar
  ) -> Date? {
    var cursor = fastForwardCursor(
      for: rule,
      from: anchor,
      toward: cutoff,
      calendar: calendar
    )
    for _ in 0..<maximumFastForwardAdjustments {
      guard let candidate = nextDate(for: rule, after: cursor, calendar: calendar) else {
        return nil
      }
      if candidate > cutoff { return candidate }
      cursor = candidate
    }
    return nil
  }

  /// Jumps close to the completion date before performing exact recurrence steps. Month and year
  /// recurrences stay iterative because repeated calendar additions can clamp month-end dates.
  private static func fastForwardCursor(
    for rule: TaskRecurrenceRule,
    from anchor: Date,
    toward cutoff: Date,
    calendar: Calendar
  ) -> Date {
    guard cutoff > anchor, rule.unit == .day || rule.unit == .week else { return anchor }
    let component = recurrenceComponent(for: rule.unit)
    let distance = max(
      0,
      calendar.dateComponents([component], from: anchor, to: cutoff).value(for: component)
        ?? 0
    )
    var jumps = max(0, distance / rule.interval - 1)
    while jumps > 0 {
      let (amount, overflow) = jumps.multipliedReportingOverflow(by: rule.interval)
      guard !overflow,
        let candidate = calendar.date(byAdding: component, value: amount, to: anchor)
      else { return anchor }
      if candidate <= cutoff { return candidate }
      jumps -= 1
    }
    return anchor
  }

  private static func nextSelectedWeekday(
    for rule: TaskRecurrenceRule,
    after date: Date,
    calendar: Calendar
  ) -> Date? {
    let start = calendar.startOfDay(for: date)
    let currentWeek = calendar.dateInterval(of: .weekOfYear, for: start)?.start ?? start
    let allowed = Set(rule.weekdays.map(\.rawValue))
    let time = calendar.dateComponents([.hour, .minute, .second, .nanosecond], from: date)
    let maximumDays = max(14, rule.interval * 7 + 7)

    for offset in 1...maximumDays {
      guard let candidateDay = calendar.date(byAdding: .day, value: offset, to: start),
        allowed.contains(calendar.component(.weekday, from: candidateDay))
      else { continue }
      let candidateWeek =
        calendar.dateInterval(of: .weekOfYear, for: candidateDay)?.start
        ?? candidateDay
      let weeks =
        calendar.dateComponents(
          [.weekOfYear],
          from: currentWeek,
          to: candidateWeek
        ).weekOfYear ?? 0
      guard weeks % rule.interval == 0 else { continue }
      let candidate =
        calendar.date(
          bySettingHour: time.hour ?? 0,
          minute: time.minute ?? 0,
          second: time.second ?? 0,
          of: candidateDay
        ) ?? candidateDay
      guard candidate > date else { continue }
      return candidate
    }
    return nil
  }

  private static func normalizedSchedule(
    _ date: Date,
    granularity: TaskScheduleGranularity,
    calendar: Calendar
  ) -> Date {
    granularity == .dateOnly ? calendar.startOfDay(for: date) : date
  }

  private static func recurrenceComponent(
    for unit: TaskRecurrenceUnit
  ) -> Calendar.Component {
    switch unit {
    case .day: .day
    case .week: .weekOfYear
    case .month: .month
    case .year: .year
    }
  }

  private static func shifted(
    _ value: Date,
    relativeTo source: Date,
    onto destination: Date,
    calendar: Calendar
  ) -> Date? {
    let offset = calendar.dateComponents(
      [.day, .hour, .minute, .second, .nanosecond],
      from: source,
      to: value
    )
    return calendar.date(byAdding: offset, to: destination)
  }

  private static func shiftedDeadline(
    _ deadline: Date,
    from sourceSchedule: Date,
    to destinationSchedule: Date,
    calendar: Calendar
  ) -> Date? {
    let dayOffset =
      calendar.dateComponents(
        [.day],
        from: calendar.startOfDay(for: sourceSchedule),
        to: calendar.startOfDay(for: deadline)
      ).day ?? 0
    return calendar.date(
      byAdding: .day,
      value: dayOffset,
      to: calendar.startOfDay(for: destinationSchedule)
    )
  }

  private static func isWithinEndDate(
    _ candidate: Date,
    rule: TaskRecurrenceRule,
    calendar: Calendar
  ) -> Bool {
    guard let endDate = rule.endDate else { return true }
    return calendar.startOfDay(for: candidate) <= calendar.startOfDay(for: endDate)
  }

  private enum GenerationRole: Equatable {
    case source
    case successor
  }

  private struct GenerationCandidate {
    var generation: TaskCompletionSuccessorGeneration
    var values: [SupertagValue]
    var encoded: String
  }

  private static func generationCandidate(
    from values: [SupertagValue]
  ) -> GenerationCandidate? {
    guard values.count == 1, case .text(let encoded) = values[0],
      let data = encoded.data(using: .utf8),
      let provenance = try? JSONDecoder.enchiridion.decode(
        TaskTemporalProvenance.self,
        from: data
      ),
      provenance.kind == .completionSuccessor,
      let generation = provenance.generation
    else { return nil }
    return GenerationCandidate(generation: generation, values: values, encoded: encoded)
  }

  private static func isValidGenerationLineage(
    _ generations: [TaskCompletionSuccessorGeneration]
  ) -> Bool {
    guard let first = generations.first, first.trigger == .afterCompletion,
      first.recurrence.mode == .afterCompletion,
      first.sourceSequence >= 0
    else { return false }
    let (expectedSuccessorSequence, overflow) = first.sourceSequence.addingReportingOverflow(1)
    guard !overflow, first.successorSequence == expectedSuccessorSequence else { return false }
    return generations.allSatisfy {
      $0.trigger == .afterCompletion
        && $0.seriesID == first.seriesID
        && $0.sourceSequence == first.sourceSequence
        && $0.successorSequence == first.successorSequence
        && $0.recurrence == first.recurrence
        && $0.sourceTiming == first.sourceTiming
    }
  }

  private static func generationRole(
    for generation: TaskCompletionSuccessorGeneration,
    metadata: PageObjectMetadata
  ) -> GenerationRole? {
    guard metadata.conflicts.allSatisfy({ $0.key != TaskFields.recurrenceSequence }),
      let values = metadata.properties[TaskFields.recurrenceSequence],
      values.count == 1,
      case .number(let rawSequence) = values[0],
      let sequence = Int(exactly: rawSequence)
    else { return nil }
    if sequence == generation.sourceSequence { return .source }
    if sequence == generation.successorSequence { return .successor }
    return nil
  }

  private static func matchesRecurrence(
    _ recurrence: TaskRecurrenceRule,
    in metadata: PageObjectMetadata
  ) -> Bool {
    let values = candidateValues(for: TaskFields.recurrence, in: metadata)
    let decoded = values.compactMap { candidate -> TaskRecurrenceRule? in
      guard candidate.count == 1, case .text(let encoded) = candidate[0],
        let data = encoded.data(using: .utf8)
      else { return nil }
      return try? JSONDecoder.enchiridion.decode(TaskRecurrenceRule.self, from: data)
    }
    return !values.isEmpty
      && decoded.count == values.count
      && decoded.allSatisfy { $0 == recurrence && $0.mode == .afterCompletion }
  }

  private static func timingCandidatesMatch(
    _ generations: [TaskCompletionSuccessorGeneration],
    role: GenerationRole,
    metadata: PageObjectMetadata
  ) -> Bool {
    let temporalKeys = [
      TaskFields.scheduled,
      TaskFields.deadline,
      TaskFields.reminder,
      TaskFields.completedAt,
    ]
    for key in temporalKeys {
      let expected = generations.compactMap {
        temporalValues(for: key, generation: $0, role: role)
      }
      guard expected.count == generations.count,
        matchesExpectedCandidates(for: key, expected: expected, in: metadata)
      else { return false }
    }

    let granularities = generations.map { generation -> [SupertagValue] in
      let timing = role == .source ? generation.sourceTiming : generation.successorTiming
      return [.select(timing.scheduleGranularity.rawValue)]
    }
    return matchesExpectedCandidates(
      for: TaskFields.scheduleGranularity,
      expected: granularities,
      in: metadata
    )
  }

  private static func temporalValues(
    for key: SupertagPropertyKey,
    generation: TaskCompletionSuccessorGeneration,
    role: GenerationRole
  ) -> [SupertagValue]? {
    let timing = role == .source ? generation.sourceTiming : generation.successorTiming
    switch key {
    case TaskFields.scheduled:
      return timing.scheduledAt.map { [.dateTime($0)] } ?? []
    case TaskFields.deadline:
      return timing.deadline.map { [.date($0)] } ?? []
    case TaskFields.reminder:
      return timing.reminder.map { [.dateTime($0)] } ?? []
    case TaskFields.completedAt:
      return role == .source ? [.dateTime(generation.completedAt)] : []
    default:
      return nil
    }
  }

  private static func resolvedTemporalKeys(
    for role: GenerationRole
  ) -> [SupertagPropertyKey] {
    switch role {
    case .source: [TaskFields.completedAt]
    case .successor: [TaskFields.scheduled, TaskFields.deadline, TaskFields.reminder]
    }
  }

  private static func matchesExpectedCandidates(
    for key: SupertagPropertyKey,
    expected: [[SupertagValue]],
    in metadata: PageObjectMetadata
  ) -> Bool {
    Set(candidateValues(for: key, in: metadata)) == Set(expected)
  }

  private static func candidateValues(
    for key: SupertagPropertyKey,
    in metadata: PageObjectMetadata
  ) -> [[SupertagValue]] {
    if let conflict = metadata.conflicts.first(where: { $0.key == key }) {
      return conflict.candidates
    }
    return [metadata.properties[key, default: []]]
  }

  private static func generationPrecedes(
    _ lhs: GenerationCandidate,
    _ rhs: GenerationCandidate
  ) -> Bool {
    if lhs.generation.completedAt != rhs.generation.completedAt {
      return lhs.generation.completedAt < rhs.generation.completedAt
    }
    return lhs.encoded < rhs.encoded
  }
}
