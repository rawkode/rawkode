import QtQuick
import QtQuick.Layouts

Rectangle {
    id: row
    property string title: ""
    property string detail: ""
    property string glyph: ""
    property bool connected: false
    property string actionText: "Connect"
    property bool busy: false
    signal activated
    implicitHeight: 62
    color: connected ? Settings.tint(Settings.accent, 0.09) : "transparent"
    radius: 8
    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 10
        anchors.rightMargin: 8
        spacing: 12
        ShellIcon {
            text: row.glyph
            color: row.connected ? Settings.accent : Settings.muted
            Layout.preferredWidth: 22
        }
        ColumnLayout {
            Layout.fillWidth: true
            spacing: 4
            ShellText {
                text: row.title
                font.bold: row.connected
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
            ShellText {
                text: row.detail
                font.pixelSize: 11
                color: row.connected ? Settings.accent : Settings.muted
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
        }
        ShellButton {
            text: row.actionText
            description: text + " " + row.title
            flat: row.connected
            enabled: !row.busy
            onClicked: row.activated()
        }
    }
}
