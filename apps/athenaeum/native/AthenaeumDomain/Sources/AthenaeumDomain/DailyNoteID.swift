import Foundation

// Swift mirror of `packages/web/src/daily-note-id.ts` — the deterministic-id scheme that lets
// the daily-note flow do `getNode(id)` first and only `createNode` on `NodeNotFound`, instead of
// needing a server-side "find-or-create by title" query that doesn't exist on this RPC surface.
// **Load-bearing for the macOS/iOS app's own task item 1** ("Match the deterministic
// daily-note-id scheme the web client uses... so the SAME workspace/note is addressed from both
// clients — this is what makes cross-client sync testable"): every constant/function below must
// produce byte-identical output to the TS original for the same calendar date, or the two clients
// silently address two different `nodes` rows instead of converging on one.
//
// Placed in `AthenaeumDomain` (not the app-layer `AthenaeumApp` package) even though the TS
// original lives in `packages/web`, not `packages/domain`: this scheme only depends on
// `EntityId`, has zero UI/CF dependencies, and every native surface that wants to address "the
// same daily note" — macOS, iOS, and (per the plan's watchOS quick-capture fallback,
// `native/docs/decisions.md` Decision 2) a future watchOS target that links `AthenaeumDomain` but
// deliberately never links `AthenaeumCore`/Automerge — needs it equally. That's the same
// "zero Cloudflare/React deps, shared by every consumer" test the plan applies to the rest of
// this package's contents.

private func pad2(_ n: Int) -> String {
    n < 10 ? "0\(n)" : String(n)
}

/// `YYYY-MM-DD` for `date`, in the *device's* local calendar/timezone — mirrors `daily-note-id.ts`'s
/// `localDateStamp`: "today" should mean the user's own calendar day, not UTC or the server's
/// clock/timezone.
public func localDateStamp(_ date: Date, calendar: Calendar = .current) -> String {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    let year = components.year ?? 0
    let month = components.month ?? 0
    let day = components.day ?? 0
    return "\(year)-\(pad2(month))-\(pad2(day))"
}

/// Mirrors `daily-note-id.ts`'s `dailyNoteIdForDate`: `id = "00000000-0000-4000-8000-" +
/// YYYYMMDD` (zero-padded to 12 hex digits — decimal digits are also valid hex digits, the same
/// trick `BaseTagIds` uses). The `4000-8000` group deliberately differs from `BaseTagIds`'
/// all-zero groups purely so the two reserved-id families can never collide by construction.
public func dailyNoteIdForDate(_ date: Date, calendar: Calendar = .current) -> EntityId {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    let year = components.year ?? 0
    let month = components.month ?? 0
    let day = components.day ?? 0
    let yyyymmdd = "\(year)\(pad2(month))\(pad2(day))"
    let suffix = String(repeating: "0", count: max(0, 12 - yyyymmdd.count)) + yyyymmdd
    // Safe to force-unwrap: the construction above always yields a syntactically valid UUID
    // (fixed-length hex groups), the same guarantee `daily-note-id.ts`'s
    // `Schema.decodeUnknownSync(EntityId)` relies on for its own non-optional return type.
    // swiftlint:disable:next force_try
    return try! EntityId(validating: "00000000-0000-4000-8000-\(suffix)")
}

/// Returns the deterministic daily-note identity for an already validated civil date. This avoids
/// reinterpreting a server-resolved local day through UTC or the device's current time zone.
public func dailyNoteIdForLocalDate(_ localDate: LocalDate) -> EntityId {
    let yyyymmdd = localDate.rawValue.replacingOccurrences(of: "-", with: "")
    let suffix = String(repeating: "0", count: max(0, 12 - yyyymmdd.count)) + yyyymmdd
    // Safe by LocalDate validation plus the fixed UUID prefix.
    // swiftlint:disable:next force_try
    return try! EntityId(validating: "00000000-0000-4000-8000-\(suffix)")
}

/// The inverse of `dailyNoteIdForLocalDate`: returns the encoded civil date only when `id` is a
/// canonical daily-note id whose embedded digits form a real calendar date. This deliberately
/// mirrors the web client's `dateStampFromDailyNoteId` so retrieval surfaces can route a daily
/// note to its typed editor rather than treating it as a legacy page-text preview.
public func localDateFromDailyNoteId(_ id: String) -> LocalDate? {
    let prefix = "00000000-0000-4000-8000-0000"
    guard id.hasPrefix(prefix), id.count == prefix.count + 8 else { return nil }

    let dateDigits = String(id.dropFirst(prefix.count))
    guard dateDigits.allSatisfy(\.isNumber) else { return nil }

    let localDate = "\(dateDigits.prefix(4))-\(dateDigits.dropFirst(4).prefix(2))-\(dateDigits.suffix(2))"
    return try? LocalDate(validating: localDate)
}

/// Mirrors `daily-note-id.ts`'s `dailyNoteTitleForDate`.
public func dailyNoteTitleForDate(_ date: Date, calendar: Calendar = .current) -> String {
    "Daily Note — \(localDateStamp(date, calendar: calendar))"
}

/// Mirrors `daily-note-id.ts`'s `todayDailyNoteId`/`todayDailyNoteTitle`, but as computed
/// properties rather than module-load-time constants: the TS originals are evaluated once when
/// the browser tab's JS module first loads (effectively "app launch"), which is fine for a
/// single-page-load web session but wrong for a long-lived native process that can stay open
/// across a real midnight rollover — recomputing per access is strictly more correct here, not a
/// behavior change for any single app-launch-to-note-resolution flow.
public enum DailyNote {
    public static var todayId: EntityId { dailyNoteIdForDate(Date()) }
    public static var todayTitle: String { dailyNoteTitleForDate(Date()) }
}
