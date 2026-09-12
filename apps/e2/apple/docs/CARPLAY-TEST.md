# CarPlay test

Apsides provides an **Up next** widget on iOS 26 and later. It shows the next
timed calendar event, including an event currently in progress. This is the
native WidgetKit surface; it does not expose the document editor, a full CarPlay
app, or voice capture in the car.

## September 12 diagnosis: no app on CarPlay

There is no Apsides icon in the CarPlay app launcher in this build. The iOS
scene manifest has no CarPlay scene, and the app's entitlements do not request a
CarPlay app category entitlement. This is an implementation gap relative to a
full CarPlay app, not evidence that the iPhone installation failed.

The separate **Up next** widget supports `systemSmall`, which Apple makes
eligible for CarPlay without a CarPlay app. It must be selected in the vehicle's
widget settings; installing the iPhone app does not add a launcher icon. The
source has no `disfavoredLocations(.carPlay)` exclusion. Neither source
inspection nor packaging verification proves that this particular vehicle's
gallery discovers the widget.

A full launcher app requires a supported category, Apple's entitlement approval,
and a CarPlay scene built with the permitted templates. A general notes/calendar
app is not automatically a driving-task app: Apple says that category must help
with the drive itself. Apsides's eligibility is unresolved. Do not add an
arbitrary category entitlement or claim that a widget completes the requested
CarPlay app.

## Before the journey

1. With the car parked, open Apsides on iPhone and connect your workspace
   account.
2. Open **Context → Account & appearance → Refresh connected context**, then
   check the native calendar pane for the real event. Today attempts a native
   refresh after a website load, but seeing a web calendar is not proof that
   this refresh succeeded. The widget uses the authenticated native snapshot; it
   cannot refresh the account independently.
3. On iPhone open **Settings → General → CarPlay → your car → Widgets → Add
   Widgets**. Choose Apsides **Up next** and add it to a stack.
4. Connect to CarPlay and navigate to the widgets to the left of its Dashboard.
5. Compare the event and start time with Today. Check that the title remains
   legible and the widget works with the phone locked. Privacy settings may
   redact titles.

The installed extension must be present before it appears in the widget gallery.
If the gallery does not list Apsides, first open the installed app and retry the
gallery; do not remove the app and its local notes as a troubleshooting step.

## Distinguish discovery from missing data

Perform these checks when parked, with the phone available:

1. Check the iPhone Home Screen widget gallery for **Apsides Up Next / Up
   next**. Missing from both galleries points toward widget extension
   registration or installation; record the installed build and collect
   extension launch logs.
2. If present on iPhone but absent from the vehicle's **Add Widgets** gallery,
   record the iOS version and vehicle/head-unit model, and capture that gallery.
   This isolates CarPlay discovery from extension installation.
3. If listed in the vehicle gallery, add it to a stack and inspect the widgets
   to the left of Dashboard. Its absence from the app-icon grid remains
   expected.
4. If it renders **Refresh your day**, discovery succeeded. Refresh connected
   context using step 2 above and check again. That message diagnoses an absent
   or expired snapshot, not a missing CarPlay app.

The user reported the launcher absence after leaving with the devices. Physical
gallery discovery, extension logs, and vehicle rendering have not been observed
for that report. No hardware fix or successful car test is claimed.

## Expected behavior and limits

- The cached snapshot expires after one hour or when its calendar day changes.
  Expired or missing context shows **Refresh your day**, rather than claiming
  there are no events. A fresh empty calendar shows **No more events**.
- Known event boundaries and cache expiry are included in the widget timeline.
  WidgetKit still controls actual refresh delivery; this is not a live calendar
  subscription and there is no background calendar fetch yet.
- System fonts, semantic colors, automatic content margins, and a removable
  container background support CarPlay's native presentation. The widget
  provides value without a tap. The phone deep link does not constitute a
  CarPlay app.
- CarPlay eligibility follows the supported `systemSmall` family. A custom
  CarPlay category entitlement has not been requested or represented as
  approved.
- Physical-car appearance, locked-phone data availability, privacy redaction,
  and event transitions still require the above real-device test. A successful
  build alone does not establish those results.

## Apple references

- [CarPlay widgets and Live Activities](https://developer.apple.com/carplay/)
- [Customize widgets in CarPlay](https://support.apple.com/en-au/guide/iphone/iphb4d6a0bbb/ios)
- [Turbocharge your app for CarPlay, WWDC25](https://developer.apple.com/videos/play/wwdc2025/216/)
- [Adding StandBy and CarPlay support](https://developer.apple.com/documentation/widgetkit/adding-standby-and-carplay-support-to-your-widget)
- [Requesting CarPlay entitlements](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements)
- [Driving-task category scope, WWDC22](https://developer.apple.com/videos/play/wwdc2022/10016/)
