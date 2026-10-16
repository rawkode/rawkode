{ inputs, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "dank-material-shell";
  linux.home = {
    imports = [ inputs.dms.homeModules.dank-material-shell ];

    programs.dank-material-shell = {
      enable = true;
      systemd = {
        enable = true;
        target = "graphical-session.target";
      };
    };

    # niri-session imports the compositor environment before starting this target.
    systemd.user.services.dms.Unit.ConditionEnvironment = [
      "XDG_CURRENT_DESKTOP=niri"
      "WAYLAND_DISPLAY"
      "NIRI_SOCKET"
    ];
  };
}
