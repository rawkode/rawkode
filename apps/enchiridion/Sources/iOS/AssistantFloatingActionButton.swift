import SwiftUI

struct AssistantFloatingActionButton: View {
  let openTextChat: () -> Void
  let startVoice: () -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var holdProgress = 0.0
  @State private var holdFeedback = 0

  var body: some View {
    ZStack {
      Circle()
        .fill(.ultraThinMaterial)

      Circle()
        .fill(
          LinearGradient(
            colors: [.blue.opacity(0.94), .cyan.opacity(0.82), .indigo.opacity(0.92)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
        .padding(4)

      Image(systemName: "waveform")
        .font(.system(size: 23, weight: .semibold, design: .rounded))
        .foregroundStyle(.white)
        .symbolEffect(.pulse, options: .repeating, isActive: holdProgress > 0)

      Circle()
        .trim(from: 0, to: holdProgress)
        .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .padding(2)
        .accessibilityHidden(true)
    }
    .frame(width: 60, height: 60)
    .contentShape(.circle)
    .shadow(color: .black.opacity(0.18), radius: 6, y: 3)
    .onTapGesture(perform: openTextChat)
    .onLongPressGesture(
      minimumDuration: 0.45,
      maximumDistance: 40,
      perform: completeHold,
      onPressingChanged: updateHold
    )
    .sensoryFeedback(.impact(weight: .medium, intensity: 0.9), trigger: holdFeedback)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Ask Enchiridion")
    .accessibilityHint("Tap for text chat. Touch and hold to start voice.")
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { openTextChat() }
    .accessibilityAction(named: "Start voice") { startVoice() }
  }

  private func updateHold(_ isPressing: Bool) {
    let animation: Animation? = reduceMotion ? nil : .linear(duration: isPressing ? 0.45 : 0.16)
    withAnimation(animation) {
      holdProgress = isPressing ? 1 : 0
    }
  }

  private func completeHold() {
    holdFeedback += 1
    holdProgress = 0
    startVoice()
  }
}
