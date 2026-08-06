// AssistantAppIntents.swift
// EnchiridionUI
//
// Task #74 ("App Intents / Siri", plan §"Platform parity (P6)"). Exposes a
// handful of `AppIntent`s that reuse P5's assistant read/write
// infrastructure DIRECTLY — no new domain logic, no new grounding rules,
// no new write-proposal vocabulary. This file is a CONSUMER of:
//   - `EnchiridionCore/AssistantTurnRetrievalAuthorization.swift` (the
//     pre-flight-authorization pattern for reads),
//   - `EnchiridionCore/AssistantWriteTools.swift`
//     (`AssistantTaskMutationProposal`/`AssistantWriteProposalSubmitting`),
//   - `EnchiridionCore/AssistantGroundingPolicy.swift`
//     (`groundedResponseUsingTrustedFacts`, so an intent's spoken response
//     is assembled ONLY from trusted `AssistantEvidenceFact.spokenText`,
//     exactly like the conversational assistant — no intent-authored
//     summary prose from raw data),
//   - `EnchiridionStore/AssistantReadTools.swift`
//     (`LocalGraphStore.searchTasks`/`findCalendarEvents`).
// None of those files are modified by this task — see the plan's
// constraint ("Do NOT modify P5's core files unless you find a genuine
// bug").
//
// Placed in `EnchiridionUI` (not `EnchiridionCore`) because it needs
// `EnchiridionStore.LocalGraphStore` and `import AppIntents` is a system
// framework, not a new package dependency — `EnchiridionUI` already
// depends on `EnchiridionCore`/`EnchiridionStore`/`EnchiridionSchema`/
// `EnchiridionSync` (see Package.swift), so no Package.swift change was
// needed to add this file. `AppIntent`s are discovered by the OS by
// scanning the compiled app binary (including linked libraries/frameworks)
// for `AppIntent`/`AppShortcutsProvider` conformances — they do not need
// to live in a dedicated Xcode target, matching the task's constraint "No
// new Xcode target needed — App Intents live in the existing app
// target(s)."
//
// ============================================================================
// THREE HONEST LIMITATIONS OF WHAT'S BUILT HERE (read before extending)
// ============================================================================
//
// 1. THE SHARED "OPEN THE APP'S LOCAL STORE" ACCESSOR
//    (`LocalGraphStore.openAppGroupStore()`, `EnchiridionStore/LocalGraphStoreLocation.swift`)
//    LANDED CONCURRENTLY WITH THIS TASK (task #75, "Widgets" — see that
//    file's own header) — reused here directly, not duplicated. Before
//    that file existed, NEITHER app target constructed a `LocalGraphStore`
//    at all (`Sources/iOS/RootView.swift`/`Sources/macOS/RootView.swift`
//    only ever built an in-memory, nowhere-persisted `PageEditorController`
//    scratch page), so this file's fallback in `AssistantAppIntentBridge.resolveStore()`
//    below opens the SAME App-Group-shared path a widget extension and the
//    main app resolve to, rather than inventing a second one. Until a real
//    projection-writing pipeline exists to populate that database in
//    production (a separate, not-yet-landed app-assembly concern per that
//    file's own header — "a future app-side projection pipeline is
//    expected to call this same method"), the read intents below are
//    correctly wired against the real P5 read-tool surface (proven by
//    this file's tests, against a real temporary store) but would read an
//    EMPTY on-device database in the actual running app today. That gap
//    is pre-existing app-assembly scope, not something this task
//    introduces or is positioned to close.
//
// 2. THE WRITE-PROPOSAL LEDGER IS IN-MEMORY AND PROCESS-LOCAL, WITH NO
//    PERSISTENCE LAYER — a real, only-partially-closable gap for
//    Siri-originated proposals specifically.
//    `AssistantTaskMutationProposalLedger` (AssistantWriteTools.swift) is a
//    plain in-memory `actor`; `AssistantConversationController` (this
//    target) constructs its own private instance per controller lifetime,
//    with no persisted storage and no injection point for reusing an
//    externally-constructed ledger. Custom `AppIntent`s that are not
//    declared in a dedicated App Intents Extension target run in-process —
//    launching the app in the background if it isn't already running, per
//    Apple's documented behavior for intents with `openAppWhenRun = false`
//    — so as long as the app's own launch path configures
//    `AssistantAppIntentBridge` (below) early, a Siri-recorded proposal
//    genuinely lands in a live ledger actor within that process, in the
//    real `.awaitingNativeConfirmation` state (proven by this file's tests
//    using the real ledger, not a mock). What is NOT wired up by this task
//    (deliberately — the task brief calls building a pending-proposals
//    inbox UI out of scope): `AssistantConversationController.init` still
//    always constructs its OWN internal ledger rather than accepting an
//    injected shared one, so a proposal recorded via `AssistantAppIntentBridge`
//    is not automatically the same instance a later-opened conversation UI
//    reads from. THE NATURAL PLACE THIS SHOULD HANG OFF: give
//    `AssistantConversationController.init` an optional injected
//    `AssistantTaskMutationProposalLedger` parameter (defaulting to
//    constructing its own, as today, when not supplied), have app-assembly
//    code construct ONE ledger at launch, configure
//    `AssistantAppIntentBridge` with it, and pass that same instance into
//    `AssistantConversationController` whenever the assistant UI is
//    opened — at that point `pendingProposals` (already public, already
//    `@Observable`) would surface a Siri-recorded proposal with no further
//    changes needed. Flagged here rather than built, per the task brief.
//
// 3. `LogWorkoutIntent` RECORDS A DRAFT **TASK**, NOT A REAL WORKOUT
//    RECORD — because no real workout record exists in this package yet.
//    Confirmed before writing this file (per the task brief's instruction
//    to check `supertags/workouts/` and this package's generated Swift
//    constants): `supertags/workouts/src/index.ts` is still a P0 skeleton
//    stub (`supertags: { /* TODO: workout, strength, cardio, ... */ }` —
//    zero fields defined), and `EnchiridionSchema/Generated/CoreSupertags.swift`
//    has no `CoreWorkout*` constants at all (grep confirms zero "workout"
//    hits under `Sources/`). There is therefore no real workout supertag,
//    no generated field-ID vocabulary, and — just as importantly — no
//    `AssistantWorkoutMutationProposal` case in `AssistantWriteTools.swift`
//    for a workout to be recorded as (that enum's only case shapes are
//    task `.create`/`.update`/`.complete`). Adding one would mean editing
//    a P5 core file, which this task's constraints explicitly forbid
//    absent a genuine bug (this is a real scope gap, not a bug). Rather
//    than fabricate a fictional field shape or silently drop this
//    required deliverable, `LogWorkoutIntent` reuses the EXISTING
//    task-shaped `.create` proposal — recording a clearly-labeled draft
//    task ("Workout: <activity>", notes carrying the duration) through the
//    exact same narrow `AssistantWriteProposalSubmitting` path
//    `AddEnchiridionTaskIntent` uses — and says so plainly in its own
//    `IntentDescription` and spoken response, so a person confirming it in
//    the app is never misled into thinking a first-class workout record
//    was created. Follow-up (not this task): once a real workout supertag
//    module lands, give `AssistantWriteTools.swift` a genuine
//    `AssistantWorkoutMutationProposal` case following the identical
//    narrow-facade pattern, and repoint this intent at it.

import AppIntents
import EnchiridionCore
import EnchiridionSchema
import EnchiridionStore
import Foundation

// MARK: - Errors

public enum AssistantAppIntentError: Error, CustomLocalizedStringResourceConvertible, Equatable, Sendable {
  case emptyTitle
  case invalidDuration
  case invalidDateRange
  case duplicateProposal
  case notConfigured

  public var localizedStringResource: LocalizedStringResource {
    switch self {
    case .emptyTitle: "Enter a task title."
    case .invalidDuration: "Enter a workout duration greater than zero minutes."
    case .invalidDateRange: "That date range isn't valid."
    case .duplicateProposal: "This request was already recorded."
    case .notConfigured: "Enchiridion isn't ready yet — open the app once, then try again."
    }
  }
}

// MARK: - Process-local bridge (see this file's header, limitations 1 and 2)

/// Lets App Intents reach the SAME live `AssistantWriteProposalSubmitting`
/// recorder / `LocalGraphStore` the running app's own UI uses, when the app
/// has configured them at launch. Every intent below also accepts a direct
/// dependency-injection seam (a plain, non-`@Parameter` stored property)
/// for tests — production code goes through this bridge only when nothing
/// was injected.
public enum AssistantAppIntentBridge: Sendable {
  private final class Storage: @unchecked Sendable {
    let lock = NSLock()
    var recorder: (any AssistantWriteProposalSubmitting)?
    var store: LocalGraphStore?
  }

  private static let storage = Storage()

  /// Called once by app-assembly code (e.g. early in `@main App.init`) with
  /// the SAME ledger recorder / store instance the rest of the running app
  /// uses. Safe to call more than once (e.g. a test harness resetting
  /// state) — the most recent configuration wins.
  public static func configure(
    proposalRecorder: any AssistantWriteProposalSubmitting,
    store: LocalGraphStore
  ) {
    storage.lock.lock()
    defer { storage.lock.unlock() }
    storage.recorder = proposalRecorder
    storage.store = store
  }

  /// Test-only: clears whatever `configure(...)` set, so tests exercising
  /// the bridge itself don't leak state into unrelated tests. Production
  /// code must never call this.
  public static func resetForTesting() {
    storage.lock.lock()
    defer { storage.lock.unlock() }
    storage.recorder = nil
    storage.store = nil
  }

  public static func resolveProposalRecorder() throws -> any AssistantWriteProposalSubmitting {
    storage.lock.lock()
    defer { storage.lock.unlock() }
    guard let recorder = storage.recorder else { throw AssistantAppIntentError.notConfigured }
    return recorder
  }

  /// Falls back to `LocalGraphStore.openAppGroupStore()` — the one real,
  /// shared, App-Group-backed production path (`LocalGraphStoreLocation.swift`)
  /// — when nothing has been configured for this process. See this file's
  /// header for why that fallback exists and its limits.
  public static func resolveStore() throws -> LocalGraphStore {
    storage.lock.lock()
    let configured = storage.store
    storage.lock.unlock()
    if let configured { return configured }
    return try LocalGraphStore.openAppGroupStore()
  }
}

// MARK: - AppEnum parameter vocabularies

public enum AssistantAppIntentTaskPriority: String, AppEnum, Sendable {
  case low, medium, high, urgent

  public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Priority" }
  public static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
    [
      .low: "Low",
      .medium: "Medium",
      .high: "High",
      .urgent: "Urgent",
    ]
  }

  var taskPriority: TaskPriority {
    switch self {
    case .low: .low
    case .medium: .medium
    case .high: .high
    case .urgent: .urgent
    }
  }
}

/// Mirrors `EnchiridionCore.AssistantTaskScope` 1:1 (own type because
/// `AssistantTaskScope` isn't `AppEnum`-conformant — it's a pure-domain
/// vocabulary shared with the conversational assistant's authorization
/// layer, and adding a `DisplayRepresentation` there would mean modifying
/// a P5 core file for a Siri-only presentation concern).
public enum AssistantAppIntentTaskScope: String, AppEnum, Sendable {
  case today, tomorrow, inbox, upcoming, anytime, someday, logbook, all

  public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Task List" }
  public static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
    [
      .today: "Today",
      .tomorrow: "Tomorrow",
      .inbox: "Inbox",
      .upcoming: "Upcoming",
      .anytime: "Anytime",
      .someday: "Someday",
      .logbook: "Logbook",
      .all: "All",
    ]
  }

  var assistantTaskScope: AssistantTaskScope {
    switch self {
    case .today: .today
    case .tomorrow: .tomorrow
    case .inbox: .inbox
    case .upcoming: .upcoming
    case .anytime: .anytime
    case .someday: .someday
    case .logbook: .logbook
    case .all: .all
    }
  }
}

/// Vocabulary matches the old app's `WorkoutActivity`
/// (`apps/enchiridion/Sources/EnchiridionWorkoutTransport/WorkoutTransport.swift`)
/// for spoken/UX familiarity only — see this file's header, limitation 3,
/// for why this does NOT correspond to a real workout supertag field yet.
public enum AssistantAppIntentWorkoutActivity: String, AppEnum, Sendable {
  case strengthTraining, outdoorRun, indoorRun, outdoorCycle, indoorCycle, outdoorWalk, hiking, other

  public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Activity" }
  public static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
    [
      .strengthTraining: "Strength Training",
      .outdoorRun: "Outdoor Run",
      .indoorRun: "Indoor Run",
      .outdoorCycle: "Outdoor Cycle",
      .indoorCycle: "Indoor Cycle",
      .outdoorWalk: "Outdoor Walk",
      .hiking: "Hiking",
      .other: "Other",
    ]
  }

  var displayName: String {
    switch self {
    case .strengthTraining: "Strength Training"
    case .outdoorRun: "Outdoor Run"
    case .indoorRun: "Indoor Run"
    case .outdoorCycle: "Outdoor Cycle"
    case .indoorCycle: "Indoor Cycle"
    case .outdoorWalk: "Outdoor Walk"
    case .hiking: "Hiking"
    case .other: "Other"
    }
  }
}

// MARK: - Add a Task

/// Records a DRAFT task via the exact same one-shot, immutable
/// write-proposal path the conversational assistant's write tools use
/// (`AssistantTaskMutationProposal.create` + `AssistantWriteProposalSubmitting.record`).
/// Never auto-confirmed — see this file's header, limitation 2, and
/// `AssistantWriteTools.swift`'s header for the full self-confirm-is-
/// unreachable argument this intent inherits by construction: its only
/// stored recorder-shaped dependency is typed `any AssistantWriteProposalSubmitting`,
/// which has no `confirm`/`reject`/`consumeConfirmed` member at all.
public struct AddEnchiridionTaskIntent: AppIntent {
  public static let title: LocalizedStringResource = "Add a Task"
  public static let description = IntentDescription(
    "Adds a draft task to Enchiridion. Drafts wait for your confirmation in the app — nothing is added to your task list until you confirm it there."
  )
  public static let openAppWhenRun = false

  @Parameter(title: "Title") public var title: String
  @Parameter(title: "Notes") public var notes: String?
  @Parameter(title: "Priority") public var priority: AssistantAppIntentTaskPriority?

  /// Test seam — see this file's header. `nil` in production, which
  /// resolves through `AssistantAppIntentBridge` instead.
  public var proposalRecorder: (any AssistantWriteProposalSubmitting)?

  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("Add a task titled \(\.$title)")
  }

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw AssistantAppIntentError.emptyTitle }

    let draft = AssistantTaskDraft(
      title: trimmed,
      notes: notes,
      priority: priority?.taskPriority
    )
    let callID = AssistantToolCallID(rawValue: "app-intent-add-task-\(UUID().uuidString)")
    let proposal = AssistantTaskMutationProposal.create(callID: callID, draft: draft)

    let recorder = try proposalRecorder ?? AssistantAppIntentBridge.resolveProposalRecorder()
    let recorded = await recorder.record(proposal)
    guard recorded else { throw AssistantAppIntentError.duplicateProposal }

    return .result(
      dialog: IntentDialog(stringLiteral: "Added a draft task — open Enchiridion to confirm it."))
  }
}

// MARK: - What's on my calendar

/// Read-only. Builds a locally-scoped `AssistantCalendarSearchAuthorization`
/// inline (no conversational turn context here — see the plan's P6
/// section: "construct the same `AssistantTurnRetrievalAuthorization`
/// pattern P5 already built"), then calls the exact same
/// `LocalGraphStore.findCalendarEvents` P5 read tool the conversational
/// assistant uses. The response text is the tool's own trusted
/// `spokenText`, assembled via `AssistantGroundingPolicy.groundedResponseUsingTrustedFacts` —
/// the same grounding discipline as the assistant: this intent never
/// constructs its own summary prose from raw data.
public struct WhatsOnMyCalendarIntent: AppIntent {
  public static let title: LocalizedStringResource = "What's on My Calendar"
  public static let description = IntentDescription(
    "Reads back upcoming Enchiridion calendar events without opening the app."
  )
  public static let openAppWhenRun = false

  /// How many days ahead of today to search, inclusive of today. Clamped
  /// to `1...7` in `perform()` — see that method.
  @Parameter(title: "Days Ahead") public var daysAhead: Int?

  /// Test seams — see this file's header.
  public var store: LocalGraphStore?
  public var now: Date?

  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("What's on my calendar for the next \(\.$daysAhead) days")
  }

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    let resolvedStore = try store ?? AssistantAppIntentBridge.resolveStore()
    let referenceNow = now ?? Date()
    let calendar = Calendar.current
    let start = calendar.startOfDay(for: referenceNow)
    let clampedDays = max(1, min(daysAhead ?? 1, 7))
    guard let end = calendar.date(byAdding: .day, value: clampedDays, to: start) else {
      throw AssistantAppIntentError.invalidDateRange
    }

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantCalendarSearchAuthorization(
      query: query,
      start: start,
      end: end,
      maximumResults: AssistantRetrievalLimits.maximumCalendarResults,
      includeOngoing: true
    )
    let results = try resolvedStore.findCalendarEvents(authorization: authorization)

    guard !results.evidence.isEmpty else {
      return .result(dialog: IntentDialog(stringLiteral: AssistantGroundingPolicy.noResults().answer))
    }
    let response = try AssistantGroundingPolicy.groundedResponseUsingTrustedFacts(
      availableFacts: results.evidence, availableSources: results.sources)
    return .result(dialog: IntentDialog(stringLiteral: response.answer))
  }
}

// MARK: - What are my tasks

/// Read-only, same shape as `WhatsOnMyCalendarIntent` above but for
/// `LocalGraphStore.searchTasks`. `scope` is a fixed, closed vocabulary
/// (`AssistantAppIntentTaskScope`, defaulting to `.today`) — never
/// free-form text — matching the plan's P6 guidance ("a fixed scope like
/// `.today`/`.inbox`").
public struct WhatAreMyTasksIntent: AppIntent {
  public static let title: LocalizedStringResource = "What Are My Tasks"
  public static let description = IntentDescription(
    "Reads back a list of Enchiridion tasks without opening the app."
  )
  public static let openAppWhenRun = false

  @Parameter(title: "List") public var scope: AssistantAppIntentTaskScope?

  /// Test seams — see this file's header.
  public var store: LocalGraphStore?
  public var now: Date?

  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("What are my \(\.$scope) tasks")
  }

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    let resolvedStore = try store ?? AssistantAppIntentBridge.resolveStore()
    let resolvedScope = (scope ?? .today).assistantTaskScope

    let query = try AssistantApprovedQuery(originalQuery: "")
    let authorization = try AssistantTaskSearchAuthorization(
      scope: resolvedScope, query: query, maximumResults: AssistantRetrievalLimits.maximumTaskResults)
    let results = try resolvedStore.searchTasks(
      authorization: authorization, candidateScope: resolvedScope, now: now ?? Date())

    guard !results.evidence.isEmpty else {
      return .result(dialog: IntentDialog(stringLiteral: resolvedScope.emptyAnswer))
    }
    let response = try AssistantGroundingPolicy.groundedResponseUsingTrustedFacts(
      availableFacts: results.evidence, availableSources: results.sources)
    return .result(dialog: IntentDialog(stringLiteral: response.answer))
  }
}

// MARK: - Log a Workout

/// Records a DRAFT via the same narrow write-proposal path as
/// `AddEnchiridionTaskIntent` — see this file's header, limitation 3, for
/// why this is currently a labeled draft task rather than a first-class
/// workout record, and what should replace this once a real workout
/// supertag module exists.
public struct LogWorkoutIntent: AppIntent {
  public static let title: LocalizedStringResource = "Log a Workout"
  public static let description = IntentDescription(
    "Logs a workout as a draft in Enchiridion. Enchiridion's dedicated workout tracker isn't built yet, so this is recorded as a draft task pending your confirmation in the app."
  )
  public static let openAppWhenRun = false

  @Parameter(title: "Activity") public var activity: AssistantAppIntentWorkoutActivity
  @Parameter(title: "Duration (minutes)") public var durationMinutes: Int

  /// Test seam — see this file's header.
  public var proposalRecorder: (any AssistantWriteProposalSubmitting)?

  public init() {}

  public static var parameterSummary: some ParameterSummary {
    Summary("Log a \(\.$durationMinutes) minute \(\.$activity) workout")
  }

  public func perform() async throws -> some IntentResult & ProvidesDialog {
    // Bounds match `estimatedMinutes`'s existing 1...600 bound everywhere
    // else it's set in this codebase — the conversational assistant's own
    // model-facing JSON schema (`OpenAIResponsesRequestBuilder.swift`'s
    // `nullableIntegerSchema(minimum: 1, maximum: 600)`) and its local
    // tool dispatcher (`AssistantLocalToolDispatcher.swift`'s
    // `boundedOptionalInt(..., minimum: 1, maximum: 600)`). This draft's
    // `estimatedMinutes` is that exact same field
    // (`AssistantTaskDraft.estimatedMinutes`), so a Siri/Shortcuts-supplied
    // duration gets the identical ceiling a model-authored one already has.
    guard (1...600).contains(durationMinutes) else { throw AssistantAppIntentError.invalidDuration }

    let draft = AssistantTaskDraft(
      title: "Workout: \(activity.displayName)",
      notes: "\(durationMinutes) minute \(activity.displayName.lowercased()) workout, logged via Siri.",
      estimatedMinutes: durationMinutes
    )
    let callID = AssistantToolCallID(rawValue: "app-intent-log-workout-\(UUID().uuidString)")
    let proposal = AssistantTaskMutationProposal.create(callID: callID, draft: draft)

    let recorder = try proposalRecorder ?? AssistantAppIntentBridge.resolveProposalRecorder()
    let recorded = await recorder.record(proposal)
    guard recorded else { throw AssistantAppIntentError.duplicateProposal }

    return .result(
      dialog: IntentDialog(
        stringLiteral:
          "Logged a draft workout — open Enchiridion to confirm it. The dedicated workout tracker is still on the way."
      ))
  }
}

// MARK: - Siri phrase discovery

public struct EnchiridionAssistantAppShortcuts: AppShortcutsProvider {
  public static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddEnchiridionTaskIntent(),
      phrases: ["Add a task in \(.applicationName)"],
      shortTitle: "Add a Task",
      systemImageName: "checklist"
    )
    AppShortcut(
      intent: WhatsOnMyCalendarIntent(),
      phrases: ["What's on my calendar in \(.applicationName)"],
      shortTitle: "Calendar",
      systemImageName: "calendar"
    )
    AppShortcut(
      intent: WhatAreMyTasksIntent(),
      phrases: ["What are my tasks in \(.applicationName)"],
      shortTitle: "Tasks",
      systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: LogWorkoutIntent(),
      phrases: ["Log a workout in \(.applicationName)"],
      shortTitle: "Log Workout",
      systemImageName: "figure.run"
    )
  }
}
