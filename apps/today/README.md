# Today

Two Android home-screen widgets for the events remaining today: a detailed dashboard and a translucent clock with the next event. It shows today’s events from calendars marked visible on the device, including a work profile when its admin allows it, using the widget size to determine how many fit, with ongoing and upcoming timed events first and all-day events afterward. Recurring events are expanded by Android's calendar provider. Canceled and past timed events are omitted. When nothing remains, a clear-day illustration takes the place of the agenda. Tap an event to open it in a compatible calendar app.

## Run

Open this directory in Android Studio with JDK 17 and Android SDK 35 installed, and run the `app` configuration on an Android 8.0 (API 26) or newer device. Alternatively, run `./gradlew :app:assembleDebug` with `ANDROID_HOME` pointing to the SDK.

Open Today and allow calendar access, then tap **Add widget** or choose Today dashboard or Today clock through the launcher's widget picker. Android's calendar provider needs a calendar account synced to the device to display its events. Access is read-only, and no event data is sent over the network.

The widget watches the device calendar for changes and schedules an update near the next event start, end, or midnight. It also refreshes on date or time changes, when opened, when its refresh control is tapped, and periodically as a fallback. Android may delay background work and does not wake the device solely for event transitions; tap refresh for an immediate update. Widget pinning depends on launcher support.

## Nix development shell

On x86-64 Linux, the flake provides JDK 17, Gradle 8, Android SDK platform 35, build tools 35.0.0, and platform tools. Review and accept the [Android SDK license](https://developer.android.com/studio/terms), then enter the shell with:

```sh
NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 nix develop --impure path:.
gradle :app:assembleDebug
```

The `path:.` form includes this directory even before its files are tracked by Git. Gradle still downloads the Android Gradle plugin and other dependencies from the configured repositories on the first build. The SDK in the Nix store is read-only; install additional SDK components by adjusting the flake. An emulator and system images are not included; use a physical device or an existing Android emulator to run the app.

Event colors, locations, meeting links, and overlaps use information already on the device. Meeting and map actions appear when suitable details are present. Overlap indicators consider visible timed events marked busy or tentative; all-day and free events are shown but do not occupy the timed schedule. Declined invitations are excluded when the device calendar reports their response.

The clock widget shows a minute countdown during the hour before the next event when Android’s Alarms & reminders access is granted. Without that access it shows the event time. Updates can still be delayed while the phone is asleep. Tap the time to open the clock app, the date to open Calendar, or the event to open its details.

## Light, dark, and Material You

The widgets and app follow the system light or dark theme. On Android 12 and newer, their colors come from the wallpaper-based Material You palette and the system widget corner radius; older versions use a fixed palette. Calendar colors are kept as they are on the device, but adjusted toward black or white when they would be hard to read on the widget surface. On Android 12 and newer the launcher switches these colors when the theme changes; on older versions, calendar colors catch up on the next widget refresh. The clock keeps a translucent background, now strong enough for its text to stay readable over any wallpaper.

## Work profile calendars

On Android 10 and newer, the widgets also show today's events from a work profile, marked visible there, alongside personal events. Android only allows this when both of these are true:

- The work profile's admin allows Today (`tech.rawkode.today`) to access cross-profile calendars. Android allows no apps by default, and most organizations only allow their own apps.
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

Keep the keystore and its passwords safe and use the same signing key for every release, otherwise Android cannot update an existing installation. The locally installed debug build uses a different signing key; installing the release over it requires removing the debug build first.
