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
      Task { await session.startNewRouteContext() }
    }
    .onDisappear(perform: stopSurface)
    .onChange(of: scenePhase) { _, phase in
      guard let session else { return }
      Task {
        if phase == .active {
          await session.refreshVoiceAvailability()
          await providerSettings?.refreshCredentialState()
        } else {
          #if os(iOS)
            await session.handleVoiceSafetyEvent(.appInactive)
          #else
            await session.stop()
          #endif
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
  }

  private func conversation(_ session: AssistantConversationSession) -> some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if session.turns.isEmpty {
            introduction(session)
          } else {
            ForEach(Array(session.turns.enumerated()), id: \.offset) { index, turn in
              if index > 0,
                session.turns[index - 1].metadata?.routeContextIdentity
                  != turn.metadata?.routeContextIdentity
              {
                routeDivider(turn.metadata?.routeLabel ?? "Assistant")
              }

              AssistantTurnView(
                turn: turn,
                onRetry: { Task { await session.retryFailedTurn(at: index) } },
                onRetryOnApple: { Task { await session.retryFailedTurnOnApple(at: index) } },
                onOpenSettings: openAppSettings
              )
              .id(index)

              if index < session.turns.count - 1 {
                Divider()
                  .padding(.vertical, 28)
              }
            }
          }
          if let pending = session.pendingUtterance {
            AssistantPendingTurnView(
              utterance: pending,
              routeLabel: routeLabel(for: session.pendingRoute) ?? currentRouteLabel
            )
            .id("pending")
          }
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity)
      }
      .onChange(of: session.turns.count) { _, count in
        guard count > 0 else { return }
        if reduceMotion {
          proxy.scrollTo(count - 1, anchor: .bottom)
        } else {
          withAnimation(.smooth(duration: 0.2)) {
            proxy.scrollTo(count - 1, anchor: .bottom)
          }
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      composer(session)
    }
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

        voiceButton(session)

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
        .disabled(
          draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.isRunning
        )
        .accessibilityLabel("Send message")

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
      if session.isVoiceRunning {
        Task { await session.stop() }
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
          Image(systemName: session.isVoiceRunning ? "stop.fill" : "mic.fill")
        }
      }
      .frame(minWidth: 20, minHeight: 20)
    }
    .buttonStyle(.bordered)
    .buttonBorderShape(.circle)
    .tint(session.isVoiceRunning ? .red : .accentColor)
    .frame(minWidth: 44, minHeight: 44)
    .disabled(voiceButtonIsDisabled(session))
    .accessibilityLabel(session.isVoiceRunning ? "Stop voice conversation" : "Listen")
    .accessibilityHint(
      session.isVoiceRunning
        ? "Stops listening and speech"
        : "Starts an Apple On Device voice conversation. Microphone audio never goes to OpenAI."
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
    } else {
      switch session.state {
      case .listening:
        activityStatus("Listening…", systemImage: "mic.fill")
      case .thinking:
        activityStatus("Thinking…")
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
    draft = ""
    Task {
      await session.submit(utterance)
      composerIsFocused = true
    }
  }

  private func canStartVoice(_ availability: AssistantVoiceAvailability) -> Bool {
    availability == .available || availability == .permissionRequired
  }

  private func voiceButtonIsDisabled(_ session: AssistantConversationSession) -> Bool {
    if session.isVoiceRunning { return false }
    return session.isRunning || !canStartVoice(session.voiceAvailability)
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

  private func routeLabel(for route: AssistantConversationRoute?) -> String? {
    guard let route else { return nil }
    guard route.provider == .openAI else { return "Apple On Device" }
    guard let modelID = route.modelID else { return "OpenAI · Setup needed" }
    let title = OpenAIModelCatalog.textOptions.first(where: { $0.id == modelID })?.title ?? modelID
    return "OpenAI · \(title)"
  }

  private var introductionDetail: String {
    if providerSettings?.selectedProvider == .openAI {
      return "Chat naturally, or ask about bounded matching tasks, calendar events, and notes."
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
      draft = ""
      Task {
        await session.startNewRouteContext()
        await session.submit(utterance)
      }
    }
  }

  private var openAIConsentDisclosure: String {
    """
    Enchiridion will send the current typed text or dictated text you submit, recent OpenAI text-chat history, and bounded matching task, note, or calendar context directly from this device to OpenAI. Your API key stays in this device's Keychain. Requests use store:false, though OpenAI may retain abuse-monitoring data for up to 30 days. API usage is billed separately from ChatGPT. Microphone audio, Enchiridion Voice, CarPlay, and App Intents remain Apple On Device.
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

private struct AssistantTurnView: View {
  let turn: AssistantConversationTurn
  let onRetry: () -> Void
  let onRetryOnApple: () -> Void
  let onOpenSettings: () -> Void
  @State private var showsDetails = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 5) {
        Text("You")
          .font(.caption)
          .foregroundStyle(.secondary)

        Text(turn.utterance)
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .accessibilityElement(children: .combine)

      Text(turn.answer)
        .font(.body)
        .lineSpacing(3)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel("Assistant: \(turn.answer)")

      if let metadata = turn.metadata {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Text(metadata.routeLabel)
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
            switch metadata.recoveryAction {
            case .retry:
              VStack(alignment: .leading, spacing: 8) {
                Button("Try Again", action: onRetry)
                  .buttonStyle(.borderedProminent)
                  .frame(minHeight: 44)
                  .contentShape(.rect)
                  .accessibilityLabel("Try again on \(metadata.routeLabel)")
                  .accessibilityHint("Adds a new attempt and keeps this failed receipt unchanged.")
                if metadata.requestedProvider == .openAI {
                  Button("Retry on Apple On Device", action: onRetryOnApple)
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .accessibilityHint(
                      "Adds a separate on-device attempt and keeps this OpenAI failure unchanged."
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
        }
      }
    }
  }
}

private struct AssistantPendingTurnView: View {
  let utterance: String
  let routeLabel: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("You")
        .font(.caption)
        .foregroundStyle(.secondary)
      Text(utterance)
        .font(.body.weight(.semibold))
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Waiting for \(routeLabel)…")
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .privacySensitive()
  }
}

private struct PendingOpenAIConsent {
  let modelID: String
  let utterance: String?
}
