import AVFoundation
import EnchiridionCore
import Foundation

/// Reusable Apple-platform speech output for the platform-neutral conversation session.
struct AVSpeechSynthesizerConversationSpeaker: AssistantConversationSpeaking {
  private let driver: AVSpeechSynthesizerDriver

  @MainActor
  init() {
    driver = AVSpeechSynthesizerDriver()
  }

  func speak(_ text: String) async throws {
    try await driver.speak(text)
  }

  func stop() async {
    await driver.stop()
  }

  @MainActor
  func stopImmediately() {
    driver.stop()
  }
}

@MainActor
private final class AVSpeechSynthesizerDriver: NSObject {
  private let synthesizer = AVSpeechSynthesizer()
  private var continuation: CheckedContinuation<Void, Never>?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func speak(_ text: String) async throws {
    guard !text.isEmpty else { return }
    try Task.checkCancellation()

    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        self.continuation = continuation
        synthesizer.speak(utterance)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.stop() }
    }
    try Task.checkCancellation()
  }

  func stop() {
    synthesizer.stopSpeaking(at: .immediate)
    finish()
  }

  private func finish() {
    continuation?.resume()
    continuation = nil
  }
}

extension AVSpeechSynthesizerDriver: @preconcurrency AVSpeechSynthesizerDelegate {
  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    finish()
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    finish()
  }
}
