package helpers

import "github.com/rawkode/rawkcue/schema"

// Hot corner action identifiers with their numeric values
#HotCornerAction: "none" | "missionControl" | "appWindows" | "desktop" |
	"startScreenSaver" | "disableScreenSaver" | "dashboard" | "sleep" |
	"launchpad" | "notificationCenter" | "lockScreen"

// Map hot corner names to their integer values
_hotCornerValues: {
	none:                0
	missionControl:      2
	appWindows:          3
	desktop:             4
	startScreenSaver:    5
	disableScreenSaver:  6
	dashboard:           7
	sleep:               10
	launchpad:           11
	notificationCenter:  12
	lockScreen:          13
}

// =============================================================================
// Dock Configuration
// =============================================================================

#DockOptions: {
	autohide?:              bool
	autohideDelay?:         number
	autohideTimeModifier?:  number
	magnification?:         bool
	magnificationSize?:     int & >=16 & <=256
	tileSize?:              int & >=16 & <=256
	orientation?:           "bottom" | "left" | "right"
	minimizeEffect?:        "genie" | "scale" | "suck"
	minimizeToApplication?: bool
	showIndicatorLights?:   bool
	showRecents?:           bool
	staticOnly?:            bool
	scrollToOpen?:          bool
}

// dock generates defaults actions for Dock configuration
// Usage: (helpers.#Dock & {opts: {...}}).out
#Dock: {
	opts: #DockOptions
	let _d = "com.apple.dock"

	out: [
		if opts.autohide != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "autohide", value: opts.autohide}
		},
		if opts.autohideDelay != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "autohide-delay", value: opts.autohideDelay, valueType: "float"}
		},
		if opts.autohideTimeModifier != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "autohide-time-modifier", value: opts.autohideTimeModifier, valueType: "float"}
		},
		if opts.magnification != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "magnification", value: opts.magnification}
		},
		if opts.magnificationSize != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "largesize", value: opts.magnificationSize, valueType: "int"}
		},
		if opts.tileSize != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "tilesize", value: opts.tileSize, valueType: "int"}
		},
		if opts.orientation != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "orientation", value: opts.orientation}
		},
		if opts.minimizeEffect != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "mineffect", value: opts.minimizeEffect}
		},
		if opts.minimizeToApplication != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "minimize-to-application", value: opts.minimizeToApplication}
		},
		if opts.showIndicatorLights != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "show-process-indicators", value: opts.showIndicatorLights}
		},
		if opts.showRecents != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "show-recents", value: opts.showRecents}
		},
		if opts.staticOnly != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "static-only", value: opts.staticOnly}
		},
		if opts.scrollToOpen != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "scroll-to-open", value: opts.scrollToOpen}
		},
	]
}

// =============================================================================
// Finder Configuration
// =============================================================================

#FinderOptions: {
	showHiddenFiles?:            bool
	showPathBar?:                bool
	showStatusBar?:              bool
	showExtensions?:             bool
	defaultViewStyle?:           "icnv" | "Nlsv" | "clmv" | "Flwv"
	newWindowTarget?:            "PfHm" | "PfDe" | "PfDo" | "PfAF"
	desktopShowHardDrives?:      bool
	desktopShowExternalDrives?:  bool
	desktopShowRemovableDrives?: bool
	desktopShowServers?:         bool
	warningOnEmptyTrash?:        bool
	warningOnChangeExtension?:   bool
	searchScope?:                "SCev" | "SCcf" | "SCsp"
	keepFoldersOnTop?:           bool
}

#Finder: {
	opts: #FinderOptions
	let _d = "com.apple.finder"
	let _g = "NSGlobalDomain"

	out: [
		if opts.showHiddenFiles != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "AppleShowAllFiles", value: opts.showHiddenFiles}
		},
		if opts.showPathBar != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowPathbar", value: opts.showPathBar}
		},
		if opts.showStatusBar != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowStatusBar", value: opts.showStatusBar}
		},
		if opts.showExtensions != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "AppleShowAllExtensions", value: opts.showExtensions}
		},
		if opts.defaultViewStyle != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "FXPreferredViewStyle", value: opts.defaultViewStyle}
		},
		if opts.newWindowTarget != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "NewWindowTarget", value: opts.newWindowTarget}
		},
		if opts.desktopShowHardDrives != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowHardDrivesOnDesktop", value: opts.desktopShowHardDrives}
		},
		if opts.desktopShowExternalDrives != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowExternalHardDrivesOnDesktop", value: opts.desktopShowExternalDrives}
		},
		if opts.desktopShowRemovableDrives != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowRemovableMediaOnDesktop", value: opts.desktopShowRemovableDrives}
		},
		if opts.desktopShowServers != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "ShowMountedServersOnDesktop", value: opts.desktopShowServers}
		},
		if opts.warningOnEmptyTrash != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "WarnOnEmptyTrash", value: opts.warningOnEmptyTrash}
		},
		if opts.warningOnChangeExtension != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "FXEnableExtensionChangeWarning", value: opts.warningOnChangeExtension}
		},
		if opts.searchScope != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "FXDefaultSearchScope", value: opts.searchScope}
		},
		if opts.keepFoldersOnTop != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "_FXSortFoldersFirst", value: opts.keepFoldersOnTop}
		},
	]
}

// =============================================================================
// Keyboard Configuration
// =============================================================================

#KeyboardOptions: {
	keyRepeatRate?:               int & >=1 & <=120
	keyRepeatDelay?:              int & >=15 & <=120
	automaticCapitalization?:     bool
	automaticSpelling?:           bool
	automaticPeriodSubstitution?: bool
	automaticQuoteSubstitution?:  bool
	automaticDashSubstitution?:   bool
	pressAndHoldEnabled?:         bool
}

#Keyboard: {
	opts: #KeyboardOptions
	let _g = "NSGlobalDomain"

	out: [
		if opts.keyRepeatRate != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "KeyRepeat", value: opts.keyRepeatRate, valueType: "int"}
		},
		if opts.keyRepeatDelay != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "InitialKeyRepeat", value: opts.keyRepeatDelay, valueType: "int"}
		},
		if opts.automaticCapitalization != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "NSAutomaticCapitalizationEnabled", value: opts.automaticCapitalization}
		},
		if opts.automaticSpelling != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "NSAutomaticSpellingCorrectionEnabled", value: opts.automaticSpelling}
		},
		if opts.automaticPeriodSubstitution != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "NSAutomaticPeriodSubstitutionEnabled", value: opts.automaticPeriodSubstitution}
		},
		if opts.automaticQuoteSubstitution != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "NSAutomaticQuoteSubstitutionEnabled", value: opts.automaticQuoteSubstitution}
		},
		if opts.automaticDashSubstitution != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "NSAutomaticDashSubstitutionEnabled", value: opts.automaticDashSubstitution}
		},
		if opts.pressAndHoldEnabled != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "ApplePressAndHoldEnabled", value: opts.pressAndHoldEnabled}
		},
	]
}

// =============================================================================
// Trackpad Configuration
// =============================================================================

#TrackpadOptions: {
	tapToClick?:       bool
	naturalScrolling?: bool
	trackingSpeed?:    number & >=0 & <=3
	threeFingerDrag?:  bool
}

#Trackpad: {
	opts: #TrackpadOptions
	let _t = "com.apple.AppleMultitouchTrackpad"
	let _bt = "com.apple.driver.AppleBluetoothMultitouch.trackpad"
	let _g = "NSGlobalDomain"

	out: [
		if opts.tapToClick != _|_ {
			schema.#Defaults & {type: "defaults", domain: _t, key: "Clicking", value: opts.tapToClick}
		},
		if opts.tapToClick != _|_ {
			schema.#Defaults & {type: "defaults", domain: _bt, key: "Clicking", value: opts.tapToClick}
		},
		if opts.naturalScrolling != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "com.apple.swipescrolldirection", value: opts.naturalScrolling}
		},
		if opts.trackingSpeed != _|_ {
			schema.#Defaults & {type: "defaults", domain: _g, key: "com.apple.trackpad.scaling", value: opts.trackingSpeed, valueType: "float"}
		},
		if opts.threeFingerDrag != _|_ {
			schema.#Defaults & {type: "defaults", domain: _t, key: "TrackpadThreeFingerDrag", value: opts.threeFingerDrag}
		},
		if opts.threeFingerDrag != _|_ {
			schema.#Defaults & {type: "defaults", domain: _bt, key: "TrackpadThreeFingerDrag", value: opts.threeFingerDrag}
		},
	]
}

// =============================================================================
// Mission Control Configuration
// =============================================================================

#MissionControlOptions: {
	animationSpeed?:      number
	groupByApp?:          bool
	separateSpaces?:      bool
	autoRearrangeSpaces?: bool
	hotCorners?: {
		topLeft?:     #HotCornerAction
		topRight?:    #HotCornerAction
		bottomLeft?:  #HotCornerAction
		bottomRight?: #HotCornerAction
	}
}

#MissionControl: {
	opts: #MissionControlOptions
	let _d = "com.apple.dock"
	let _s = "com.apple.spaces"

	out: [
		if opts.animationSpeed != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "expose-animation-duration", value: opts.animationSpeed, valueType: "float"}
		},
		if opts.groupByApp != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "expose-group-apps", value: opts.groupByApp}
		},
		if opts.separateSpaces != _|_ {
			schema.#Defaults & {type: "defaults", domain: _s, key: "spans-displays", value: !opts.separateSpaces}
		},
		if opts.autoRearrangeSpaces != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "mru-spaces", value: opts.autoRearrangeSpaces}
		},
		// Hot corners - top left
		if opts.hotCorners != _|_ if opts.hotCorners.topLeft != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-tl-corner", value: _hotCornerValues[opts.hotCorners.topLeft], valueType: "int"}
		},
		if opts.hotCorners != _|_ if opts.hotCorners.topLeft != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-tl-modifier", value: 0, valueType: "int"}
		},
		// Hot corners - top right
		if opts.hotCorners != _|_ if opts.hotCorners.topRight != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-tr-corner", value: _hotCornerValues[opts.hotCorners.topRight], valueType: "int"}
		},
		if opts.hotCorners != _|_ if opts.hotCorners.topRight != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-tr-modifier", value: 0, valueType: "int"}
		},
		// Hot corners - bottom left
		if opts.hotCorners != _|_ if opts.hotCorners.bottomLeft != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-bl-corner", value: _hotCornerValues[opts.hotCorners.bottomLeft], valueType: "int"}
		},
		if opts.hotCorners != _|_ if opts.hotCorners.bottomLeft != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-bl-modifier", value: 0, valueType: "int"}
		},
		// Hot corners - bottom right
		if opts.hotCorners != _|_ if opts.hotCorners.bottomRight != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-br-corner", value: _hotCornerValues[opts.hotCorners.bottomRight], valueType: "int"}
		},
		if opts.hotCorners != _|_ if opts.hotCorners.bottomRight != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "wvous-br-modifier", value: 0, valueType: "int"}
		},
	]
}

// =============================================================================
// Screen Saver Configuration
// =============================================================================

#ScreenSaverOptions: {
	requirePasswordAfterSleep?: bool
	passwordDelay?:             int & >=0
}

#ScreenSaver: {
	opts: #ScreenSaverOptions
	let _d = "com.apple.screensaver"

	out: [
		if opts.requirePasswordAfterSleep != _|_ {
			schema.#Defaults & {
				type: "defaults", domain: _d, key: "askForPassword"
				value: [if opts.requirePasswordAfterSleep {1}, if !opts.requirePasswordAfterSleep {0}][0]
				valueType: "int"
			}
		},
		if opts.passwordDelay != _|_ {
			schema.#Defaults & {type: "defaults", domain: _d, key: "askForPasswordDelay", value: opts.passwordDelay, valueType: "int"}
		},
	]
}
