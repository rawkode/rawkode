import EnchiridionCore
import Foundation

/// Keeps transport and audio ownership paired. Constructing components has no
/// peer, audio, or network side effect; `RealtimeVoiceSession.start()` remains
/// the sole point that can begin an attempt after permission and lease checks.
@MainActor
struct RealtimeVoiceRuntimeComponents {
  let transport: any RealtimeVoiceTransport
  let audioSession: any RealtimeAudioSessionControlling
}

@MainActor
enum RealtimeVoiceRuntimeFactory {
  #if DEBUG
    static let usesExperimentalNativeWebRTC =
      ProcessInfo.processInfo.arguments.contains("--enchiridion-native-webrtc-spike")
  #else
    static let usesExperimentalNativeWebRTC = false
  #endif

  static func makeComponents() -> RealtimeVoiceRuntimeComponents {
    #if DEBUG
      if usesExperimentalNativeWebRTC {
        let runtime = NativeWebRTCCompileTimeSpikeRuntime()
        return .init(transport: runtime, audioSession: runtime)
      }
    #endif
    let runtime = NativeOpenAIRealtimeAudioRuntime()
    return .init(transport: runtime, audioSession: runtime)
  }
}
