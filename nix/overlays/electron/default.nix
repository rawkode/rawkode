{ ... }:
let
  electron-flags = [
    "--ozone-platform-hint=auto"
    "--enable-webrtc-pipewire-capturer"
    "--enable-features=WaylandWindowDecorations"
    "--password-store=gnome-libsecret"
  ];
in
final: prev: {
  vscode = prev.vscode.override { commandLineArgs = electron-flags; };
}
