_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "quickshell";
  linux.home =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      python = pkgs.python3.withPackages (p: [
        p.dbus-python
        p.pygobject3
      ]);
      connectivity = pkgs.writeShellScript "quickshell-connectivity" ''
        exec ${python}/bin/python3 -u ${./connectivity.py}
      '';
      shell = pkgs.runCommand "rawkode-quickshell" { } ''
        mkdir -p $out
        cp ${./qml}/* $out/
        cat > $out/Settings.qml <<'EOF'
        pragma Singleton
        import QtQuick
        QtObject {
          readonly property color background: "${config.lib.stylix.colors.withHashtag.base00}"
          readonly property color surface: "${config.lib.stylix.colors.withHashtag.base01}"
          readonly property color raised: "${config.lib.stylix.colors.withHashtag.base02}"
          readonly property color outline: "${config.lib.stylix.colors.withHashtag.base03}"
          readonly property color text: "${config.lib.stylix.colors.withHashtag.base05}"
          readonly property color accent: "${config.lib.stylix.colors.withHashtag.base0D}"
          readonly property color error: "${config.lib.stylix.colors.withHashtag.base08}"
          readonly property color success: "${config.lib.stylix.colors.withHashtag.base0B}"
          readonly property color muted: blend(text, background, 0.72)
          readonly property string iconFont: "Symbols Nerd Font Mono"
          readonly property int barHeight: 36
          function tint(color, opacity) { return Qt.rgba(color.r, color.g, color.b, opacity); }
          function blend(a, b, weight) { return Qt.rgba(a.r * weight + b.r * (1 - weight), a.g * weight + b.g * (1 - weight), a.b * weight + b.b * (1 - weight), 1); }
          readonly property string font: ${builtins.toJSON config.stylix.fonts.monospace.name}
          readonly property string connectivity: "${connectivity}"
        }
        EOF
      '';
      command = pkgs.writeShellApplication {
        name = "desktop-shell";
        text = ''
          exec ${lib.getExe pkgs.quickshell} --path ${shell}/shell.qml "$@"
        '';
      };
    in
    {
      home.packages = [
        command
        pkgs.quickshell
      ];
      # niri-session imports WAYLAND_DISPLAY/NIRI_SOCKET before starting this target.
      systemd.user.services.quickshell = {
        Unit = {
          Description = "Quickshell desktop for Niri";
          After = [ "graphical-session.target" ];
          PartOf = [ "graphical-session.target" ];
          ConditionEnvironment = [
            "XDG_CURRENT_DESKTOP=niri"
            "WAYLAND_DISPLAY"
            "NIRI_SOCKET"
          ];
        };
        Service = {
          ExecStart = lib.getExe command;
          Restart = "on-failure";
          RestartSec = 2;
          Environment = [
            "QT_QUICK_CONTROLS_STYLE=Basic"
            "PATH=${
              lib.makeBinPath [
                pkgs.niri
                pkgs.blueman
                pkgs.iwgtk
                pkgs.pavucontrol
                pkgs.hyprlock
                pkgs.systemd
              ]
            }"
          ];
        };
        Install.WantedBy = [ "graphical-session.target" ];
      };
    };
}
