import QtQuick
import Quickshell

ShellRoot {
    Variants {
        model: Quickshell.screens
        delegate: Scope {
            required property var modelData
            Bar {
                id: bar
                screen: modelData
            }
            ControlPanel {
                output: modelData
            }
            Toasts {
                output: modelData
            }
        }
    }
}
