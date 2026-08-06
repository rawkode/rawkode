#if os(iOS)
  import EnchiridionCore
  import Foundation

  private actor LiveKitRTCDeactivationGate {
    private var result: RealtimeAudioSessionDeactivationResult?
    private var waiter: CheckedContinuation<RealtimeAudioSessionDeactivationResult, Never>?
    func resolve(_ result: RealtimeAudioSessionDeactivationResult) {
      guard self.result == nil else { return }
      self.result = result; let waiter = waiter; self.waiter = nil; waiter?.resume(returning: result)
    }
    func wait() async -> RealtimeAudioSessionDeactivationResult {
      if let result { return result }
      return await withCheckedContinuation { waiter = $0 }
    }
  }

  /// Adds LiveKit's manual-audio gate to the single handheld audio-session
  /// controller. This deliberately does not own an AVAudioSession lease and
  /// does not represent microphone mute: muting detaches a sender/source.
  @MainActor
  final class LiveKitRTCManagedAudioSessionController: RealtimeAudioSessionControlling {
    private enum Phase { case idle, activating, active, deactivating, terminal }

    private let controller: any RealtimeAudioSessionControlling
    private let rtcAudio: any LiveKitRTCAudioSessionBacking
    private var phase: Phase = .idle
    private var operationGeneration: UInt64 = 0
    private var activationDeactivationGate: LiveKitRTCDeactivationGate?

    init(
      controller: (any RealtimeAudioSessionControlling)? = nil,
      rtcAudio: any LiveKitRTCAudioSessionBacking = SystemLiveKitRTCAudioSessionBacking()
    ) {
      self.rtcAudio = rtcAudio
      self.controller = controller ?? HandheldConversationAudioSessionController(backend: rtcAudio)
      // This must happen before a factory or peer connection is constructed.
      rtcAudio.configureManualAudioDisabled()
    }

    func activate() async throws {
      guard phase == .idle else {
        if phase == .active { return }
        throw HandheldConversationAudioSessionError.leaseUnavailable
      }
      phase = .activating
      operationGeneration &+= 1
      let generation = operationGeneration
      do {
        try await controller.activate()
      } catch {
        if generation == operationGeneration, phase == .activating { phase = .idle }
        if phase == .deactivating, let gate = activationDeactivationGate {
          activationDeactivationGate = nil
          await gate.resolve(.completed)
        }
        throw error
      }

      // A reset can win while the wrapped activation is suspended. It owns
      // physical reconciliation, so never compensate with another operation.
      guard generation == operationGeneration, phase == .activating else {
        if phase == .deactivating {
          if let gate = activationDeactivationGate {
            let result = await controller.deactivateWithResult()
            activationDeactivationGate = nil
            phase = (result == .timedOut || result == .failed) ? .terminal : .idle
            await gate.resolve(result)
          } else {
            await controller.deactivate()
            phase = .idle
          }
        }
        throw CancellationError()
      }
      rtcAudio.setAudioEnabled(true)
      phase = .active
    }

    func deactivate() async {
      if phase == .activating {
        phase = .deactivating
        operationGeneration &+= 1
        rtcAudio.setAudioEnabled(false)
        return
      }
      guard phase == .active else { return }
      phase = .deactivating
      operationGeneration &+= 1
      let generation = operationGeneration
      rtcAudio.setAudioEnabled(false)
      await controller.deactivate()
      if generation == operationGeneration, phase == .deactivating { phase = .idle }
    }

    func deactivateWithResult() async -> RealtimeAudioSessionDeactivationResult {
      if phase == .activating {
        phase = .deactivating
        operationGeneration &+= 1
        rtcAudio.setAudioEnabled(false)
        let gate = LiveKitRTCDeactivationGate()
        activationDeactivationGate = gate
        return await gate.wait()
      }
      guard phase == .active else { return .completed }
      phase = .deactivating
      operationGeneration &+= 1
      let generation = operationGeneration
      rtcAudio.setAudioEnabled(false)
      let result = await controller.deactivateWithResult()
      guard generation == operationGeneration, phase == .deactivating else { return result }
      switch result {
      case .completed, .reset:
        phase = .idle
      case .timedOut, .failed:
        // The wrapped controller retains its lease tombstone. Do not issue a
        // second physical deactivation while it drains or awaits reset.
        phase = .terminal
      }
      return result
    }

    func resetAfterMediaServicesReset() async {
      // Disable LiveKit before forwarding the one authoritative reset.
      rtcAudio.setAudioEnabled(false)
      operationGeneration &+= 1
      phase = .idle
      if let gate = activationDeactivationGate {
        activationDeactivationGate = nil
        await gate.resolve(.reset)
      }
      await controller.resetAfterMediaServicesReset()
    }
  }
#endif
