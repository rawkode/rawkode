import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import Quickshell
import Quickshell.Services.Pipewire
import Quickshell.Services.SystemTray
import Quickshell.Services.UPower

PanelWindow {
    id: bar
    anchors {
        top: true
        left: true
        right: true
    }
    implicitHeight: Settings.barHeight
    color: Settings.background
    property bool fullBar: screen.name !== "DP-2"
    property var sink: Pipewire.defaultAudioSink
    property var connectedNetwork: Desktop.connectivity.networks.find(n => n.connected)
    PwObjectTracker {
        objects: [bar.sink]
    }
    SystemClock {
        id: clock
        precision: SystemClock.Minutes
    }

    Rectangle {
        anchors.bottom: parent.bottom
        width: parent.width
        height: 1
        color: Settings.surface
    }
    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 10
        spacing: 12
        Item {
            Layout.fillWidth: true
            Layout.preferredWidth: Math.max(0, (bar.width - (bar.width < 1100 ? 64 : 190) - 44) / 2)
            Layout.fillHeight: true
            clip: true
            Flickable {
                anchors.fill: parent
                contentWidth: workspaces.implicitWidth
                contentHeight: height
                flickableDirection: Flickable.HorizontalFlick
                RowLayout {
                    id: workspaces
                    height: parent.height
                    spacing: 4
                    Repeater {
                        model: Desktop.workspaces.filter(w => w.output === bar.screen.name).sort((a, b) => a.idx - b.idx)
                        ShellButton {
                            required property var modelData
                            implicitHeight: 28
                            leftPadding: 10
                            rightPadding: 10
                            text: modelData.name || String(modelData.idx)
                            description: "Workspace " + text
                            selected: modelData.is_active
                            flat: true
                            font.bold: modelData.is_active
                            onClicked: Quickshell.execDetached(["niri", "msg", "action", "focus-workspace", String(modelData.idx)])
                        }
                    }
                }
            }
        }
        RowLayout {
            visible: bar.fullBar
            Layout.fillWidth: false
            Layout.preferredWidth: bar.width < 1100 ? 64 : 190
            Layout.alignment: Qt.AlignHCenter
            spacing: 10
            Item {
                Layout.fillWidth: true
            }
            ShellText {
                text: Qt.formatDateTime(clock.date, "HH:mm")
                font.pixelSize: 14
                font.bold: true
            }
            ShellText {
                visible: bar.width >= 1100
                text: Qt.formatDateTime(clock.date, "ddd, d MMM")
                color: Settings.muted
                font.pixelSize: 12
            }
            Item {
                Layout.fillWidth: true
            }
        }
        Item {
            id: statusArea
            Layout.minimumWidth: bar.fullBar ? Math.min(statusRow.implicitWidth, bar.width * 0.60) : 0
            Layout.fillWidth: true
            Layout.preferredWidth: Math.max(0, (bar.width - (bar.width < 1100 ? 64 : 190) - 44) / 2)
            Layout.fillHeight: true
            clip: true
            RowLayout {
                id: statusRow
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                spacing: 4
                ShellButton {
                    visible: bar.fullBar
                    glyph: Desktop.connectivity.wifiPowered ? "󰤨" : "󰤭"
                    text: bar.width >= 1400 && bar.connectedNetwork ? bar.connectedNetwork.name.slice(0, 16) : ""
                    description: bar.connectedNetwork ? "Wi-Fi: " + bar.connectedNetwork.name : "Wi-Fi connections"
                    selected: Desktop.panel === "connectivity" && Desktop.panelScreen === bar.screen.name
                    flat: true
                    implicitHeight: 28
                    onPressed: Desktop.toggle("connectivity", bar.screen.name)
                }
                ShellButton {
                    visible: bar.fullBar
                    glyph: Desktop.connectivity.bluetoothPowered ? "󰂯" : "󰂲"
                    description: "Bluetooth devices"
                    selected: Desktop.panel === "connectivity" && Desktop.panelScreen === bar.screen.name
                    flat: true
                    implicitHeight: 28
                    onPressed: Desktop.toggle("connectivity", bar.screen.name)
                }
                ShellButton {
                    visible: bar.fullBar
                    glyph: bar.sink && bar.sink.audio && bar.sink.audio.muted ? "󰝟" : "󰕾"
                    text: bar.width >= 1000 && bar.sink && bar.sink.audio ? Math.round(bar.sink.audio.volume * 100) + "%" : ""
                    description: "Audio settings"
                    flat: true
                    implicitHeight: 28
                    onClicked: Quickshell.execDetached(["pavucontrol"])
                }
                Rectangle {
                    visible: bar.fullBar && SystemTray.items.values.length > 0
                    width: 1
                    height: 16
                    color: Settings.raised
                    Layout.leftMargin: 4
                    Layout.rightMargin: 4
                }
                Item {
                    visible: bar.fullBar && SystemTray.items.values.length > 0
                    implicitWidth: Math.min(112, trayRow.implicitWidth)
                    implicitHeight: 28
                    clip: true
                    Flickable {
                        anchors.fill: parent
                        contentWidth: trayRow.implicitWidth
                        contentHeight: height
                        flickableDirection: Flickable.HorizontalFlick
                        RowLayout {
                            id: trayRow
                            height: parent.height
                            spacing: 2
                            Repeater {
                                model: SystemTray.items
                                FocusScope {
                                    id: trayItem
                                    required property var modelData
                                    implicitWidth: 28
                                    implicitHeight: 28
                                    activeFocusOnTab: true
                                    Accessible.role: Accessible.Button
                                    Accessible.name: modelData.tooltipTitle || modelData.title || modelData.id
                                    Accessible.onPressAction: activate()
                                    function openMenu() {
                                        if (modelData.hasMenu)
                                            modelData.display(bar, trayItem.mapToItem(bar.contentItem, 0, height).x, bar.height);
                                    }
                                    function activate() {
                                        if (modelData.onlyMenu)
                                            openMenu();
                                        else
                                            modelData.activate();
                                    }
                                    Keys.onReturnPressed: activate()
                                    Keys.onSpacePressed: activate()
                                    Keys.onPressed: event => {
                                        if (event.key === Qt.Key_Menu) {
                                            openMenu();
                                            event.accepted = true;
                                        }
                                    }
                                    Rectangle {
                                        anchors.fill: parent
                                        radius: 6
                                        color: trayMouse.containsMouse || trayItem.activeFocus ? Settings.raised : "transparent"
                                        border.width: trayItem.activeFocus ? 1 : 0
                                        border.color: Settings.accent
                                    }
                                    Image {
                                        anchors.centerIn: parent
                                        width: 18
                                        height: 18
                                        source: trayItem.modelData.icon
                                    }
                                    ToolTip.visible: trayMouse.containsMouse
                                    ToolTip.text: modelData.tooltipTitle || modelData.title
                                    ToolTip.delay: 600
                                    MouseArea {
                                        id: trayMouse
                                        anchors.fill: parent
                                        hoverEnabled: true
                                        acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
                                        onClicked: event => {
                                            if (event.button === Qt.MiddleButton)
                                                modelData.secondaryActivate();
                                            else if (event.button === Qt.RightButton)
                                                trayItem.openMenu();
                                            else
                                                trayItem.activate();
                                        }
                                        onWheel: event => modelData.scroll(event.angleDelta.y, false)
                                    }
                                }
                            }
                        }
                    }
                }
                RowLayout {
                    visible: bar.fullBar && UPower.displayDevice.isLaptopBattery
                    spacing: 6
                    Layout.leftMargin: 8
                    Layout.rightMargin: 8
                    ShellIcon {
                        text: "󰁹"
                        font.pixelSize: 16
                        color: UPower.displayDevice.percentage < 0.2 ? Settings.error : Settings.text
                    }
                    ShellText {
                        visible: bar.width >= 1000
                        text: Math.round(UPower.displayDevice.percentage * 100) + "%"
                        font.pixelSize: 12
                    }
                }
                ShellButton {
                    visible: bar.fullBar
                    glyph: Desktop.dnd ? "󰂛" : "󰂚"
                    text: Desktop.notifications.values.length > 0 ? String(Desktop.notifications.values.length) : ""
                    description: Desktop.dnd ? "Notifications · do not disturb" : "Notifications"
                    selected: Desktop.panel === "notifications" && Desktop.panelScreen === bar.screen.name
                    flat: true
                    implicitHeight: 28
                    onPressed: Desktop.toggle("notifications", bar.screen.name)
                }
            }
        }
    }
}
