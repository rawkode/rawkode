# CarPlay voice implementation

Status: native scene implemented and Simulator build verified, 13 September 2026. The source
now registers a CarPlay scene and shares the application's account and voice
owner. This is not a claim that the app appears or works in a vehicle; signing,
locked-phone authentication and vehicle interaction remain qualification gates.

## Apple contract

The approved category is `com.apple.developer.carplay-voice-based-conversation`,
which requires iOS 26.4. Keep the phone deployment minimum separate and gate the
CarPlay adapter accordingly.

Voice must be the primary interaction. Display the voice-control template while
recording, activate audio only during active voice use, and do not display query
answers as text or imagery. The category permits action sheet, alert, grid,
list, tab bar, voice control, information and point-of-interest templates, with
a maximum hierarchy depth of three. A widget alone does not create an app icon.

Source:
[Apple CarPlay Developer Guide](https://developer.apple.com/download/files/CarPlay-Developer-Guide.pdf),
revision 2026-06-08, printed pages 7, 11, 13–14, 26 and 29. The template table
was visually checked as well as text-extracted.

Use `.playAndRecord`, `.default` mode and no audio mixing for the car. Do not
inherit the phone's `.defaultToSpeaker` option. Source:
[Rev up your CarPlay app, WWDC26](https://developer.apple.com/videos/play/wwdc2026/212/).

## Scene registration

Add this configuration under `UIApplicationSceneManifest` in `project.yml` and
regenerate the Xcode project. Preserve the existing SwiftUI phone scene.

```yaml
UIApplicationSupportsMultipleScenes: true
UISceneConfigurations:
  CPTemplateApplicationSceneSessionRoleApplication:
    - UISceneClassName: CPTemplateApplicationScene
      UISceneConfigurationName: EnchiridionCarPlay
      UISceneDelegateClassName: $(PRODUCT_MODULE_NAME).CarPlaySceneDelegate
```

The delegate adopts `CPTemplateApplicationSceneDelegate`. Use the non-navigation
`templateApplicationScene(_:didConnect:)` and
`templateApplicationScene(_:didDisconnectInterfaceController:)`; do
not create a custom CarPlay window or navigation dashboard scene. Source:
[Displaying content in CarPlay](https://developer.apple.com/documentation/CarPlay/displaying-content-in-carplay?changes=_5_4).

## Purpose-built presentation

Use one `CPVoiceControlTemplate` with Ready, Connecting, Listening, Muted and
Unavailable states; the SDK permits at most five. Closing uses the connecting
presentation while the existing owner finishes cleanup. Start is explicit; car connection does not start
capture. During a call, offer Mute/Unmute and End. Display state only, never
captions, calendar rows answering a query, notes or a web editor. Speak useful
calendar and integration answers through the existing voice pipeline.

If account or microphone setup is missing, show a short setup requirement and
leave capture inactive. Do not open an authentication flow on the car screen.

The installed SDK headers were inspected at:

`/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.0.sdk/System/Library/Frameworks/CarPlay.framework/Headers/`

- `CPVoiceControlTemplate.h`: state action buttons and navigation buttons are
  available from 26.4; at most two action buttons. State activation only takes
  effect after presentation and is rate limited. Update on phase changes, not
  audio samples or every caption fragment.
- `CPTemplateApplicationScene.h`: non-navigation connect/disconnect callbacks
  provide the interface controller; the scene retains that controller.
- Background artwork/overlay additions from iOS 27 are optional and not needed
  for the 26.4 baseline. Use the system-rendered template rather than attempting
  to reproduce phone glass controls in the vehicle.

## Single conversation owner

Prerequisite: `WorkspaceStore` owns one `VoiceConversation` bound to its
existing immutable `NativeSession`. Phone and Mac presentations observe the
injected coordinator rather than creating their own. The coordinator pins
account and surface (`phone`, `carplay`, or `mac`) at Start, before the first
asynchronous permission or network operation.

Only the owning surface may issue ordinary stop/disappear commands. Central
account revocation, interruption and transport failure may force-stop. Retain
ownership during remote closure so a second surface cannot race a new Start. A
handoff is explicit: stop the old call, await its outcome, then start from the
new surface. Do not silently transfer live microphone capture.

The later CarPlay scene integration must make this same store available during a
head-unit-first cold launch. Move application service custody into the app's
`UIApplicationDelegateAdaptor` owner and inject that store into SwiftUI; resolve
it from the scene delegate. Do not construct a global second `NativeSession` or
copy browser cookies into another credential store.

Observe authorization inside the coordinator, even if no phone view exists.
Combine's `@Published` emits before the property is assigned: inspect the
emitted values, not stale reads back from `NativeSession`. Keep revocation
teardown synchronous on the main actor and avoid a scheduler hop before
disabling audio.

## Lifecycle and authentication hazards

- Phone `.background`/`.onDisappear` currently ends its voice sheet. After
  shared ownership, those events must only stop a phone-owned call. The phone
  may be backgrounded while the CarPlay scene remains active.
- CarPlay disconnection, loss of the visible voice template, account change and
  audio interruption disable local capture/playback immediately, then perform
  bounded remote cleanup. Do not automatically resume after interruption.
- Start must send `device: "carplay"` and the validated device IANA timezone;
  ownership and model/tool permissions remain server-side.
- Keep CarPlay audio activation separate from UI construction. Do not hold the
  vehicle's audio session while waiting for account setup or idle at Ready.
- Existing authentication uses WebKit's shared cookie store. Its availability
  while the phone is locked must be tested, not assumed. Apple notes that
  certain file-protection and keychain accessibility classes are unavailable
  while locked. Do not weaken credential protection as an unreviewed workaround.
- If continuing audio while the phone backgrounds requires background-audio
  configuration, add it only with the active-conversation lifecycle implemented
  and tested; it is not permission for continuous ambient recording.

## Qualification before a CarPlay delivery claim

1. Inspect the actual signed archive's scene manifest and approved entitlement.
2. Cold-launch from the car before opening any phone window; confirm account
   setup is correctly recognized without creating duplicate app services.
3. Verify Start, permission denial, mute, unmute and End with actual audible
   output and microphone input. Check that idle connection does not interrupt
   other vehicle audio.
4. Speak an authenticated calendar question and hear a sourced answer; a
   template screenshot or successful SDK build does not satisfy this test.
5. Disconnect cable/wireless CarPlay during setup, active speech and remote
   closure. Verify local audio stops and a late HTTP result cannot reopen it.
6. Exercise phone/car Start collisions, phone sheet dismissal while the car owns
   the call, explicit handoff, account change and sign-out.
7. Test locked phone, screen off, network loss, Siri, incoming calls and audio
   route changes. Verify no automatic microphone restart.
8. Exercise touch and rotary input and more than one display size. Use CarPlay
   Simulator for wiring; retain a real-head-unit test for audio and lifecycle.

Report separately: implemented, built, simulator-verified,
physical-car-verified, pushed, cloud-built and TestFlight-available. Entitlement
approval is not proof of any later stage.
