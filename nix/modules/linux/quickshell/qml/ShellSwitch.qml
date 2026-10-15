import QtQuick
import QtQuick.Controls

Switch {
    id: control
    implicitHeight: 30
    implicitWidth: 42
    padding: 3
    opacity: enabled ? 1 : 0.45
    indicator: Rectangle {
        x: 3
        y: (control.height - height) / 2
        width: 36
        height: 20
        radius: 10
        color: control.checked ? Settings.accent : Settings.raised
        border.width: control.visualFocus ? 2 : 1
        border.color: control.visualFocus ? Settings.text : control.checked ? Settings.accent : Settings.muted
        Rectangle {
            x: control.checked ? 18 : 2
            y: 2
            width: 16
            height: 16
            radius: 8
            color: control.checked ? Settings.background : Settings.text
        }
    }
    contentItem: Item {}
}
