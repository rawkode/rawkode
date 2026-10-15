import QtQuick
import QtQuick.Layouts
import Quickshell

Rectangle {
    id: card
    required property var notification
    property bool toast: false
    color: Settings.surface
    radius: 10
    border.width: notification.urgency === 2 ? 1 : 0
    border.color: Settings.error
    implicitHeight: layout.implicitHeight + 28
    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: 14
        spacing: 10
        RowLayout {
            spacing: 8
            Image {
                visible: String(source) !== ""
                source: card.notification.appIcon === "" ? "" : card.notification.appIcon.startsWith("/") || card.notification.appIcon.includes(":") ? card.notification.appIcon : Quickshell.iconPath(card.notification.appIcon)
                sourceSize.width: 18
                sourceSize.height: 18
                Layout.preferredWidth: 18
                Layout.preferredHeight: 18
                fillMode: Image.PreserveAspectFit
            }
            ShellText {
                text: card.notification.appName || "Notification"
                color: Settings.muted
                font.pixelSize: 11
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
            ShellText {
                visible: card.notification.urgency === 2
                text: "Important"
                color: Settings.error
                font.pixelSize: 11
            }
            ShellButton {
                glyph: "󰅖"
                description: card.toast ? "Hide notification" : "Dismiss notification"
                flat: true
                implicitHeight: 24
                implicitWidth: 24
                padding: 3
                onClicked: {
                    if (card.toast)
                        Desktop.hideToast(card.notification.id);
                    else
                        card.notification.dismiss();
                }
            }
        }
        ShellText {
            text: card.notification.summary
            font.pixelSize: 14
            font.bold: true
            wrapMode: Text.Wrap
            Layout.fillWidth: true
        }
        ShellText {
            visible: text !== ""
            text: card.notification.body
            color: Settings.muted
            wrapMode: Text.Wrap
            maximumLineCount: card.toast ? 5 : 30
            elide: Text.ElideRight
            lineHeight: 1.2
            Layout.fillWidth: true
        }
        Image {
            visible: String(source) !== ""
            source: card.notification.image
            Layout.fillWidth: true
            Layout.preferredHeight: visible ? 120 : 0
            fillMode: Image.PreserveAspectFit
        }
        Flow {
            visible: card.notification.actions.length > 0
            Layout.fillWidth: true
            spacing: 6
            Repeater {
                model: card.notification.actions
                ShellButton {
                    required property var modelData
                    width: Math.min(implicitWidth, layout.width)
                    text: modelData.text
                    onClicked: {
                        modelData.invoke();
                        Desktop.hideToast(card.notification.id);
                    }
                }
            }
        }
    }
    Timer {
        interval: card.notification.expireTimeout > 0 ? card.notification.expireTimeout * 1000 : 10000
        running: card.toast && card.notification.urgency !== 2 && card.notification.expireTimeout !== 0
        onTriggered: {
            Desktop.hideToast(card.notification.id);
            if (card.notification.transient)
                card.notification.expire();
        }
    }
}
