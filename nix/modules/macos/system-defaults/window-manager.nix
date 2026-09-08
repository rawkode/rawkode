{
  flake.darwinModules.macos-system-defaults-window-manager =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.windowManager = {
        stageManager = lib.mkOption {
          type = lib.types.nullOr lib.types.bool;
          default = null;
          description = "Enable Stage Manager, or leave the current setting unmanaged";
        };
        hideDesktopItems = lib.mkOption {
          type = lib.types.nullOr lib.types.bool;
          default = null;
          description = "Hide desktop items while Stage Manager is active";
        };
        showAllAppWindows = lib.mkOption {
          type = lib.types.nullOr lib.types.bool;
          default = null;
          description = "Show all windows of an app at once in Stage Manager";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.WindowManager = {
          GloballyEnabled = cfg.windowManager.stageManager;
          HideDesktop = cfg.windowManager.hideDesktopItems;
          AppWindowGroupingBehavior = cfg.windowManager.showAllAppWindows;
        };
      };
    };
}
