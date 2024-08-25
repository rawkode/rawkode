{ ... }:
let
  electron-flags = [
    "--ozone-platform-hint=auto"
    "--enable-webrtc-pipewire-capturer"
    "--enable-features=WaylandWindowDecorations"
    "--password-store=gnome-libsecret"
  ];
in
{
  modifications = final: prev: {
    vivaldi = prev.vivaldi.override { commandLineArgs = electron-flags; };
    vscode = prev.vscode.override { commandLineArgs = electron-flags; };
  };
}
