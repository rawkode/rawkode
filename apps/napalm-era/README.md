# Napalm Era

Napalm Era is a local-first iOS and Apple Watch health journal built for iOS 27 and watchOS 27 with SwiftUI, SwiftData, HealthKit, Apple Foundation Models, and XcodeGen.

## Product boundaries

- Nutrition creation and correction are AI-only. There are no nutrient entry or edit forms.
- Text, `SpeechAnalyzer` transcripts, meal photos, and nutrition-label photos go only to Apple Foundation Models.
- Private Cloud Compute is preferred; the on-device system model is the automatic fallback.
- Only confirmed structured meals are persisted and exported as HealthKit food correlations.
- Photos, recordings, raw transcripts, and complete assistant conversations are never persisted.
- Targets, units, permissions, and machine defaults use conventional settings controls.
- Watch Gym Mode is deterministic and remains usable without AI or an iPhone connection.

## Generate and verify

```sh
cd apps/napalm-era
xcodegen generate
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project NapalmEra.xcodeproj -scheme 'Napalm Era iOS' \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

`project.yml` is the source of truth for the generated Xcode project.

## Signed-device acceptance

The repository can compile the complete device paths without signing, but these Apple integrations require a signed physical iPhone and Watch:

- the managed `com.apple.developer.private-cloud-compute` entitlement and live PCC quota behavior;
- Apple Intelligence and Foundation Models model availability;
- camera input and `_Vision_FoundationModels.OCRTool` label analysis;
- HealthKit nutrition correlations and workout sessions;
- `SpeechAnalyzer` microphone transcription;
- Gym Mode workout sensors, suspension recovery, and Watch Connectivity delivery.

Provisioning profiles must include HealthKit for both targets and the managed PCC entitlement for the iOS target before physical-device acceptance can pass.

Debug builds use `NapalmEra-iOS-Debug.entitlements` so they can be installed before Apple grants the managed PCC capability; those builds report PCC as unavailable and use the on-device Foundation Models fallback. Release builds retain the PCC entitlement and require an eligible provisioning profile.
