import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland

PanelWindow {
    id: toasts
    required property var output
    screen: output
    property var items: Desktop.notifications.values.filter(n => Desktop.toastIds.indexOf(n.id) !== -1)
    visible: !Desktop.dnd && Desktop.panel === "" && items.length > 0 && output === Quickshell.screens[0]
    anchors {
        top: true
        right: true
    }
    margins.top: Settings.barHeight + 12
    margins.right: 12
    implicitWidth: Math.min(400, output.width - 24)
    implicitHeight: Math.min(output.height - 40, list.implicitHeight)
    exclusionMode: ExclusionMode.Ignore
    exclusiveZone: 0
    color: "transparent"
    WlrLayershell.layer: WlrLayer.Overlay
    ColumnLayout {
        id: list
        width: parent.width
        spacing: 10
        Repeater {
            model: toasts.items.slice(-3)
            NotificationItem {
                required property var modelData
                notification: modelData
                toast: true
                Layout.fillWidth: true
            }
        }
    }
}
