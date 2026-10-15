import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland

PanelWindow {
    id: panel
    required property var output
    property bool requested: Desktop.panel !== "" && Desktop.panelScreen === output.name
    screen: output
    visible: requested
    anchors {
        top: true
        right: true
    }
    margins.top: Settings.barHeight + 12
    margins.right: 12
    exclusiveZone: 0
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.OnDemand
    implicitWidth: Math.min(420, output.width - 24)
    implicitHeight: Math.min(680, output.height - Settings.barHeight - 24)
    color: "transparent"

    function dismiss() {
        if (Desktop.panelScreen === output.name)
            Desktop.panel = "";
    }
    onClosed: if (!visible && requested)
        dismiss()
    onVisibleChanged: {
        if (visible)
            content.forceActiveFocus();
        else if (requested)
            dismiss();
    }

    Rectangle {
        anchors.fill: parent
        color: Settings.background
        radius: 12
        border.width: 1
        border.color: Settings.raised
    }
    Control {
        anchors.fill: parent
        font.family: Settings.font
        font.pixelSize: 13
        palette.window: Settings.background
        palette.base: Settings.surface
        palette.button: Settings.surface
        palette.text: Settings.text
        palette.windowText: Settings.text
        palette.buttonText: Settings.text
        palette.highlight: Settings.accent
        ColumnLayout {
            id: content
            anchors.fill: parent
            anchors.margins: 20
            spacing: 18
            Keys.onEscapePressed: panel.dismiss()
            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                ShellIcon {
                    text: Desktop.panel === "notifications" ? "󰂚" : "󰖩"
                    color: Settings.accent
                    font.pixelSize: 22
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4
                    ShellText {
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                        text: Desktop.panel === "notifications" ? "Notifications" : "Connections"
                        font.pixelSize: 18
                        font.bold: true
                    }
                    ShellText {
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                        text: Desktop.panel === "notifications" ? Qt.formatDateTime(new Date(), "dddd, d MMMM") : "Wi-Fi & Bluetooth"
                        color: Settings.muted
                        font.pixelSize: 12
                    }
                }
                ShellButton {
                    glyph: "󰅖"
                    description: "Close panel · Esc"
                    flat: true
                    onClicked: panel.dismiss()
                }
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: 1
                color: Settings.raised
            }
            RowLayout {
                visible: Desktop.panel === "notifications"
                Layout.fillWidth: true
                spacing: 10
                ShellIcon {
                    text: "󰂛"
                    color: Desktop.dnd ? Settings.accent : Settings.muted
                    font.pixelSize: 18
                }
                ShellText {
                    text: "Do not disturb"
                    Layout.fillWidth: true
                }
                ShellSwitch {
                    Accessible.name: "Do not disturb"
                    checked: Desktop.dnd
                    onToggled: Desktop.dnd = checked
                }
                ShellButton {
                    glyph: "󰆴"
                    description: "Clear all notifications"
                    flat: true
                    enabled: Desktop.notifications.values.length > 0
                    onClicked: Desktop.clearNotifications()
                }
            }
            Item {
                visible: Desktop.panel === "notifications" && Desktop.notifications.values.length === 0
                Layout.fillWidth: true
                Layout.fillHeight: true
                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: 12
                    Rectangle {
                        Layout.alignment: Qt.AlignHCenter
                        width: 64
                        height: 64
                        radius: 32
                        color: Settings.surface
                        ShellIcon {
                            anchors.centerIn: parent
                            text: "󰂜"
                            font.pixelSize: 28
                            color: Settings.muted
                        }
                    }
                    ShellText {
                        text: "No notifications"
                        font.pixelSize: 15
                        font.bold: true
                        Layout.alignment: Qt.AlignHCenter
                    }
                    ShellText {
                        text: "New notifications appear here."
                        color: Settings.muted
                        font.pixelSize: 12
                        Layout.alignment: Qt.AlignHCenter
                    }
                }
            }
            ScrollView {
                visible: Desktop.panel !== "notifications" || Desktop.notifications.values.length > 0
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: availableWidth
                clip: true
                ColumnLayout {
                    width: parent.width
                    spacing: 10
                    Connectivity {
                        visible: Desktop.panel === "connectivity"
                        Layout.fillWidth: true
                    }
                    Repeater {
                        model: Desktop.panel === "notifications" ? Desktop.notifications : null
                        NotificationItem {
                            required property var modelData
                            notification: modelData
                            Layout.fillWidth: true
                        }
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                ShellText {
                    text: "ESC"
                    font.pixelSize: 10
                    color: Settings.muted
                }
                ShellText {
                    text: "to close"
                    font.pixelSize: 11
                    color: Settings.muted
                }
                Item {
                    Layout.fillWidth: true
                }
                ShellText {
                    visible: Desktop.panel === "notifications"
                    text: Desktop.notifications.values.length + " notifications"
                    font.pixelSize: 11
                    color: Settings.muted
                }
            }
        }
    }
}
