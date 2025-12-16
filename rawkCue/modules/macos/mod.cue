package macos

import (
	"list"

	"github.com/rawkode/rawkcue/schema"
	"github.com/rawkode/rawkcue/schema/helpers"
)

let _dock = (helpers.#Dock & {opts: {
	autohide:              true
	autohideDelay:         0
	autohideTimeModifier:  0.15
	tileSize:              64
	magnification:         true
	magnificationSize:     128
	orientation:           "bottom"
	minimizeToApplication: true
	showIndicatorLights:   true
	showRecents:           false
}}).out

let _finder = (helpers.#Finder & {opts: {
	defaultViewStyle:           "Nlsv"
	newWindowTarget:            "PfAF"
	desktopShowHardDrives:      false
	desktopShowExternalDrives:  true
	desktopShowRemovableDrives: true
}}).out

let _missionControl = (helpers.#MissionControl & {opts: {
	animationSpeed:      0.2
	groupByApp:          true
	autoRearrangeSpaces: false
	separateSpaces:      true
	hotCorners: {
		topLeft:     "missionControl"
		topRight:    "none"
		bottomLeft:  "appWindows"
		bottomRight: "desktop"
	}
}}).out

macos: schema.#Module & {
	name: "macos"
	tags: ["system", "macos"]
	when: [{platformIn: ["darwin"]}]

	// Compose actions from helpers + standalone defaults
	actions: list.Concat([
		_dock,
		_finder,
		_missionControl,
		[
			schema.#Defaults & {
				type:   "defaults"
				domain: "NSGlobalDomain"
				key:    "AppleInterfaceStyleSwitchesAutomatically"
				value:  true
			},
			schema.#Defaults & {
				type:   "defaults"
				domain: "NSGlobalDomain"
				key:    "NSFileViewer"
				value:  "com.asiafu.Bloom"
			},
		],
	])
}
