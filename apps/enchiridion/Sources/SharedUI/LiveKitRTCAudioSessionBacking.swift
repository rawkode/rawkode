#if os(iOS)
  import AVFoundation
  @preconcurrency import LiveKitWebRTC

  /// The only LiveKit audio-session surface used by the native WebRTC path.
  /// Calls must configure the SDK while it owns its configuration lock; the
  /// application-level lease remains owned by
  /// `HandheldConversationAudioSessionController`.
  protocol LiveKitRTCAudioSessionBacking: HandheldConversationAudioSessionBacking {
    func configureManualAudioDisabled()
    func setAudioEnabled(_ enabled: Bool)
  }

  final class SystemLiveKitRTCAudioSessionBacking:
    LiveKitRTCAudioSessionBacking, @unchecked Sendable
  {
    private let audioSession: LKRTCAudioSession

    init(audioSession: LKRTCAudioSession = .sharedInstance()) {
      self.audioSession = audioSession
    }

    func configureManualAudioDisabled() {
      audioSession.lockForConfiguration()
      defer { audioSession.unlockForConfiguration() }
      audioSession.useManualAudio = true
      audioSession.isAudioEnabled = false
    }

    func setAudioEnabled(_ enabled: Bool) {
      audioSession.lockForConfiguration()
      defer { audioSession.unlockForConfiguration() }
      audioSession.isAudioEnabled = enabled
    }

    func setCategory(
      _ category: AVAudioSession.Category,
      mode: AVAudioSession.Mode,
      options: AVAudioSession.CategoryOptions
    ) throws {
      audioSession.lockForConfiguration()
      defer { audioSession.unlockForConfiguration() }
      try audioSession.setCategory(category, mode: mode, options: options)
    }

    func setActive(_ active: Bool, options _: AVAudioSession.SetActiveOptions) throws {
      audioSession.lockForConfiguration()
      defer { audioSession.unlockForConfiguration() }
      try audioSession.setActive(active)
    }

    func activateConfigured() async throws { try setActive(true, options: []) }
    func deactivateConfigured() async throws { try setActive(false, options: [.notifyOthersOnDeactivation]) }
  }
#endif
