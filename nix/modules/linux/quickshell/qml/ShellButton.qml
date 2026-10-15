import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Button {
    id: control
    property string glyph: ""
    property bool selected: false
    property bool primary: false
    property string description: text
    readonly property color ink: primary ? Settings.background : selected ? Settings.accent : Settings.text
    implicitHeight: 32
    implicitWidth: Math.max(32, contentItem.implicitWidth + leftPadding + rightPadding)
    padding: 10
    topPadding: 6
    bottomPadding: 6
    font.family: Settings.font
    font.pixelSize: 13
    opacity: enabled ? 1 : 0.45
    hoverEnabled: true
    Accessible.name: description
    ToolTip.visible: hovered && description !== ""
    ToolTip.text: description
    ToolTip.delay: 600
    background: Rectangle {
        radius: 6
        color: control.primary ? Settings.accent : control.selected ? Settings.tint(Settings.accent, control.hovered ? 0.24 : 0.14) : control.down || control.hovered ? Settings.blend(Settings.text, Settings.raised, 0.10) : control.flat ? "transparent" : Settings.raised
        border.width: control.visualFocus ? 1 : 0
        border.color: Settings.accent
    }
    contentItem: RowLayout {
        spacing: control.glyph !== "" && control.text !== "" ? 7 : 0
        ShellIcon {
            visible: control.glyph !== ""
            text: control.glyph
            color: control.ink
            font.pixelSize: 16
        }
        ShellText {
            visible: control.text !== ""
            text: control.text
            font: control.font
            color: control.ink
            elide: Text.ElideRight
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
        }
    }
}
