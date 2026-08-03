import EnchiridionCore
import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

enum AssistantConversationPresentation: Equatable, Sendable {
  case dismissible
  case embedded
}

struct AssistantConversationView: View {
  let session: AssistantConversationSession?
  let unavailableReason: String?
  let presentation: AssistantConversationPresentation
  let providerSettings: AssistantProviderSettingsController?
  let onOpenProviderSettings: (() -> Void)?

  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var surfaceID = UUID()
  @State private var draft = ""
  @State private var pendingOpenAIConsent: PendingOpenAIConsent?
  @State private var realtimeVoiceLobby: RealtimeVoiceLobbyRoute?
  @State private var followsLatestTurn = true
  @State private var explicitlyAcceptedTurnID: UUID?
  @FocusState private var composerIsFocused: Bool

  private static let starterPrompts = [
    "Hi, how are you?",
    "Review today",
    "Find a note",
  ]

  init(
    session: AssistantConversationSession?,
    unavailableReason: String?,
    presentation: AssistantConversationPresentation = .dismissible,
    providerSettings: AssistantProviderSettingsController? = nil,
    onOpenProviderSettings: (() -> Void)? = nil
  ) {
    self.session = session
    self.unavailableReason = unavailableReason
    self.presentation = presentation
    self.providerSettings = providerSettings
    self.onOpenProviderSettings = onOpenProviderSettings
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("-ShowRealtimeVoiceLobby") {
        _realtimeVoiceLobby = State(
          initialValue: RealtimeVoiceLobbyRoute(
            snapshot: .failedOpenAIRealtime(
              modelID: OpenAIModelCatalog.preferredDefaultRealtimeModelID,
              voiceID: OpenAIRealtimeVoiceCatalog.preferredDefault.id,
              failure: .credentialVerificationRequired
            )
          )
        )
      }
    #endif
  }

  var body: some View {
    NavigationStack {
      Group {
        if let session {
          conversation(session)
        } else {
          ContentUnavailableView(
            "Assistant Unavailable",
            systemImage: "exclamationmark.circle",
            description: Text(unavailableReason ?? "The on-device assistant is not available.")
          )
        }
      }
      .navigationTitle("Assistant")
      .toolbar {
        if presentation == .dismissible {
          ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }
          }
        }
      }
    }
    .task(id: surfaceID) { await prepareSurface() }
    .onChange(of: routeConfigurationIdentity) { _, _ in
      guard let session else { return }
      session.startNewRouteContextImmediately()
    }
    .onDisappear(perform: stopSurface)
    .onChange(of: scenePhase) { _, phase in
      guard let session else { return }
      Task {
        if phase == .active {
          await session.refreshVoiceAvailability()
          await providerSettings?.refreshCredentialState()
        } else {
          await session.handleVoiceSafetyEvent(.appInactive)
        }
      }
    }
    .confirmationDialog(
      "Use OpenAI for Text?",
      isPresented: Binding(
        get: { pendingOpenAIConsent != nil },
        set: { if !$0 { pendingOpenAIConsent = nil } }
      ),
      titleVisibility: .visible
    ) {
      Button(pendingOpenAIConsent?.utterance == nil ? "Use OpenAI for Text" : "Use OpenAI and Send")
      {
        authorizePendingOpenAIConsent()
      }
      Button(pendingOpenAIConsent?.utterance == nil ? "Keep Apple" : "Cancel", role: .cancel) {
        pendingOpenAIConsent = nil
      }
    } message: {
      Text(openAIConsentDisclosure)
    }
    #if os(iOS)
      .fullScreenCover(item: $realtimeVoiceLobby) { lobby in
        realtimeVoiceLobby(lobby, conversationSession: session)
      }
    #else
      .sheet(item: $realtimeVoiceLobby) { lobby in
        realtimeVoiceLobby(lobby, conversationSession: session)
      }
    #endif
  }

  private func realtimeVoiceLobby(
    _ lobby: RealtimeVoiceLobbyRoute,
    conversationSession: AssistantConversationSession?
  ) -> some View {
    RealtimeVoiceLobbyView(
      route: lobby.snapshot,
      onKeepApple: {
        providerSettings?.selectVoiceProvider(.appleOnDevice)
        await conversationSession?.startVoice()
      },
      onOpenSettings: openAppSettings
    )
  }

  private func conversation(_ session: AssistantConversationSession) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if session.turns.isEmpty {
            introduction(session)
          } else {
            ForEach(Array(session.turns.enumerated()), id: \.element.id) { index, turn in
              if index > 0,
                session.turns[index - 1].requestedRoute != turn.requestedRoute
              {
                routeDivider(turn.requestedRouteLabel)
              }

              AssistantTurnView(
                turn: turn,
                onRetry: {
                  reveal(
                    session.retryFailedTurnImmediately(id: turn.id)
                  )
                },
                onRetryOnApple: {
                  reveal(
                    session.retryFailedTurnOnAppleImmediately(id: turn.id)
                  )
                },
                onOpenSettings: openAppSettings
              )
              .id(turn.id)

              if index < session.turns.count - 1 {
                Divider()
                  .padding(.vertical, 28)
              }
            }
          }
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity)
        .animation(
          reduceMotion ? nil : .easeInOut(duration: 0.2), value: session.transcriptRevision)
      }
      #if os(iOS)
        .scrollDismissesKeyboard(.interactively)
      #endif
      .onScrollGeometryChange(for: Bool.self) { geometry in
        geometry.contentSize.height <= geometry.containerSize.height
          || geometry.visibleRect.maxY >= geometry.contentSize.height - 32
      } action: { _, isAtBottom in
        followsLatestTurn = isAtBottom
      }
      .onChange(of: session.transcriptRevision) { _, _ in
        guard followsLatestTurn, let turnID = session.turns.last?.id else { return }
        scroll(to: turnID, using: proxy)
      }
      .onChange(of: explicitlyAcceptedTurnID) { _, turnID in
        guard let turnID else { return }
        followsLatestTurn = true
        scroll(to: turnID, using: proxy)
        explicitlyAcceptedTurnID = nil
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer(session)
    }
    .onChange(of: lifecycleAnnouncement(for: session)) { _, announcement in
      guard let announcement else { return }
      postAccessibilityAnnouncement(announcement.message)
    }
  }

  private func scroll(to turnID: UUID, using proxy: ScrollViewProxy) {
    if reduceMotion {
      proxy.scrollTo(turnID, anchor: .bottom)
    } else {
      withAnimation(.easeInOut(duration: 0.2)) {
        proxy.scrollTo(turnID, anchor: .bottom)
      }
    }
  }

  private func reveal(_ turnID: UUID?) {
    guard let turnID else { return }
    explicitlyAcceptedTurnID = turnID
  }

  private func lifecycleAnnouncement(
    for session: AssistantConversationSession
  ) -> AssistantLifecycleAnnouncement? {
    guard let turn = session.turns.last, turn.modality == .text else { return nil }
    let message =
      switch turn.phase {
      case .pending:
        "Assistant is thinking with \(turn.requestedRouteLabel)"
      case .completed:
        "Assistant response completed: \(turn.answer)"
      case .failed:
        "Assistant response failed: \(turn.answer)"
      case .cancelled:
        "Assistant response stopped"
      }
    return AssistantLifecycleAnnouncement(turnID: turn.id, phase: turn.phase, message: message)
  }

  private func postAccessibilityAnnouncement(_ message: String) {
    #if os(macOS)
      NSAccessibility.post(
        element: NSApplication.shared,
        notification: .announcementRequested,
        userInfo: [
          .announcement: message,
          .priority: NSAccessibilityPriorityLevel.medium.rawValue,
        ]
      )
    #else
      UIAccessibility.post(notification: .announcement, argument: message)
    #endif
  }

  private func composer(_ session: AssistantConversationSession) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      providerMenu(session)

      if session.state == .listening, !session.liveTranscript.isEmpty {
        Text(session.liveTranscript)
          .font(.body)
          .lineLimit(2...3)
          .frame(maxWidth: .infinity, alignment: .leading)
          .privacySensitive()
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("Live transcription")
          .accessibilityValue(session.liveTranscript)
      }

      composerStatus(session)

      HStack(alignment: .bottom, spacing: 8) {
        TextField("Ask about tasks, notes, or your day", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .textFieldStyle(.plain)
          .focused($composerIsFocused)
          .onSubmit { submit(draft, to: session) }
          .accessibilityLabel("Message")

        if !session.isVoiceRunning {
          voiceButton(session)
        }

        if session.isRunning {
          Button {
            Task { await session.stop() }
          } label: {
            Label("Stop", systemImage: "stop.fill")
              .labelStyle(.iconOnly)
              .frame(minWidth: 20, minHeight: 20)
          }
          .buttonStyle(.bordered)
          .buttonBorderShape(.circle)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityLabel("Stop response")
        } else {
          Button {
            submit(draft, to: session)
          } label: {
            Label("Send", systemImage: "arrow.up")
              .labelStyle(.iconOnly)
              .frame(minWidth: 20, minHeight: 20)
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.circle)
          .frame(minWidth: 44, minHeight: 44)
          .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("Send message")
        }
      }
    }
    .frame(maxWidth: 720, alignment: .leading)
    .padding(.horizontal, 24)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity)
    .background(.background)
    .overlay(alignment: .top) { Divider() }
  }

  private func voiceButton(_ session: AssistantConversationSession) -> some View {
    Button {
      if providerSettings?.selectedVoiceProvider == .openAIRealtime {
        guard let providerSettings else { return }
        realtimeVoiceLobby = RealtimeVoiceLobbyRoute(
          snapshot: providerSettings.voiceRouteSnapshot()
        )
      } else {
        Task { await session.startVoice() }
      }
    } label: {
      Group {
        if !session.isVoiceRunning
          && (session.voiceAvailability == .checking || session.voiceAvailability == .installing)
        {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: "mic.fill")
        }
      }
      .frame(minWidth: 20, minHeight: 20)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.circle)
    .tint(.accentColor)
    .frame(minWidth: 44, minHeight: 44)
    .disabled(voiceButtonIsDisabled(session))
    .accessibilityLabel(voiceButtonAccessibilityLabel(session))
    .accessibilityHint(
      voiceButtonAccessibilityHint(session)
    )
  }

  @ViewBuilder
  private func composerStatus(_ session: AssistantConversationSession) -> some View {
    if let pauseReason = session.voicePauseReason,
      session.state == .idle || session.state == .stopped
    {
      Label(pauseReason.message, systemImage: "mic.slash")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    } else if let notice = session.voiceInputNotice {
      Label(notice, systemImage: "mic.slash")
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    } else if session.isVoiceRunning {
      HStack(spacing: 10) {
        VoiceActivityOrb(activity: session.voiceActivity, diameter: 32)
        Text(voiceActivityLabel(session.voiceActivity))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .contain)
    } else {
      switch session.state {
      case .listening:
        activityStatus("Listening…", systemImage: "mic.fill")
      case .thinking:
        let routeLabel =
          session.isVoiceRunning
          ? "Apple On Device"
          : session.turns.last?.requestedRouteLabel ?? currentRouteLabel
        Label(
          "Responding with \(routeLabel)",
          systemImage: "arrow.up.circle"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Response in progress")
      case .speaking:
        activityStatus("Speaking…", systemImage: "speaker.fill")
      case .error(let failure):
        if session.turns.last?.answer != failure.message {
          Label(failure.message, systemImage: "exclamationmark.circle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
      case .idle, .stopped:
        voiceAvailabilityStatus(session)
      }
    }
  }

  private func voiceActivityLabel(_ activity: VoiceActivitySnapshot) -> String {
    VoiceActivityOrb.semanticDescription(activity)
  }

  @ViewBuilder
  private func activityStatus(_ text: String, systemImage: String? = nil) -> some View {
    HStack(spacing: 6) {
      if let systemImage {
        Image(systemName: systemImage)
      } else {
        ProgressView()
          .controlSize(.small)
      }
      Text(text)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func voiceAvailabilityStatus(_ session: AssistantConversationSession) -> some View {
    switch session.voiceAvailability {
    case .permissionRequired:
      EmptyView()
    case .permissionDenied:
      availabilityAction("Microphone or Speech Recognition access is off.") {
        Button("Open Settings") { openPrivacySettings() }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .installationRequired:
      availabilityAction("Voice needs Apple's on-device speech model.") {
        Button("Install model") { Task { await session.installVoiceAssets() } }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .unavailable(let message):
      availabilityAction(message) {
        Button("Retry") { Task { await session.refreshVoiceAvailability() } }
          .buttonStyle(.plain)
          .foregroundStyle(.tint)
      }
    case .checking, .available, .installing:
      EmptyView()
    }
  }

  private func availabilityAction<Content: View>(
    _ message: String,
    @ViewBuilder action: () -> Content
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(message)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      action()
        .fontWeight(.medium)
        .frame(minHeight: 44)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  private func introduction(_ session: AssistantConversationSession) -> some View {
    VStack(alignment: .leading, spacing: 28) {
      VStack(alignment: .leading, spacing: 8) {
        Text("How can I help?")
          .font(.title2.weight(.semibold))
        Text(introductionDetail)
          .font(.body)
          .foregroundStyle(.secondary)
      }

      VStack(alignment: .leading, spacing: 0) {
        Text("Try asking")
          .font(.caption)
          .foregroundStyle(.secondary)
          .padding(.bottom, 6)

        ForEach(Array(Self.starterPrompts.enumerated()), id: \.offset) { index, prompt in
          Button {
            submit(prompt, to: session)
          } label: {
            HStack(spacing: 12) {
              Text(prompt)
              Spacer(minLength: 16)
              Image(systemName: "arrow.up.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(.rect)
          }
          .buttonStyle(.plain)
          .disabled(session.isRunning)
          .accessibilityHint("Submits this question")

          if index < Self.starterPrompts.count - 1 {
            Divider()
          }
        }
      }
    }
    .frame(maxWidth: 520, alignment: .leading)
  }

  private func submit(_ value: String, to session: AssistantConversationSession) {
    let utterance = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !utterance.isEmpty, !session.isRunning else { return }
    if let providerSettings,
      providerSettings.selectedProvider == .openAI,
      !providerSettings.hasTextConsent,
      let modelID = providerSettings.selectedTextModelID
    {
      pendingOpenAIConsent = PendingOpenAIConsent(modelID: modelID, utterance: utterance)
      return
    }
    guard
      let acceptedTurnID = session.submitImmediately(
        utterance,
        routeOverride: currentConversationRoute,
        routeLabel: currentRouteLabel,
        routeSnapshot: currentTextRouteSnapshot
      )
    else { return }
    explicitlyAcceptedTurnID = acceptedTurnID
    draft = ""
    composerIsFocused = true
  }

  private func canStartVoice(_ availability: AssistantVoiceAvailability) -> Bool {
    availability == .available || availability == .permissionRequired
  }

  private func voiceButtonIsDisabled(_ session: AssistantConversationSession) -> Bool {
    if providerSettings?.selectedVoiceProvider == .openAIRealtime {
      return session.isRunning || providerSettings == nil
    }
    if session.isVoiceRunning { return false }
    return session.isRunning || !canStartVoice(session.voiceAvailability)
  }

  private func voiceButtonAccessibilityLabel(_ session: AssistantConversationSession) -> String {
    if providerSettings?.selectedVoiceProvider == .openAIRealtime {
      return "Open OpenAI Voice lobby"
    }
    return "Listen"
  }

  private func voiceButtonAccessibilityHint(_ session: AssistantConversationSession) -> String {
    if providerSettings?.selectedVoiceProvider == .openAIRealtime {
      return "Opens a lobby without requesting microphone access, reading the key, or connecting."
    }
    return "Starts an Apple On Device voice conversation. Microphone audio never goes to OpenAI."
  }

  private func prepareSurface() async {
    guard let session else { return }
    if presentation == .dismissible {
      await session.activateSurface(surfaceID)
    }
    await session.refreshVoiceAvailability()
    await providerSettings?.refreshCredentialState()
  }

  private func stopSurface() {
    guard let session else { return }
    let closingSurfaceID = surfaceID
    Task {
      switch presentation {
      case .dismissible:
        await session.stopSurface(closingSurfaceID)
      case .embedded:
        await session.stop()
      }
    }
  }

  private func openPrivacySettings() {
    #if os(macOS)
      guard let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")
      else { return }
      NSWorkspace.shared.open(url)
    #else
      guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
      UIApplication.shared.open(url)
    #endif
  }

  private var routeConfigurationIdentity: String {
    guard let providerSettings else { return "apple" }
    return [
      providerSettings.selectedProvider.rawValue,
      providerSettings.selectedTextModelID ?? "none",
      providerSettings.credentialState.rawValue,
      providerSettings.hasTextConsent ? "consented" : "blocked",
    ].joined(separator: ":")
  }

  private var currentRouteLabel: String {
    guard let providerSettings, providerSettings.selectedProvider == .openAI else {
      return "Apple On Device"
    }
    guard let modelID = providerSettings.selectedTextModelID else { return "OpenAI · Setup needed" }
    let title = OpenAIModelCatalog.textOptions.first(where: { $0.id == modelID })?.title ?? modelID
    return "OpenAI · \(title)"
  }

  private var currentConversationRoute: AssistantConversationRoute {
    guard let providerSettings, providerSettings.selectedProvider == .openAI else {
      return .appleOnDevice
    }
    return AssistantConversationRoute(
      provider: .openAI,
      modelID: providerSettings.selectedTextModelID
    )
  }

  private var currentTextRouteSnapshot: AssistantTextRouteSnapshot {
    providerSettings?.textRouteSnapshot(for: currentConversationRoute)
      ?? AssistantTextRouteSnapshot(provider: .appleOnDevice)
  }

  private var introductionDetail: String {
    if providerSettings?.selectedProvider == .openAI {
      return "Chat naturally with OpenAI. This route sends your submitted text and bounded OpenAI chat history, but no notes, tasks, calendar events, or other local library data."
    }
    return "Chat naturally, or ask about your tasks, calendar, or notes — on device."
  }

  private func providerMenu(_ session: AssistantConversationSession) -> some View {
    Menu {
      Button {
        providerSettings?.selectProvider(.appleOnDevice)
      } label: {
        if providerSettings?.selectedProvider != .openAI {
          Label("Apple On Device", systemImage: "checkmark")
        } else {
          Text("Apple On Device")
        }
      }

      if let providerSettings {
        ForEach(providerSettings.verifiedTextOptions) { model in
          Button {
            chooseOpenAI(modelID: model.id)
          } label: {
            let isSelected =
              providerSettings.selectedProvider == .openAI
              && providerSettings.selectedTextModelID == model.id
            if isSelected {
              Label("OpenAI · \(model.title)", systemImage: "checkmark")
            } else {
              Text("OpenAI · \(model.title)")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: providerSettings?.selectedProvider == .openAI ? "sparkles" : "apple.logo")
        Text(currentRouteLabel)
        if providerSettings?.selectedProvider == .openAI,
          providerSettings?.textRouteSnapshot().authorizationFailure != nil
        {
          Image(systemName: "exclamationmark.circle.fill")
            .foregroundStyle(.orange)
        }
        Image(systemName: "chevron.up.chevron.down")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      .font(.caption.weight(.medium))
      .frame(minHeight: 44)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .disabled(session.isRunning || providerSettings == nil)
    .accessibilityLabel("Text provider, \(currentRouteLabel)")
  }

  private func chooseOpenAI(modelID: String) {
    guard let providerSettings else { return }
    if providerSettings.hasTextConsent {
      providerSettings.selectTextModel(id: modelID)
      providerSettings.selectProvider(.openAI)
    } else {
      pendingOpenAIConsent = PendingOpenAIConsent(modelID: modelID, utterance: nil)
    }
  }

  private func authorizePendingOpenAIConsent() {
    guard let pending = pendingOpenAIConsent, let providerSettings else { return }
    pendingOpenAIConsent = nil
    guard providerSettings.authorizeOpenAITextAndSelect(modelID: pending.modelID) else {
      openAppSettings()
      return
    }
    if let utterance = pending.utterance, let session {
      session.startNewRouteContextImmediately()
      guard
        let acceptedTurnID = session.submitImmediately(
          utterance,
          routeOverride: currentConversationRoute,
          routeLabel: currentRouteLabel,
          routeSnapshot: currentTextRouteSnapshot
        )
      else { return }
      explicitlyAcceptedTurnID = acceptedTurnID
      draft = ""
      composerIsFocused = true
    }
  }

  private var openAIConsentDisclosure: String {
    """
    Enchiridion will send the current typed text or dictated text you submit and bounded OpenAI text-chat history directly from this device to OpenAI. This route does not send notes, tasks, calendar events, or other local library data, and does not provide local tools. Your API key stays in this device's Keychain. Requests use store:false, though OpenAI may retain abuse-monitoring data for up to 30 days. API usage is billed separately from ChatGPT. Text consent does not authorize microphone access or OpenAI Voice; voice requires separate explicit consent. CarPlay and App Intents always use Apple On Device.
    """
  }

  private func routeDivider(_ label: String) -> some View {
    HStack(spacing: 10) {
      Rectangle().frame(height: 1).foregroundStyle(.quaternary)
      Text("Text provider changed to \(label)")
        .font(.caption2)
        .foregroundStyle(.secondary)
      Rectangle().frame(height: 1).foregroundStyle(.quaternary)
    }
    .padding(.vertical, 20)
    .accessibilityElement(children: .combine)
  }

  private func openAppSettings() {
    if let onOpenProviderSettings {
      onOpenProviderSettings()
      return
    }
    #if os(macOS)
      NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    #endif
  }
}

/// A compact semantic visual for concurrent voice activity. Colour supports,
/// rather than replaces, the accessible state value.
struct VoiceActivityOrb: View {
  let activity: VoiceActivitySnapshot
  var diameter: CGFloat = 44

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let level = max(activity.inputLevel, activity.outputLevel)
    let scale = 0.78 + (reduceMotion ? discreteLevel(level) : level) * 0.22
    ZStack {
      Circle().fill(.quaternary)
      if activity.isListening { Circle().fill(Color.indigo.opacity(0.82)).padding(diameter * 0.18) }
      if activity.isPreparingResponse { Circle().fill(Color.purple.opacity(0.74)).padding(diameter * 0.30) }
      if activity.isResponding { Circle().fill(Color.teal.opacity(0.82)).padding(diameter * 0.42) }
    }
    .frame(width: diameter, height: diameter)
    .scaleEffect(scale)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: level)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Voice activity")
    .accessibilityValue(accessibilityValue)
  }

  static func semanticDescription(_ activity: VoiceActivitySnapshot) -> String {
    var states: [String] = []
    if activity.isListening { states.append("Listening") }
    if activity.isPreparingResponse { states.append("Preparing response") }
    if activity.isResponding { states.append("Responding") }
    return states.isEmpty ? "Inactive" : states.joined(separator: " · ")
  }

  private var accessibilityValue: String { Self.semanticDescription(activity) }

  private func discreteLevel(_ value: Double) -> CGFloat {
    switch value {
    case 0..<0.15: 0
    case 0..<0.55: 0.5
    default: 1
    }
  }
}

private struct AssistantTurnView: View {
  let turn: AssistantConversationTurn
  let onRetry: () -> Void
  let onRetryOnApple: () -> Void
  let onOpenSettings: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showsDetails = false

  var body: some View {
    VStack(spacing: 14) {
      HStack {
        Spacer(minLength: 36)
        Text(turn.utterance)
          .font(.body)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .foregroundStyle(.primary)
          .background(.tint.opacity(0.14), in: .rect(cornerRadius: 18))
          .frame(maxWidth: 560, alignment: .trailing)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("You: \(turn.utterance)")

      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "sparkles")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tint)
          .frame(width: 28, height: 28)
          .background(.tint.opacity(0.12), in: .circle)
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 10) {
          VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
              Text("Assistant")
                .font(.caption.weight(.semibold))
              Text(turn.requestedRouteLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
            }

            assistantContent
          }
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(assistantAccessibilityLabel)

          if turn.phase != .pending, let metadata = turn.metadata {
            VStack(alignment: .leading, spacing: 8) {
              HStack(spacing: 8) {
                if let usage = metadata.usage {
                  Text("\(usage.total) tokens")
                } else if metadata.requestedProvider == .openAI {
                  Text("Usage unavailable")
                }
                if metadata.localContextCount > 0 {
                  Text(
                    metadata.completion == .completed
                      ? "\(metadata.localContextCount) local sources"
                      : "\(metadata.localContextCount) local sources disclosed"
                  )
                }
              }
              .font(.caption)
              .foregroundStyle(.secondary)

              if !turn.sources.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                  HStack(spacing: 6) {
                    ForEach(turn.sources) { source in
                      Label(
                        source.title,
                        systemImage: source.kind == .calendarEvent ? "calendar" : "doc.text"
                      )
                      .font(.caption2)
                      .padding(.horizontal, 8)
                      .padding(.vertical, 5)
                      .background(.quaternary, in: .capsule)
                    }
                  }
                }
              }

              DisclosureGroup("Response details", isExpanded: $showsDetails) {
                VStack(alignment: .leading, spacing: 4) {
                  if let usage = metadata.usage {
                    Text(
                      "Input \(usage.input) · Cached \(usage.cachedInput) · Cache write \(usage.cacheWrite) · Output \(usage.output) · Total \(usage.total)"
                    )
                  } else {
                    Text("Usage unavailable")
                  }
                  if let model = metadata.actualModelID {
                    Text("Actual model: \(model)").textSelection(.enabled)
                  } else if let requestedModel = metadata.requestedModelID {
                    Text("Requested model: \(requestedModel)").textSelection(.enabled)
                  }
                  ForEach(metadata.requestIDs, id: \.self) { requestID in
                    Text("Request ID: \(requestID)").textSelection(.enabled)
                  }
                }
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
              }
              .font(.caption)

              if metadata.completion != .completed {
                recoveryActions(metadata)
              }
            }
          }
        }
        .padding(14)
        .frame(maxWidth: 620, alignment: .leading)
        .background(assistantBackground, in: .rect(cornerRadius: 18))
        .accessibilityElement(children: .contain)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: turn.phase)

        Spacer(minLength: 20)
      }
    }
    .privacySensitive()
  }

  @ViewBuilder
  private var assistantContent: some View {
    switch turn.phase {
    case .pending:
      HStack(spacing: 8) {
        ProgressView()
          .controlSize(.small)
        Text("Thinking…")
      }
      .font(.body)
      .foregroundStyle(.secondary)
    case .cancelled:
      Label("Response stopped", systemImage: "stop.circle")
        .font(.body)
        .foregroundStyle(.secondary)
    case .failed:
      Label {
        Text(turn.answer)
          .textSelection(.enabled)
      } icon: {
        Image(systemName: "exclamationmark.circle.fill")
      }
      .font(.body)
      .foregroundStyle(.orange)
    case .completed:
      Text(turn.answer)
        .font(.body)
        .lineSpacing(3)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder
  private func recoveryActions(_ metadata: AssistantResponseMetadata) -> some View {
    switch metadata.recoveryAction {
    case .retry:
      VStack(alignment: .leading, spacing: 8) {
        Button("Try Again", action: onRetry)
          .buttonStyle(.borderedProminent)
          .frame(minHeight: 44)
          .contentShape(.rect)
          .accessibilityLabel("Try again on \(turn.requestedRouteLabel)")
          .accessibilityHint("Adds a new attempt and keeps this receipt unchanged.")
        if metadata.requestedProvider == .openAI {
          Button("Retry on Apple On Device", action: onRetryOnApple)
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .contentShape(.rect)
            .accessibilityHint(
              "Adds a separate on-device attempt and keeps this OpenAI receipt unchanged."
            )
        }
      }
    case .openSettings:
      Button("Open Settings", action: onOpenSettings)
        .buttonStyle(.bordered)
        .frame(minHeight: 44)
        .contentShape(.rect)
        .accessibilityLabel("Open Assistant Providers settings")
        .accessibilityHint("Review the OpenAI key, consent, model, billing, and limits.")
    case nil:
      EmptyView()
    }
  }

  private var assistantBackground: some ShapeStyle {
    switch turn.phase {
    case .failed:
      AnyShapeStyle(Color.orange.opacity(0.1))
    case .pending, .completed, .cancelled:
      AnyShapeStyle(.quaternary)
    }
  }

  private var assistantAccessibilityLabel: String {
    switch turn.phase {
    case .pending:
      "Assistant is thinking with \(turn.requestedRouteLabel)"
    case .completed:
      "Assistant: \(turn.answer)"
    case .failed:
      "Assistant could not complete the response: \(turn.answer)"
    case .cancelled:
      "Assistant response stopped"
    }
  }
}

private struct PendingOpenAIConsent {
  let modelID: String
  let utterance: String?
}

private struct AssistantLifecycleAnnouncement: Equatable {
  let turnID: UUID
  let phase: AssistantConversationTurnPhase
  let message: String
}
