# Today

Two Android home-screen widgets for the events remaining today: a detailed dashboard, which scrolls on into the coming week, and a clock with the next event drawn directly on the wallpaper. It shows today’s events from calendars marked visible on the device, including a work profile when its admin allows it. Recurring events are expanded by Android's calendar provider. Canceled and past timed events are omitted. When nothing remains, a clear-day illustration takes the place of the agenda. Tap an event to open it in a compatible calendar app, or anywhere else on the dashboard to open the calendar at today.

The dashboard features one event in a tinted panel: the next one, counting down in minutes during the hour before it starts, or the one in progress. An event starting within 15 minutes takes over from one in progress, and among events in progress the most recently started wins, so a meeting inside a long focus block is featured over the block. Busy events are featured before free ones, and all-day events only when nothing timed remains. The rest of the day follows below the panel as a list, one line per event, with ongoing and upcoming timed events first and all-day events afterward. Join appears on a listed meeting from 15 minutes before it starts. The widget size, including its orientation on Android 12 and newer, and the system font size decide how many rows fit.

On Android 12 and newer the whole dashboard scrolls: swipe up anywhere on it to move past the panel to the rows that did not fit and then the next six days, each under a heading with its date. Days without events are left out. Before any swipe the panel and the first rows fill the widget exactly; when there is room, the first two lines of the next day show below today’s events, and a faded edge marks that more follows. Tap a heading to open the calendar at that day. The dashboard returns to today whenever the widget refreshes, except for the minute-by-minute countdown updates, which leave it where it was scrolled. Older Android versions cannot build a widget this way, so there the rows that do not fit are summarized in a link to the calendar. The same fixed layout is used on any version while the calendar cannot be read.

The panel takes whatever height the list leaves, so a tall widget on a short day has no blank surface. Spare height goes first to a larger title for the featured event, as long as it still fits on two lines, and then to a large day number in place of the one-line date. Rows are never dropped to make room for either.

## Run

Open this directory in Android Studio with JDK 17 and Android SDK 35 installed, and run the `app` configuration on an Android 8.0 (API 26) or newer device. Alternatively, run `./gradlew :app:assembleDebug` with `ANDROID_HOME` pointing to the SDK.

Open Today and allow calendar access, then tap **Add widget** or choose Today dashboard or Today clock through the launcher's widget picker. Android's calendar provider needs a calendar account synced to the device to display its events. Access is read-only, and no event data is sent over the network.

The widgets redraw when an event starts or ends, 15 minutes before an event starts, and at midnight, using exact alarms that also run while the phone is idle, so they are already correct when the screen turns on. Countdown minutes update only while the screen is on. Calendar edits and syncs trigger a refresh shortly after they reach the device. The widgets also refresh on time, time zone, and language changes, when Today is opened, and every 30 minutes as a fallback. If the calendar cannot be read, the dashboard says so and a tap retries. Android 13 and newer grant exact alarms to calendar apps at install (`USE_EXACT_ALARM`). On Android 12, the user can revoke Alarms & reminders access; Today then asks for it on its main screen, and until it is granted, updates can arrive up to 10 minutes late and countdowns show the start time instead. Setting Today’s battery usage to Restricted blocks these background updates. Widget pinning depends on launcher support.

Launchers apply each widget update on top of the views they already inflated, rather than starting from the layout again. Every update therefore sets the complete state of the widget: the list is emptied before rows are added or, where the dashboard scrolls, replaced as a whole, and each view's visibility is set whether or not it changed. A scrolling list also reuses the views of one row for another, so the same holds for each row. Keep that property when changing `TodayWidget.render` or `ClockWidget.update`; a view left unset keeps whatever the previous update gave it.

## Nix development shell

On x86-64 Linux, the flake provides JDK 17, Gradle 8, Android SDK platform 35, build tools 35.0.0, and platform tools. Review and accept the [Android SDK license](https://developer.android.com/studio/terms), then enter the shell with:

```sh
NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 nix develop --impure path:.
gradle :app:assembleDebug
```

The `path:.` form includes this directory even before its files are tracked by Git. Gradle still downloads the Android Gradle plugin and other dependencies from the configured repositories on the first build. The SDK in the Nix store is read-only; install additional SDK components by adjusting the flake. An emulator and system images are not included; use a physical device or an existing Android emulator to run the app.

Event colors, locations, meeting links, and overlaps use information already on the device. Map and Join actions appear on the featured event when suitable details are present. Overlap indicators consider visible timed events marked busy or tentative; all-day and free events are shown but do not occupy the timed schedule. Declined invitations are excluded when the device calendar reports their response.

The clock widget features the same event as the dashboard, with the same minute countdown during the hour before it starts. Tap the time to open the clock app, the date to open Calendar, or the event to open its details.

## Light, dark, and Material You

The widgets and app follow the system light or dark theme, and the dashboard's text uses the device's own font, such as Google Sans Text on Pixel. On Android 12 and newer, their colors come from the wallpaper-based Material You palette and the system widget corner radius; older versions use a fixed palette. Calendar colors are kept as they are on the device, but adjusted toward black or white when they would be hard to read on the widget surface: to 4.5:1 contrast for text and 3:1 for the color dot beside each event. On Android 12 and newer the launcher switches these colors when the theme changes; on older versions, calendar colors catch up on the next widget refresh. The clock has no background, like the Pixel clock: it uses light text with a soft shadow on dark wallpapers and dark text on light ones, based on Android's wallpaper color hint rather than the system theme. After a wallpaper change it switches on its next refresh.

## Work profile calendars

On Android 10 and newer, the widgets also show today's events from a work profile, marked visible there, alongside personal events. Android only allows this when both of these are true:

- The work profile's admin allows Today (`rawkode.dev.today`) to access cross-profile calendars. Android allows no apps by default, and most organizations only allow their own apps.
- Cross-profile calendar is turned on in the work profile's settings.

Otherwise, the work profile query returns nothing and only personal events are shown. Today's main screen shows whether work calendars are connected. Work event descriptions are not shared across profiles, so meeting links for work events are recognized only when they are in the event location.

Tapping a work event opens it in the work profile's calendar app only when Today is also installed in the work profile, because Android forwards work events only to the same app in the other profile. Without that, Today shows a message instead.

## Releases

Push a tag such as `today/0.1.0` to run the GitHub Actions release workflow. It runs the unit tests, builds and signs a release APK, and publishes it as `today-0.1.0.apk` on a GitHub release named `today/0.1.0`. Tags must use numeric `MAJOR.MINOR.PATCH` components; minor and patch must be below 1000, and `MAJOR * 1000000 + MINOR * 1000 + PATCH` must be between 1 and 2100000000. This value becomes Android's `versionCode`, so release versions must increase.

Before the first release, create a persistent Android signing keystore and configure these repository Actions secrets:

- `TODAY_KEYSTORE_BASE64`: base64-encoded keystore file (for example, `base64 -w 0 today-release.jks`).
- `TODAY_KEYSTORE_PASSWORD`: keystore password.
- `TODAY_KEY_ALIAS`: signing key alias.
- `TODAY_KEY_PASSWORD`: signing key password.

If a tagged run needs to be retried after the workflow is fixed, use the workflow's manual dispatch with the existing tag (for example, `gh workflow run today-release.yml --ref main -f tag=today/0.1.0`). It builds the tagged commit without moving the tag. A release that already exists is not overwritten.

Releases before the switch to the `rawkode.dev.today` application ID were published as `tech.rawkode.today`. Android treats these as different apps, so an older installation is not updated. Remove it and add the widgets again after installing the new release.

Keep the keystore and its passwords safe and use the same signing key for every release, otherwise Android cannot update an existing installation. The locally installed debug build uses a different signing key; installing the release over it requires removing the debug build first.
