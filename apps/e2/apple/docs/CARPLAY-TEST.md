# CarPlay test

Apsides provides an **Up next** widget on iOS 26 and later. It shows the next timed
calendar event, including an event currently in progress. This is the native
WidgetKit surface; it does not expose the document editor, a full CarPlay app, or
voice capture in the car.

## Before the journey

1. With the car parked, open Apsides on iPhone and connect your workspace account.
2. Refresh Today and confirm that the real calendar event appears. The widget uses
   this authenticated snapshot; it cannot refresh the account independently.
3. On iPhone open **Settings → General → CarPlay → your car → Widgets → Add Widgets**.
   Choose Apsides **Up next** and add it to a stack.
4. Connect to CarPlay and navigate to the widgets to the left of its Dashboard.
5. Compare the event and start time with Today. Check that the title remains legible
   and the widget works with the phone locked. Privacy settings may redact titles.

The installed extension must be present before it appears in the widget gallery.
If the gallery does not list Apsides, first open the installed app and retry the
gallery; do not remove the app and its local notes as a troubleshooting step.

## Expected behavior and limits

- The cached snapshot expires after one hour or when its calendar day changes.
  Expired or missing context shows **Refresh your day**, rather than claiming there
  are no events. A fresh empty calendar shows **No more events**.
- Known event boundaries and cache expiry are included in the widget timeline.
  WidgetKit still controls actual refresh delivery; this is not a live calendar
  subscription and there is no background calendar fetch yet.
- System fonts, semantic colors, automatic content margins, and a removable
  container background support CarPlay's native presentation. The widget provides
  value without a tap. The phone deep link does not constitute a CarPlay app.
- CarPlay eligibility follows the supported `systemSmall` family. A custom CarPlay
  category entitlement has not been requested or represented as approved.
- Physical-car appearance, locked-phone data availability, privacy redaction, and
  event transitions still require the above real-device test. A successful build
  alone does not establish those results.

## Apple references

- [CarPlay widgets and Live Activities](https://developer.apple.com/carplay/)
- [Customize widgets in CarPlay](https://support.apple.com/en-au/guide/iphone/iphb4d6a0bbb/ios)
- [Turbocharge your app for CarPlay, WWDC25](https://developer.apple.com/videos/play/wwdc2025/216/)
- [Adding StandBy and CarPlay support](https://developer.apple.com/documentation/widgetkit/adding-standby-and-carplay-support-to-your-widget)
