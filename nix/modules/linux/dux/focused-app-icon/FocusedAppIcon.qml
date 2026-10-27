import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Widgets
import qs.Common
import qs.Services
import qs.Modules.Plugins

// Icon-only counterpart to the built-in focusedWindow widget, using the same
// window and desktop-entry lookups.
PluginComponent {
	id: root

	property var activeWindow: null
	property var activeDesktopEntry: null

	// The shared iconSizeLarge suits glyphs; an app icon should nearly fill the pill.
	readonly property int appIconSize: 2 * Math.round(root.widgetThickness * 0.4)
	readonly property string screenName: parentScreen?.name ?? ""
	readonly property Toplevel managerActiveToplevel: ToplevelManager.activeToplevel
	readonly property string iconSource: activeWindow && activeWindow.appId ? Paths.getAppIcon(activeWindow.appId, activeDesktopEntry) : ""
	readonly property bool hasWindow: {
		CompositorService.windowStateRevision;
		if (!activeWindow || !activeWindow.appId)
			return false;
		return CompositorService.windowOnActiveWorkspace(screenName, activeWindow, false);
	}

	function updateActiveWindow() {
		activeWindow = CompositorService.activeWindowForScreen(screenName || null, activeWindow, false);
	}

	function updateDesktopEntry() {
		activeDesktopEntry = activeWindow && activeWindow.appId ? DesktopEntries.heuristicLookup(Paths.moddedAppId(activeWindow.appId)) : null;
	}

	// Collapse the pill on empty workspaces rather than leaving a blank chip.
	onHasWindowChanged: setVisibilityOverride(hasWindow)
	onManagerActiveToplevelChanged: updateActiveWindow()
	onActiveWindowChanged: updateDesktopEntry()
	onScreenNameChanged: updateActiveWindow()

	Component.onCompleted: {
		updateActiveWindow();
		updateDesktopEntry();
		setVisibilityOverride(hasWindow);
	}

	Connections {
		target: CompositorService
		function onToplevelsChanged() {
			root.updateActiveWindow();
		}
		function onWorkspaceStateChanged() {
			root.updateActiveWindow();
		}
	}

	Connections {
		target: DesktopEntries
		function onApplicationsChanged() {
			root.updateDesktopEntry();
		}
	}

	horizontalBarPill: Component {
		IconImage {
			implicitWidth: root.appIconSize
			implicitHeight: root.appIconSize
			source: root.iconSource
			smooth: true
			mipmap: true
			asynchronous: true
		}
	}

	verticalBarPill: Component {
		IconImage {
			implicitWidth: root.appIconSize
			implicitHeight: root.appIconSize
			source: root.iconSource
			smooth: true
			mipmap: true
			asynchronous: true
		}
	}
}
