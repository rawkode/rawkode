import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell

ColumnLayout {
    id: root
    property var state: Desktop.connectivity
    property var selectedNetwork: null
    property var connectedNetwork: (state.networks || []).find(n => n.connected)
    spacing: 10

    Rectangle {
        visible: !!root.state.error
        Layout.fillWidth: true
        implicitHeight: errorRow.implicitHeight + 24
        radius: 8
        color: Settings.tint(Settings.error, 0.10)
        RowLayout {
            id: errorRow
            anchors.fill: parent
            anchors.margins: 12
            spacing: 10
            ShellIcon {
                text: "󰀦"
                color: Settings.error
            }
            ShellText {
                text: root.state.error || ""
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
        }
    }
    RowLayout {
        visible: !!root.state.busy
        spacing: 8
        BusyIndicator {
            implicitWidth: 20
            implicitHeight: 20
            running: parent.visible
        }
        ShellText {
            text: "Updating connection…"
            color: Settings.muted
            font.pixelSize: 12
        }
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        ShellIcon {
            text: "󰖩"
            color: root.state.wifiPowered ? Settings.accent : Settings.muted
            font.pixelSize: 22
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4
            ShellText {
                text: "Wi-Fi"
                font.pixelSize: 15
                font.bold: true
            }
            ShellText {
                text: !root.state.wifiAvailable ? "No adapter found" : !root.state.wifiPowered ? "Turned off" : root.connectedNetwork ? root.connectedNetwork.name : "Not connected"
                color: Settings.muted
                font.pixelSize: 11
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
        }
        ShellButton {
            glyph: "󰑐"
            description: "Scan for Wi-Fi networks"
            flat: true
            enabled: !!root.state.wifiPowered && !root.state.busy
            onClicked: Desktop.send({
                action: "wifi-scan"
            })
        }
        ShellSwitch {
            Accessible.name: "Wi-Fi power"
            enabled: !!root.state.wifiAvailable && !root.state.busy
            checked: !!root.state.wifiPowered
            onToggled: Desktop.send({
                action: "wifi-power",
                enabled: checked
            })
        }
    }
    ShellText {
        visible: !root.state.wifiPowered || (root.state.networks || []).length === 0
        text: !root.state.wifiAvailable ? "Connect a Wi-Fi adapter to get started." : !root.state.wifiPowered ? "Turn on Wi-Fi to see nearby networks." : "No networks found. Scan to search nearby."
        color: Settings.muted
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
        Layout.topMargin: 8
        Layout.bottomMargin: 8
    }
    Repeater {
        model: root.state.wifiPowered ? (root.state.networks || []).slice().sort((a, b) => Number(b.connected) - Number(a.connected)) : []
        ConnectionRow {
            required property var modelData
            Layout.fillWidth: true
            title: modelData.name
            detail: modelData.connected ? "Connected" : modelData.security === "open" ? "Open network" : modelData.security === "psk" ? "Password protected" : "Advanced authentication"
            glyph: modelData.signal > -5500 ? "󰤨" : modelData.signal > -7000 ? "󰤥" : "󰤢"
            connected: modelData.connected
            actionText: connected ? "Disconnect" : "Connect"
            busy: !!root.state.busy
            onActivated: {
                password.clear();
                if (modelData.connected)
                    Desktop.send({
                        action: "wifi-disconnect"
                    });
                else if (modelData.security === "open")
                    Desktop.send({
                        action: "wifi-connect",
                        path: modelData.path
                    });
                else if (modelData.security !== "psk")
                    Quickshell.execDetached(["iwgtk"]);
                else {
                    root.selectedNetwork = modelData;
                    password.forceActiveFocus();
                }
            }
        }
    }
    Rectangle {
        visible: root.selectedNetwork !== null
        Layout.fillWidth: true
        implicitHeight: credentials.implicitHeight + 28
        color: Settings.surface
        radius: 8
        ColumnLayout {
            id: credentials
            anchors.fill: parent
            anchors.margins: 14
            spacing: 10
            ShellText {
                text: root.selectedNetwork ? "Connect to " + root.selectedNetwork.name : ""
                font.bold: true
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
            ShellField {
                id: password
                Layout.fillWidth: true
                placeholderText: "Wi-Fi password"
                echoMode: TextInput.Password
                Accessible.name: "Wi-Fi password"
            }
            ShellText {
                text: "Leave blank to use a saved password."
                font.pixelSize: 11
                color: Settings.muted
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
            RowLayout {
                Item {
                    Layout.fillWidth: true
                }
                ShellButton {
                    text: "Cancel"
                    flat: true
                    onClicked: {
                        password.clear();
                        root.selectedNetwork = null;
                    }
                }
                ShellButton {
                    text: "Connect"
                    primary: true
                    enabled: !root.state.busy
                    onClicked: {
                        Desktop.send({
                            action: "wifi-connect",
                            path: root.selectedNetwork.path,
                            passphrase: password.text
                        });
                        password.clear();
                        root.selectedNetwork = null;
                    }
                }
            }
        }
    }
    ShellButton {
        text: "Advanced Wi-Fi settings"
        glyph: "󰒓"
        flat: true
        onClicked: Quickshell.execDetached(["iwgtk"])
    }
    Rectangle {
        Layout.fillWidth: true
        implicitHeight: 1
        color: Settings.raised
        Layout.topMargin: 10
        Layout.bottomMargin: 10
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        ShellIcon {
            text: "󰂯"
            color: root.state.bluetoothPowered ? Settings.accent : Settings.muted
            font.pixelSize: 22
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4
            ShellText {
                text: "Bluetooth"
                font.pixelSize: 15
                font.bold: true
            }
            ShellText {
                text: !root.state.bluetoothAvailable ? "No adapter found" : !root.state.bluetoothPowered ? "Turned off" : root.state.bluetoothDiscovering ? "Searching for devices…" : "Ready to connect"
                color: Settings.muted
                font.pixelSize: 11
                Layout.fillWidth: true
            }
        }
        ShellButton {
            glyph: root.state.bluetoothDiscovering ? "󰓛" : "󰑐"
            description: root.state.bluetoothDiscovering ? "Stop Bluetooth scan" : "Scan for Bluetooth devices"
            flat: true
            enabled: !!root.state.bluetoothPowered && !root.state.busy
            onClicked: Desktop.send({
                action: "bluetooth-scan",
                enabled: !root.state.bluetoothDiscovering
            })
        }
        ShellSwitch {
            Accessible.name: "Bluetooth power"
            enabled: !!root.state.bluetoothAvailable && !root.state.busy
            checked: !!root.state.bluetoothPowered
            onToggled: Desktop.send({
                action: "bluetooth-power",
                enabled: checked
            })
        }
    }
    ShellText {
        visible: !root.state.bluetoothPowered || (root.state.devices || []).length === 0
        text: !root.state.bluetoothAvailable ? "Connect a Bluetooth adapter to get started." : !root.state.bluetoothPowered ? "Turn on Bluetooth to connect your devices." : "No devices found. Scan or pair a new device."
        color: Settings.muted
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
        Layout.topMargin: 8
        Layout.bottomMargin: 8
    }
    Repeater {
        model: root.state.bluetoothPowered ? (root.state.devices || []).slice().sort((a, b) => Number(b.connected) - Number(a.connected)) : []
        ConnectionRow {
            required property var modelData
            Layout.fillWidth: true
            title: modelData.name
            detail: modelData.connected ? "Connected" : modelData.paired ? "Paired · disconnected" : "Available to pair"
            glyph: "󰂱"
            connected: modelData.connected
            actionText: connected ? "Disconnect" : modelData.paired ? "Connect" : "Pair…"
            busy: !!root.state.busy
            onActivated: {
                if (!modelData.paired)
                    Quickshell.execDetached(["blueman-manager"]);
                else
                    Desktop.send({
                        action: modelData.connected ? "bluetooth-disconnect" : "bluetooth-connect",
                        path: modelData.path
                    });
            }
        }
    }
    ShellButton {
        text: "Pair a new device…"
        glyph: "󰐕"
        flat: true
        onClicked: Quickshell.execDetached(["blueman-manager"])
    }
    Connections {
        target: Desktop
        function onPanelChanged() {
            password.clear();
            root.selectedNetwork = null;
        }
    }
}
