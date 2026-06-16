import Foundation

enum NoteDocumentKind: String, Codable, CaseIterable, Sendable {
    case daily
    case note
}

struct NoteDocument: Identifiable, Equatable, Sendable {
    var id: UUID
    var kind: NoteDocumentKind
    var date: String?
    var title: String
    var tiptapJSON: String
    var plainText: String
    var createdAt: Date
    var updatedAt: Date

    var displayTitle: String {
        if kind == .daily, let date {
            return DailyNoteDateFormatter.displayTitle(for: date)
        }

        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedTitle.isEmpty ? "Untitled Note" : trimmedTitle
    }

    var previewText: String {
        plainText
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: " ")
    }

    var isToday: Bool {
        kind == .daily && date == DailyNoteDateFormatter.storageString(from: .now)
    }
}

enum DailyNoteDateFormatter {
    private static var calendar: Calendar {
        Calendar(identifier: .gregorian)
    }

    private static func makeStorageFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    private static func makeDisplayFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = .current
        formatter.timeZone = .current
        formatter.dateStyle = .full
        formatter.timeStyle = .none
        return formatter
    }

    static func storageString(from date: Date) -> String {
        makeStorageFormatter().string(from: date)
    }

    static func date(from storageDate: String) -> Date? {
        makeStorageFormatter().date(from: storageDate)
    }

    static func storageString(byAddingDays dayOffset: Int, to storageDate: String) -> String? {
        guard let date = date(from: storageDate),
              let shiftedDate = calendar.date(byAdding: .day, value: dayOffset, to: date) else {
            return nil
        }

        return storageString(from: shiftedDate)
    }

    static func relativeStorageString(for literal: String, relativeTo date: Date = .now) -> String? {
        let normalizedLiteral = literal.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pattern = #"^(today|yesterday|tomorrow)(?:\s*([+-])\s*([0-9]+)\s*(d|day|days))?$"#
        guard let match = normalizedLiteral.firstMatch(pattern: pattern),
              let baseLiteral = match[1] else {
            return nil
        }

        let baseDayOffset: Int
        switch baseLiteral {
        case "today":
            baseDayOffset = 0
        case "yesterday":
            baseDayOffset = -1
        case "tomorrow":
            baseDayOffset = 1
        default:
            return nil
        }

        let relativeDayOffset: Int
        if let sign = match[2] {
            guard let rawOffset = match[3], let offset = Int(rawOffset) else {
                return nil
            }

            relativeDayOffset = sign == "-" ? -offset : offset
        } else {
            relativeDayOffset = 0
        }

        let (dayOffset, didOverflow) = baseDayOffset.addingReportingOverflow(relativeDayOffset)
        guard !didOverflow else {
            return nil
        }

        guard let resolvedDate = calendar.date(byAdding: .day, value: dayOffset, to: date) else {
            return nil
        }

        return storageString(from: resolvedDate)
    }

    static func isRelativeDateLiteral(_ literal: String) -> Bool {
        let normalizedLiteral = literal.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pattern = #"^(today|yesterday|tomorrow)(?:\s*[+-].*)?$"#
        return normalizedLiteral.firstMatch(pattern: pattern) != nil
    }

    static func displayTitle(for storageDate: String) -> String {
        guard let date = makeStorageFormatter().date(from: storageDate) else {
            return storageDate
        }

        if calendar.isDateInToday(date) {
            return "Today"
        }

        if calendar.isDateInYesterday(date) {
            return "Yesterday"
        }

        return makeDisplayFormatter().string(from: date)
    }

    static func subtitle(for storageDate: String) -> String {
        guard let date = makeStorageFormatter().date(from: storageDate) else {
            return storageDate
        }

        return makeDisplayFormatter().string(from: date)
    }
}

private extension String {
    func firstMatch(pattern: String) -> [String?]? {
        guard let expression = try? NSRegularExpression(pattern: pattern) else {
            return nil
        }

        let range = NSRange(startIndex..<endIndex, in: self)
        guard let match = expression.firstMatch(in: self, range: range) else {
            return nil
        }

        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: self) else {
                return nil
            }

            return String(self[swiftRange])
        }
    }
}
