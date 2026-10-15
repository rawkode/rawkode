# Quickshell desktop

The Linux desktop capability selects this shell instead of Ironbar. Niri no
longer imports SwayNC or starts the iwgtk indicator. Vicinae, SwayOSD, Hyprlock,
Hypridle, swww, and the GNOME Polkit agent remain in use.

`desktop-shell` starts the store-backed QML configuration. The user service is
scoped to Niri and the graphical session. After rebuilding, restart it with
`systemctl --user restart quickshell` to load a newly generated configuration.

## Controls

- Workspace buttons switch Niri workspaces on their output.
- Wi-Fi and BT open the shared connection panel; clicking again closes it.
- The bell opens notifications, history, and Do Not Disturb. The current Niri
  notification shortcut (`Command+N`) toggles this panel on the focused output.
- Clicking the same bar control again, Escape, or Close dismisses the panel.
  Notification popups do not take focus.
- Volume opens pavucontrol; tray items support activation and context menus.

The existing DP-2 workspace-only layout is preserved. Other outputs receive a
full bar. Workspace overflow can scroll horizontally.

## Connectivity

`connectivity.py` uses iwd and BlueZ directly over the system bus. It selects the
first Wi-Fi device and Bluetooth adapter. Wi-Fi supports open and personal
password networks, saved credentials, scanning, power, and disconnect. Other
authentication methods open iwgtk. Bluetooth supports power, discovery, and
connecting/disconnecting paired devices. Pairing opens Blueman for its prompts.

Passwords travel through the helper's stdin and iwd D-Bus agent, never command
arguments or diagnostic output. The agent accepts requests only from iwd and
unregisters when a connection attempt completes. No network backend migration
is required.

## Notifications and rollback

Notification history is in memory for the running shell. Reloads retain tracked
notifications; process restarts clear history. DND suppresses popups while
retaining notifications. At most three popups appear; critical notifications do
not automatically hide. Notification bodies are rendered as plain text.

Ironbar and SwayNC module definitions and the Ironbar input are retained during
the trial. To restore them declaratively, restore their desktop/Niri imports and
the previous notification binding, and remove the Quickshell capability import.
Only one notification daemon should run on the session bus at a time.

Runtime checks must cover tray menus, actual Wi-Fi authentication, Bluetooth
pairing, monitor hotplug/scaling, suspend/resume, and session teardown. Nix
evaluation alone does not establish those behaviors.
