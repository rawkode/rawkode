import XCTest

@testable import EnchiridionCore

final class AssistantVoiceSafetyTests: XCTestCase {
  private let builtIn = AssistantAudioRouteSnapshot(
    inputs: [.builtInMic],
    outputs: [.builtInSpeaker]
  )
  private let receiver = AssistantAudioRouteSnapshot(
    inputs: [.builtInMic],
    outputs: [.builtInReceiver]
  )
  private let wired = AssistantAudioRouteSnapshot(
    inputs: [.headsetMic],
    outputs: [.headphones]
  )
  private let a2dp = AssistantAudioRouteSnapshot(
    inputs: [.builtInMic],
    outputs: [.bluetoothA2DP]
  )
  private let hfp = AssistantAudioRouteSnapshot(
    inputs: [.bluetoothHFP],
    outputs: [.bluetoothHFP]
  )

  func testRouteClassifierSafetyMatrix() {
    let cases:
      [(
        AssistantAudioRouteChangeReason,
        AssistantAudioRouteSnapshot?,
        AssistantAudioRouteSnapshot,
        AssistantVoicePauseReason?
      )] = [
        (.oldDeviceUnavailable, wired, builtIn, .routeChanged),
        (.oldDeviceUnavailable, wired, hfp, .routeChanged),
        (.noSuitableRoute, wired, builtIn, .noSuitableRoute),
        (
          .oldDeviceUnavailable,
          wired,
          AssistantAudioRouteSnapshot(inputs: [], outputs: []),
          .noSuitableRoute
        ),
        (
          .routeConfigurationChange,
          wired,
          AssistantAudioRouteSnapshot(inputs: [.builtInMic], outputs: []),
          .noSuitableRoute
        ),
        (.routeConfigurationChange, wired, builtIn, .routeChanged),
        (.routeConfigurationChange, wired, receiver, .routeChanged),
        (.newDeviceAvailable, builtIn, wired, nil),
        (.newDeviceAvailable, a2dp, hfp, nil),
        (.routeConfigurationChange, builtIn, wired, nil),
        (.routeConfigurationChange, a2dp, hfp, nil),
        (.categoryChange, builtIn, builtIn, nil),
        (.override, builtIn, builtIn, nil),
        (.wakeFromSleep, builtIn, builtIn, nil),
        (.unknown, builtIn, builtIn, .routeChanged),
      ]

    for (reason, previous, current, expected) in cases {
      XCTAssertEqual(
        AssistantAudioRouteSafetyClassifier.pauseReason(
          reason: reason,
          previous: previous,
          current: current
        ),
        expected,
        "Unexpected decision for \(reason), \(String(describing: previous)) -> \(current)"
      )
    }
  }

  func testNotificationParserIgnoresInterruptionEndAndMapsPrimitivePayloads() {
    XCTAssertNil(AssistantVoiceSafetyNotificationParser.interruption(rawType: 0))
    XCTAssertEqual(
      AssistantVoiceSafetyNotificationParser.interruption(rawType: 1),
      .interruptionBegan
    )
    XCTAssertEqual(
      AssistantVoiceSafetyNotificationParser.routeChange(
        rawReason: 2,
        previous: wired,
        current: builtIn
      ),
      .routeChanged(reason: .oldDeviceUnavailable, previous: wired, current: builtIn)
    )
    XCTAssertEqual(
      AssistantVoiceSafetyNotificationParser.routeChange(
        rawReason: 99,
        previous: builtIn,
        current: builtIn
      ),
      .routeChanged(reason: .unknown, previous: builtIn, current: builtIn)
    )
  }

  func testPauseReasonCopyIsExact() {
    XCTAssertEqual(
      AssistantVoicePauseReason.interruption.message,
      "Voice paused for another audio activity. Tap the microphone to continue."
    )
    XCTAssertEqual(
      AssistantVoicePauseReason.routeChanged.message,
      "Voice paused because your audio route changed. Tap the microphone to continue."
    )
    XCTAssertEqual(
      AssistantVoicePauseReason.noSuitableRoute.message,
      "No audio route is available. Connect an audio device, then try again."
    )
    XCTAssertEqual(
      AssistantVoicePauseReason.mediaServicesRestarted.message,
      "System audio restarted. Tap the microphone to continue."
    )
    XCTAssertEqual(
      AssistantVoicePauseReason.appInactive.message,
      "Voice paused while Enchiridion was inactive. Tap the microphone to continue."
    )
  }

  func testMediaResetForcesNextAudioAcquireToReconfigure() {
    var lifecycle = AssistantAudioSessionLifecycleState()
    XCTAssertFalse(lifecycle.isConfigured)
    XCTAssertFalse(lifecycle.isActive)

    lifecycle.didConfigure()
    lifecycle.didActivate()
    lifecycle.didDeactivate()
    XCTAssertTrue(lifecycle.isConfigured)
    XCTAssertFalse(lifecycle.isActive)

    lifecycle.resetAfterMediaServicesReset()
    XCTAssertFalse(lifecycle.isConfigured)
    XCTAssertFalse(lifecycle.isActive)

    lifecycle.didConfigure()
    lifecycle.didActivate()
    XCTAssertTrue(lifecycle.isConfigured)
    XCTAssertTrue(lifecycle.isActive)
  }
}
