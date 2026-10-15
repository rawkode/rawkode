import QtQuick
import QtQuick.Controls

TextField {
    implicitHeight: 38
    padding: 10
    font.family: Settings.font
    font.pixelSize: 13
    color: Settings.text
    placeholderTextColor: Settings.muted
    selectionColor: Settings.accent
    selectedTextColor: Settings.background
    background: Rectangle {
        color: Settings.surface
        radius: 6
        border.width: 1
        border.color: parent.activeFocus ? Settings.accent : Settings.blend(Settings.text, Settings.background, 0.5)
    }
}
