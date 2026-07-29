import EnchiridionCore
import SwiftUI
import UIKit

@MainActor
struct ImmersiveAssistantView: View {
  let session: AssistantConversationSession?
  let unavailableReason: String?

  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var surfaceID = UUID()
  @State private var draft = ""
  @State private var showsTextComposer = false
  @FocusState private var composerIsFocused: Bool

  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Color(uiColor: .systemBackground)
          .ignoresSafeArea()

        AssistantOceanWave(state: waveState)
          .ignoresSafeArea()
          .accessibilityHidden(true)

        VStack(spacing: 0) {
          topControls

          ScrollView {
            VStack(spacing: geometry.size.height < 700 ? 22 : 34) {
              greeting
              status
              exchange
              voiceAvailability
            }
            .frame(maxWidth: 720)
            .padding(.horizontal, horizontalPadding(for: geometry.size.width))
            .padding(.top, geometry.size.height < 700 ? 28 : 58)
            .padding(.bottom, 28)
            .frame(maxWidth: .infinity)
          }
          .scrollIndicators(.hidden)
        }
      }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      bottomControls
    }
    .task(id: surfaceID) { await prepareVoiceSurface() }
    .onDisappear { stopSurface() }
    .onChange(of: scenePhase) { _, phase in
      guard phase != .active, let session else { return }
      Task { await session.stop() }
    }
  }

  private var topControls: some View {
    HStack(spacing: 12) {
      Button {
        guard let session else { return }
        Task { await session.stop() }
      } label: {
        Label("Stop", systemImage: "stop.fill")
      }
      .buttonStyle(.bordered)
      .disabled(session?.isRunning != true)

      Spacer()

      Button {
        Task {
          await session?.stop()
          dismiss()
        }
      } label: {
        Label("Close", systemImage: "xmark")
      }
      .buttonStyle(.bordered)
    }
    .labelStyle(.titleAndIcon)
    .padding(.horizontal, 20)
    .padding(.top, 12)
  }

  private var greeting: some View {
    VStack(spacing: 10) {
      Image(systemName: "waveform")
        .font(.system(size: 28, weight: .medium, design: .rounded))
        .foregroundStyle(.primary)
        .symbolEffect(.pulse, options: .repeating, isActive: session?.isVoiceRunning == true)

      Text("Hello")
        .font(.system(.largeTitle, design: .rounded, weight: .bold))

      Text("Ask about your tasks, calendar, or notes.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
  }

  private var status: some View {
    Label(waveState.title, systemImage: waveState.symbolName)
      .font(.headline)
      .foregroundStyle(.primary)
      .padding(.horizontal, 16)
      .padding(.vertical, 9)
      .background(.regularMaterial, in: .capsule)
      .contentTransition(.symbolEffect(.replace))
      .accessibilityLabel("Assistant status: \(waveState.title)")
  }

  @ViewBuilder
  private var exchange: some View {
    if let turn = session?.turns.last {
      VStack(spacing: 18) {
        Text(turn.utterance)
          .font(.body.weight(.medium))
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)

        Text(turn.answer)
          .font(.title3.weight(.medium))
          .multilineTextAlignment(.center)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
      .transition(.opacity)
      .accessibilityElement(children: .combine)
    } else if session == nil {
      ContentUnavailableView(
        "Assistant Unavailable",
        systemImage: "waveform.slash",
        description: Text(unavailableReason ?? "The on-device assistant is not available.")
      )
    } else {
      Text(emptyPrompt)
        .font(.title3)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .contentTransition(.opacity)
    }
  }

  @ViewBuilder
  private var voiceAvailability: some View {
    if let session {
      switch session.voiceAvailability {
      case .checking:
        availabilityLabel("Checking on-device voice", progress: true)
      case .available:
        EmptyView()
      case .permissionRequired:
        availabilityLabel("Microphone permission is requested only when voice starts.")
      case .permissionDenied:
        VStack(spacing: 10) {
          availabilityLabel("Microphone access is off. You can still type a question.")
          Button("Open Settings", action: openMicrophoneSettings)
            .buttonStyle(.bordered)
        }
      case .installationRequired:
        VStack(spacing: 10) {
          availabilityLabel("Apple's on-device speech model is required for voice.")
          Button("Install Speech Model") {
            Task { await session.installVoiceAssets() }
          }
          .buttonStyle(.borderedProminent)
        }
      case .installing:
        availabilityLabel("Installing on-device speech model", progress: true)
      case .unavailable(let message):
        VStack(spacing: 10) {
          availabilityLabel(message)
          Button("Retry Voice") {
            Task { await session.refreshVoiceAvailability() }
          }
          .buttonStyle(.bordered)
        }
      }
    }
  }

  private func availabilityLabel(_ text: String, progress: Bool = false) -> some View {
    HStack(spacing: 9) {
      if progress { ProgressView().controlSize(.small) }
      Text(text)
        .multilineTextAlignment(.center)
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }

  private var bottomControls: some View {
    VStack(spacing: 10) {
      if showsTextComposer {
        HStack(alignment: .bottom, spacing: 10) {
          TextField("Type a question", text: $draft, axis: .vertical)
            .lineLimit(1...4)
            .textFieldStyle(.plain)
            .focused($composerIsFocused)
            .submitLabel(.send)
            .onSubmit(submitDraft)

          Button(action: submitDraft) {
            Image(systemName: "arrow.up.circle.fill")
              .font(.title2)
          }
          .buttonStyle(.plain)
          .disabled(trimmedDraft.isEmpty || session?.isRunning == true)
          .accessibilityLabel("Send question")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(.background, in: .rect(cornerRadius: 14))
        .transition(.move(edge: .bottom).combined(with: .opacity))
      }

      HStack(spacing: 12) {
        Button(action: toggleVoice) {
          Label(
            session?.isVoiceRunning == true ? "Stop" : "Listen",
            systemImage: session?.isVoiceRunning == true ? "stop.fill" : "mic.fill"
          )
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(session?.isVoiceRunning == true ? .red : .accentColor)
        .disabled(!voiceActionIsAvailable)

        Button(action: toggleTextComposer) {
          Label(
            showsTextComposer ? "Hide Keyboard" : "Type Instead",
            systemImage: showsTextComposer ? "keyboard.chevron.compact.down" : "keyboard"
          )
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(session == nil)
      }
    }
    .frame(maxWidth: 720)
    .padding(.horizontal, 20)
    .padding(.top, 12)
    .padding(.bottom, 10)
    .frame(maxWidth: .infinity)
    .background(.ultraThinMaterial)
  }

  private var waveState: AssistantWaveState {
    guard let session else { return .error(unavailableReason ?? "Assistant unavailable") }
    switch session.state {
    case .idle, .stopped: return .idle
    case .listening: return .listening
    case .thinking: return .thinking
    case .speaking: return .responding
    case .error(let failure): return .error(failure.message)
    }
  }

  private var emptyPrompt: String {
    switch waveState {
    case .idle: "Tap Listen, or type a question."
    case .listening: "I'm listening."
    case .thinking: "Working from your private on-device context."
    case .responding: "Preparing your answer."
    case .error(let message): message
    }
  }

  private var voiceActionIsAvailable: Bool {
    guard let session else { return false }
    if session.isVoiceRunning { return true }
    return session.voiceAvailability == .available
      || session.voiceAvailability == .permissionRequired
  }

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func horizontalPadding(for width: CGFloat) -> CGFloat {
    width >= 760 ? 64 : 24
  }

  private func prepareVoiceSurface() async {
    guard let session else { return }
    await session.activateSurface(surfaceID)
    await session.refreshVoiceAvailability()
    guard !Task.isCancelled else { return }
    await session.startVoice()
  }

  private func stopSurface() {
    guard let session else { return }
    let closingSurfaceID = surfaceID
    Task { await session.stopSurface(closingSurfaceID) }
  }

  private func toggleVoice() {
    guard let session else { return }
    Task {
      if session.isVoiceRunning {
        await session.stop()
      } else {
        showsTextComposer = false
        composerIsFocused = false
        await session.startVoice()
      }
    }
  }

  private func toggleTextComposer() {
    if showsTextComposer {
      composerIsFocused = false
      withAnimation(.easeOut(duration: 0.18)) { showsTextComposer = false }
      return
    }
    Task {
      await session?.stop()
      withAnimation(.easeOut(duration: 0.22)) { showsTextComposer = true }
      composerIsFocused = true
    }
  }

  private func submitDraft() {
    guard let session else { return }
    let utterance = trimmedDraft
    guard !utterance.isEmpty else { return }
    draft = ""
    Task {
      if session.isRunning { await session.stop() }
      await session.submit(utterance)
      composerIsFocused = true
    }
  }

  private func openMicrophoneSettings() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }
}

private enum AssistantWaveState: Equatable {
  case idle
  case listening
  case thinking
  case responding
  case error(String)

  var title: String {
    switch self {
    case .idle: "Ready"
    case .listening: "Listening"
    case .thinking: "Thinking"
    case .responding: "Responding"
    case .error: "Needs Attention"
    }
  }

  var symbolName: String {
    switch self {
    case .idle: "sparkles"
    case .listening: "mic.fill"
    case .thinking: "ellipsis.bubble.fill"
    case .responding: "text.bubble.fill"
    case .error: "exclamationmark.triangle.fill"
    }
  }

  var colors: [Color] {
    switch self {
    case .idle: [.blue, .cyan, .indigo]
    case .listening: [.cyan, .blue, .mint]
    case .thinking: [.indigo, .purple, .blue]
    case .responding: [.mint, .cyan, .blue]
    case .error: [.orange, .red, .pink]
    }
  }

  var amplitude: CGFloat {
    switch self {
    case .idle: 0.035
    case .listening: 0.105
    case .thinking: 0.068
    case .responding: 0.082
    case .error: 0.045
    }
  }

  var speed: Double {
    switch self {
    case .idle: 0.32
    case .listening: 1.1
    case .thinking: 0.72
    case .responding: 0.88
    case .error: 0.2
    }
  }
}

private struct AssistantOceanWave: View {
  let state: AssistantWaveState

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
      Canvas { context, size in
        let background = colorScheme == .dark
          ? Color.black
          : Color(uiColor: .systemBackground)
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(background))

        let time = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate
        for layer in 0..<3 {
          drawWave(layer: layer, time: time, size: size, context: &context)
        }
      }
    }
  }

  private func drawWave(
    layer: Int,
    time: TimeInterval,
    size: CGSize,
    context: inout GraphicsContext
  ) {
    let layerOffset = CGFloat(layer) * size.height * 0.065
    let baseline = size.height * 0.62 + layerOffset
    let amplitude = size.height * state.amplitude * (1 - CGFloat(layer) * 0.16)
    let phase = time * state.speed + Double(layer) * 1.7
    let wavelength = max(size.width * (0.72 + CGFloat(layer) * 0.19), 220)

    var path = Path()
    path.move(to: CGPoint(x: 0, y: baseline))
    for x in stride(from: CGFloat.zero, through: size.width + 8, by: 8) {
      let primary = sin((x / wavelength) * .pi * 2 + phase)
      let harmonic = sin((x / wavelength) * .pi * 4 - phase * 0.55) * 0.28
      path.addLine(to: CGPoint(x: x, y: baseline + (primary + harmonic) * amplitude))
    }
    path.addLine(to: CGPoint(x: size.width, y: size.height))
    path.addLine(to: CGPoint(x: 0, y: size.height))
    path.closeSubpath()

    let colors = state.colors
    let startColor = colors[layer % colors.count].opacity(colorScheme == .dark ? 0.48 : 0.34)
    let endColor = colors[(layer + 1) % colors.count].opacity(colorScheme == .dark ? 0.16 : 0.1)
    context.fill(
      path,
      with: .linearGradient(
        Gradient(colors: [startColor, endColor]),
        startPoint: CGPoint(x: size.width * 0.2, y: baseline - amplitude),
        endPoint: CGPoint(x: size.width * 0.8, y: size.height)
      )
    )
  }
}
