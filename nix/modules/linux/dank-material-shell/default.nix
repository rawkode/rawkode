{ inputs, lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "dank-material-shell";
  linux.home = {
    imports = [
      inputs.dms.homeModules.dank-material-shell
      inputs.dms.homeModules.niri
    ];

    stylix.targets.dank-material-shell.enable = true;

    programs.dank-material-shell = {
      enable = true;
      niri = {
        enableKeybinds = true;
        includes.enable = false;
      };
      settings = {
        acLockTimeout = 600;
        batteryLockTimeout = 600;
        acMonitorTimeout = 1800;
        batteryMonitorTimeout = 1800;
        lockBeforeSuspend = true;
        # Sleep when left idle on battery; stay awake on AC.
        batterySuspendTimeout = 1200;
        # 0 = Suspend; machines with working hibernation can opt into 2 = SuspendThenHibernate.
        batterySuspendBehavior = lib.mkDefault 0;
      };
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
