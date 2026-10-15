pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Services.Notifications

Singleton {
    id: root
    property string panel: ""
    property string panelScreen: ""
    property bool dnd: false
    onDndChanged: if (dnd)
        toastIds = []
    property var connectivity: ({
            networks: [],
            devices: []
        })
    property var workspaces: []
    property var toastIds: []
    property alias notifications: server.trackedNotifications

    function toggle(name, screen) {
        const nextPanel = panel === name ? "" : name;
        panelScreen = screen;
        panel = nextPanel;
    }
    function send(command) {
        if (bridge.running)
            bridge.write(JSON.stringify(command) + "\n");
    }
    function hideToast(id) {
        toastIds = toastIds.filter(value => value !== id);
    }
    function clearNotifications() {
        const copy = server.trackedNotifications.values.slice();
        copy.forEach(n => n.dismiss());
    }

    NotificationServer {
        id: server
        bodySupported: true
        actionsSupported: true
        imageSupported: true
        persistenceSupported: true
        keepOnReload: true
        onNotification: notification => {
            notification.tracked = true;
            if (!root.dnd && !notification.lastGeneration)
                root.toastIds = [...root.toastIds.filter(id => id !== notification.id), notification.id].slice(-3);
        }
    }

    Process {
        id: bridge
        command: [Settings.connectivity]
        stdinEnabled: true
        running: true
        stdout: SplitParser {
            onRead: data => {
                try {
                    root.connectivity = JSON.parse(data);
                } catch (error) {
                    console.warn("Invalid connectivity snapshot");
                }
            }
        }
        onExited: {
            root.connectivity = {
                networks: [],
                devices: [],
                error: "Connectivity service stopped. Reconnecting…"
            };
            bridgeRetry.start();
        }
    }
    Timer {
        id: bridgeRetry
        interval: 3000
        onTriggered: bridge.running = true
    }

    Process {
        id: events
        command: ["niri", "msg", "--json", "event-stream"]
        running: true
        stdout: SplitParser {
            onRead: data => {
                try {
                    const event = JSON.parse(data);
                    if (event.WorkspacesChanged)
                        root.workspaces = event.WorkspacesChanged.workspaces;
                    if (event.WorkspaceActivated) {
                        const active = event.WorkspaceActivated;
                        const workspace = root.workspaces.find(w => w.id === active.id);
                        root.workspaces = root.workspaces.map(w => Object.assign({}, w, {
                                is_active: workspace && w.output === workspace.output ? w.id === active.id : w.is_active,
                                is_focused: active.focused ? w.id === active.id : w.is_focused
                            }));
                    }
                } catch (error) {
                    console.warn("Invalid Niri event");
                }
            }
        }
        onExited: niriRetry.start()
    }
    Timer {
        id: niriRetry
        interval: 3000
        onTriggered: events.running = true
    }
    IpcHandler {
        target: "panel"
        function toggle(name: string): void {
            const focused = root.workspaces.find(w => w.is_focused);
            root.toggle(name, focused ? focused.output : (Quickshell.screens.length ? Quickshell.screens[0].name : ""));
        }
    }
}
