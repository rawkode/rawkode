# macOS preferences audit — 2026-09-08

Observed on `p4x-studio`, macOS 27.0 beta, build `26A5421a`.

## Scope and evidence

Reviewed 186 scalar option definitions across 16 preference domains in the pinned
nix-darwin source; 91 had stored scalar values. Also inspected desktop-services,
Bluetooth trackpad, Control Center, accessibility, Spaces, screenshot and keyboard
preferences. This is a system-preferences audit, not an exhaustive audit of every
third-party application's private settings, nested shortcuts, ByHost settings,
managed profiles, or hardware/network/security configuration.

A stored value is not proof of a user customization. Apps persist defaults,
migrations and transient state. An absent key does not prove an effective value.
The baselines below are upstream documentation, not measurements from a clean
installation of this beta. In particular, nix-darwin `default = null` means
unmanaged; it is not an Apple factory default. Hardware and OS versions can differ.

Sources: [pinned nix-darwin option source](https://github.com/nix-darwin/nix-darwin/tree/4cff07de74b50e64bdd68cd4e722ab5b6b35ee48/modules/system/defaults)
and [Apple Desktop & Dock settings](https://support.apple.com/en-au/guide/mac-help/mchlp1119/mac).
The comparison used local input `/nix/store/8ggr67sci43hlp8ba6rhjrdhhj5490am-source`.

## Important preferences now codified

The shared macOS base now preserves these observed settings on all machines using
that base; individual machines can override the existing rawkOS options.

| Preference | Observed and declared | Baseline confidence |
| --- | --- | --- |
| Dock magnification | Enabled, maximum size 128 | Upstream documents disabled by default; exact size baseline not verified on this beta |
| Stage Manager | Enabled | Upstream documents disabled by default |
| Stage Manager desktop items | Hidden | Factory baseline unknown; preserves observed workflow |
| Stage Manager application windows | All at once | Factory baseline unknown; preserves observed workflow |
| Global Force Click preference | Disabled | Factory baseline not verified; preserves stored value |
| Network `.DS_Store` files | Suppressed | Custom preference; no clean-beta baseline verified |
| USB `.DS_Store` files | Suppressed | Custom preference; no clean-beta baseline verified |

These additions use typed nix-darwin options where available and custom user
preferences for desktop-services. They have not been activated.

## Already captured

The effective base already sets automatic appearance switching and a bottom Dock,
even though the reusable option defaults say dark mode and a right Dock. Comparing
only option declarations would incorrectly report drift.

Existing declarations cover Dock autohide and animation timings, 44-pixel icons,
no recent apps, minimizing into app icons, stable Spaces ordering, Mission Control
grouping and hot corners; Finder hidden files, extensions, path/status bars, POSIX
titles and list view; fast key repeat and disabled press-and-hold; tap-to-click,
natural scrolling and Expose gestures; screenshots in `~/Screenshots` without
window shadows; and Mail personalized smart replies.

## Deliberately left for separate review

- Clock: date hidden (`ShowDate = 2`), weekday hidden, AM/PM shown. These are
  reproducible preferences, but lower priority and locale-dependent baselines
  are unknown.
- Clear/automatic icon appearance (`AppleIconAppearanceTheme = ClearAutomatic`)
  and glass tint (`NSGlassTintAmount = 0.5`): beta appearance settings; defer until
  their persistence contract is clearer.
- `AppleFnUsageType = 0` is stored in `com.apple.HIToolbox`. The existing rawkOS
  `keyboard.fnUsageType` option is currently unused by its module. No new Fn
  behavior was inferred or changed.
- Several trackpad gesture values differ from upstream documented baselines.
  Some of those baselines appear hardware/version-sensitive; preserve existing
  gesture declarations rather than infer intent from every numeric gesture key.
- Global Force Click is false while `ForceSuppressed` is false in the trackpad
  domain. Only the observed global value is codified; actual hardware behavior
  and precedence between these settings were not tested.
- Screenshot/recording-specific destinations already match the generic screenshot
  location; no beta-specific duplicate keys added.
- Accounts, cloud-provider identifiers, history, window geometry, onboarding flags,
  usage timestamps, device identifiers and application session state are excluded.
- Existing `persistentApps = []` clears pinned Dock apps on activation. This audit
  has not changed that existing policy or audited the nested Dock app list.

## Stored supported preferences

“Declared” means the generated user-defaults activation script contains the key;
it does not claim the configuration has been activated. Documentation with no
usable baseline is marked unknown. The table includes default-like values so the
review does not mistake every persisted key for a customization.

| Domain | Key | Stored value | Declared after change | Upstream baseline notes |
| --- | --- | --- | --- | --- |
| `com.apple.dock` | `appswitcher-all-displays` | `false` | Yes | Whether to display the appswitcher on all displays or only the main one. The default is false. |
| `com.apple.dock` | `autohide` | `true` | Yes | Whether to automatically hide and show the dock. The default is false. |
| `com.apple.dock` | `autohide-delay` | `0.0` | Yes | Sets the speed of the autohide delay. The default is given in the example. |
| `com.apple.dock` | `autohide-time-modifier` | `0.15` | Yes | Sets the speed of the animation when hiding/showing the Dock. The default is given in the example. |
| `com.apple.dock` | `expose-animation-duration` | `0.2` | Yes | Sets the speed of the Mission Control animations. The default is given in the example. |
| `com.apple.dock` | `expose-group-apps` | `true` | Yes | Whether to group windows by application in Mission Control's Exposé. The default is false. |
| `com.apple.dock` | `launchanim` | `false` | Yes | Animate opening applications from the Dock. The default is true. |
| `com.apple.dock` | `minimize-to-application` | `true` | Yes | Whether to minimize windows into their application icon.  The default is false. |
| `com.apple.dock` | `mru-spaces` | `false` | Yes | Whether to automatically rearrange spaces based on most recent use.  The default is true. |
| `com.apple.dock` | `orientation` | `"bottom"` | Yes | Position of the dock on screen.  The default is "bottom". |
| `com.apple.dock` | `showAppExposeGestureEnabled` | `true` | Yes | Whether to enable trackpad gestures (three- or four-finger vertical swipe) to show App Exposé. The default is false. This feature interacts with `system.defaults.trackpad.TrackpadFourFingerVertSwipeGesture` and `system.defaults.trackpad.TrackpadThreeFingerVertSwipeGesture` to determine which gesture triggers App Exposé. |
| `com.apple.dock` | `showMissionControlGestureEnabled` | `true` | Yes | Whether to enable trackpad gestures (three- or four-finger vertical swipe) to show Mission Control. The default is false. This feature interacts with `system.defaults.trackpad.TrackpadFourFingerVertSwipeGesture` and `system.defaults.trackpad.TrackpadThreeFingerVertSwipeGesture` to determine which gesture triggers Mission Control. |
| `com.apple.dock` | `show-process-indicators` | `true` | Yes | Show indicator lights for open applications in the Dock. The default is true. |
| `com.apple.dock` | `show-recents` | `false` | Yes | Show recent applications in the dock. The default is true. |
| `com.apple.dock` | `tilesize` | `44` | Yes | Size of the icons in the dock.  The default is 64. |
| `com.apple.dock` | `magnification` | `true` | Yes | Magnify icon on hover. The default is false. |
| `com.apple.dock` | `largesize` | `128.0` | Yes | Magnified icon size on hover. The default is 16. |
| `com.apple.dock` | `wvous-tl-corner` | `1` | Yes | Unknown |
| `com.apple.dock` | `wvous-bl-corner` | `1` | Yes | Unknown |
| `com.apple.dock` | `wvous-tr-corner` | `12` | Yes | Unknown |
| `com.apple.dock` | `wvous-br-corner` | `4` | Yes | Unknown |
| `com.apple.WindowManager` | `GloballyEnabled` | `true` | Yes | Stage Manager arranges your recent windows into a single strip for reduced clutter and quick access. Default is false. |
| `com.apple.WindowManager` | `AutoHide` | `false` | No | Auto hide stage strip showing recent apps. Default is false. |
| `com.apple.WindowManager` | `AppWindowGroupingBehavior` | `1` | Yes | Unknown |
| `com.apple.WindowManager` | `HideDesktop` | `true` | Yes | Unknown |
| `com.apple.WindowManager` | `EnableTiledWindowMargins` | `true` | No | Enable window margins when tiling windows. The default is true. |
| `com.apple.WindowManager` | `StandardHideWidgets` | `false` | No | Unknown |
| `com.apple.WindowManager` | `StageManagerHideWidgets` | `false` | No | Unknown |
| `com.apple.ActivityMonitor` | `ShowCategory` | `100` | No | Default is 100. |
| `com.apple.ActivityMonitor` | `OpenMainWindow` | `true` | No | Open the main window when opening Activity Monitor. Default is true. |
| `com.apple.finder` | `AppleShowAllFiles` | `true` | Yes | Whether to always show hidden files. The default is false. |
| `com.apple.finder` | `ShowStatusBar` | `true` | Yes | Show status bar at bottom of finder windows with item/disk space stats. The default is false. |
| `com.apple.finder` | `ShowPathbar` | `true` | Yes | Show path breadcrumbs in finder windows. The default is false. |
| `com.apple.finder` | `FXPreferredViewStyle` | `"Nlsv"` | Yes | Change the default finder view. The default is icnv. |
| `com.apple.finder` | `AppleShowAllExtensions` | `true` | Yes | Whether to always show file extensions. The default is false. |
| `com.apple.finder` | `CreateDesktop` | `"1"` | No | Whether to show icons on the desktop or not. The default is true. |
| `com.apple.finder` | `QuitMenuItem` | `false` | Yes | Whether to allow quitting of the Finder. The default is false. |
| `com.apple.finder` | `ShowExternalHardDrivesOnDesktop` | `true` | No | Whether to show external disks on desktop. The default is true. |
| `com.apple.finder` | `ShowHardDrivesOnDesktop` | `false` | No | Whether to show hard disks on desktop. The default is false. |
| `com.apple.finder` | `ShowRemovableMediaOnDesktop` | `true` | No | Whether to show removable media (CDs, DVDs and iPods) on desktop. The default is true. |
| `com.apple.finder` | `_FXShowPosixPathInTitle` | `true` | Yes | Whether to show the full POSIX filepath in the window title. The default is false. |
| `com.apple.finder` | `NewWindowTarget` | `"PfAF"` | No | Change the default folder shown in Finder windows. "Other" corresponds to the value of NewWindowTargetPath. The default is unset ("Recents"). |
| `com.apple.spaces` | `spans-displays` | `false` | No | false = each physical display has a separate space (Mac default) |
| `NSGlobalDomain` | `AppleShowAllFiles` | `true` | Yes | Whether to always show hidden files. The default is false. |
| `NSGlobalDomain` | `AppleEnableSwipeNavigateWithScrolls` | `true` | Yes | Enables swiping left or right with two fingers to navigate backward or forward. The default is true. |
| `NSGlobalDomain` | `AppleIconAppearanceTheme` | `"ClearAutomatic"` | No | To set to default mode, set this to `null` and you'll need to manually run {command}`defaults delete -g AppleIconAppearanceTheme`. |
| `NSGlobalDomain` | `AppleInterfaceStyleSwitchesAutomatically` | `true` | Yes | Whether to automatically switch between light and dark mode. The default is false. |
| `NSGlobalDomain` | `ApplePressAndHoldEnabled` | `false` | Yes | Whether to enable the press-and-hold feature. The default is true. |
| `NSGlobalDomain` | `AppleShowAllExtensions` | `true` | Yes | Whether to show all file extensions in Finder. The default is false. |
| `NSGlobalDomain` | `NSAutomaticCapitalizationEnabled` | `true` | No | Whether to enable automatic capitalization. The default is true. |
| `NSGlobalDomain` | `NSAutomaticPeriodSubstitutionEnabled` | `true` | No | Whether to enable smart period substitution. The default is true. |
| `NSGlobalDomain` | `NSAutomaticWindowAnimationsEnabled` | `true` | Yes | Whether to animate opening and closing of windows and popovers. The default is true. |
| `NSGlobalDomain` | `InitialKeyRepeat` | `15` | Yes | Unknown |
| `NSGlobalDomain` | `KeyRepeat` | `2` | Yes | Unknown |
| `NSGlobalDomain` | `com.apple.sound.beep.volume` | `0.6703200340270996` | No | Unknown |
| `NSGlobalDomain` | `com.apple.trackpad.forceClick` | `false` | Yes | Unknown |
| `NSGlobalDomain` | `com.apple.springing.enabled` | `true` | No | Unknown |
| `NSGlobalDomain` | `com.apple.springing.delay` | `0.5` | No | Set the spring loading delay for directories. The default is given in the example. |
| `NSGlobalDomain` | `com.apple.swipescrolldirection` | `true` | Yes | Whether to enable "Natural" scrolling direction. The default is true. |
| `NSGlobalDomain` | `_HIHideMenuBar` | `false` | No | Whether to autohide the menu bar. The default is false. |
| `com.apple.AppleMultitouchMouse` | `MouseButtonMode` | `"OneButton"` | No | Unknown |
| `com.apple.AppleMultitouchTrackpad` | `Clicking` | `true` | Yes | Whether to enable tap to click. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `Dragging` | `0` | No | Whether to enable tap to drag. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadRightClick` | `true` | Yes | The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadThreeFingerDrag` | `false` | Yes | Whether to enable three-finger drag. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `ActuationStrength` | `1` | Yes | 0 to enable Silent Clicking, 1 to disable. The default is 1. |
| `com.apple.AppleMultitouchTrackpad` | `FirstClickThreshold` | `1` | No | The default is 1. |
| `com.apple.AppleMultitouchTrackpad` | `SecondClickThreshold` | `1` | No | The default is 1. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadThreeFingerTapGesture` | `2` | No | The default is 2. |
| `com.apple.AppleMultitouchTrackpad` | `ActuateDetents` | `1` | No | Whether to enable haptic feedback. The default is true. |
| `com.apple.AppleMultitouchTrackpad` | `DragLock` | `0` | No | Whether to enable drag lock. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `ForceSuppressed` | `false` | No | Whether to disable force click. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadCornerSecondaryClick` | `0` | No | The default is 0. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadFourFingerHorizSwipeGesture` | `2` | No | The default is 0. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadFourFingerPinchGesture` | `2` | No | The default is 0. This setting interacts with `system.defaults.dock.showDesktopGestureEnabled` and `system.defaults.dock.showLaunchpadGestureEnabled` to determine whether gestures are enabled for the Desktop, Launchpad, or both. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadFourFingerVertSwipeGesture` | `2` | No | The default is 2. When both three- and four-finger vertical swipe gestures are enabled, the three-finger variant takes precedence. This setting interacts with `system.defaults.dock.showAppExposeGestureEnabled` and `system.defaults.dock.showMissionControlGestureEnabled` to determine whether vertical swipe gestures are enabled for App Exposé, Mission Control, or both. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadMomentumScroll` | `true` | No | Whether to use inertia when scrolling. The default is true. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadPinch` | `1` | No | The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadRotate` | `1` | No | Whether to enable two-finger rotation gesture. The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadThreeFingerHorizSwipeGesture` | `2` | No | The default is 2. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadThreeFingerVertSwipeGesture` | `2` | No | The default is 2. This setting interacts with `system.defaults.dock.showAppExposeGestureEnabled` and `system.defaults.dock.showMissionControlGestureEnabled` to determine whether vertical swipe gestures are enabled for App Exposé, Mission Control, or both. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadTwoFingerDoubleTapGesture` | `1` | No | The default is false. |
| `com.apple.AppleMultitouchTrackpad` | `TrackpadTwoFingerFromRightEdgeSwipeGesture` | `3` | No | The default is 0. |
| `com.apple.screencapture` | `location` | `"~/Screenshots"` | Yes | Unknown |
| `com.apple.screencapture` | `type` | `"png"` | Yes | Unknown |
| `com.apple.screencapture` | `disable-shadow` | `true` | Yes | Disable drop shadow border around screencaptures. The default is false. |
| `com.apple.screencapture` | `include-date` | `true` | Yes | Include date and time in screenshot filenames. The default is true. |
| `com.apple.screencapture` | `target` | `"file"` | No | Target to which screencapture should save screenshot to. The default is "file". * `file`: Saves as a file in location specified by `system.defaults.screencapture.location` |
| `com.apple.menuextra.clock` | `ShowAMPM` | `true` | No | Unknown |
| `com.apple.menuextra.clock` | `ShowDayOfWeek` | `false` | No | Unknown |
| `com.apple.menuextra.clock` | `ShowDate` | `2` | No | Unknown |

## Validation

- `nix flake check --no-eval-cache path:./nix` passed on aarch64-darwin,
  including treefmt and the manifest contract. Incompatible-system checks were
  omitted by Nix; system packages were evaluated, not built.
- All four Darwin hosts passed configuration assertions and generated the eight
  added preference keys. Generated user-defaults scripts passed `bash -n`.
- Changed Nix files passed `nixfmt --check`.
- No activation, app restart, or physical input/UI behavior test was performed.
