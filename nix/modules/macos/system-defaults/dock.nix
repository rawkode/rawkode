{
  flake.darwinModules.macos-system-defaults-dock =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.dock = {
        autohide = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Automatically hide the dock";
        };
        autohideDelay = lib.mkOption {
          type = lib.types.float;
          default = 0.0;
          description = "Delay before dock auto-hides (seconds)";
        };
        autohideTimeModifier = lib.mkOption {
          type = lib.types.float;
          default = 0.15;
          description = "Speed of dock hide/show animation";
        };
        orientation = lib.mkOption {
          type = lib.types.enum [
            "bottom"
            "left"
            "right"
          ];
          default = "right";
          description = "Dock position on screen";
        };
        tilesize = lib.mkOption {
          type = lib.types.int;
          default = 44;
          description = "Dock icon size in pixels";
        };
        magnification = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Magnify Dock icons on hover";
        };
        magnifiedSize = lib.mkOption {
          type = lib.types.ints.between 16 128;
          default = 128;
          description = "Magnified Dock icon size in pixels";
        };
        launchanim = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Animate opening applications";
        };
        minimizeToApplication = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Minimize windows into application icon";
        };
        showProcessIndicators = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Show indicator lights for open applications";
        };
        showRecents = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show recent applications in dock";
        };
        persistentApps = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "List of persistent dock application paths";
        };
        exposeAnimationDuration = lib.mkOption {
          type = lib.types.float;
          default = 0.2;
          description = "Mission Control animation duration";
        };
        exposeGroupApps = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Group windows by application in Mission Control";
        };
        mruSpaces = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Automatically rearrange Spaces by recent use";
        };
        appswitcherAllDisplays = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Show the app switcher on all displays";
        };
        hotCornerTopLeft = lib.mkOption {
          type = lib.types.int;
          default = 1;
          description = "Hot corner action for top-left";
        };
        hotCornerTopRight = lib.mkOption {
          type = lib.types.int;
          default = 12;
          description = "Hot corner action for top-right";
        };
        hotCornerBottomLeft = lib.mkOption {
          type = lib.types.int;
          default = 1;
          description = "Hot corner action for bottom-left";
        };
        hotCornerBottomRight = lib.mkOption {
          type = lib.types.int;
          default = 4;
          description = "Hot corner action for bottom-right";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults.dock = {
          inherit (cfg.dock) autohide;
          autohide-delay = cfg.dock.autohideDelay;
          autohide-time-modifier = cfg.dock.autohideTimeModifier;
          inherit (cfg.dock) orientation;
          inherit (cfg.dock) tilesize;
          inherit (cfg.dock) magnification;
          largesize = cfg.dock.magnifiedSize;
          inherit (cfg.dock) launchanim;
          minimize-to-application = cfg.dock.minimizeToApplication;
          show-process-indicators = cfg.dock.showProcessIndicators;
          show-recents = cfg.dock.showRecents;
          persistent-apps = cfg.dock.persistentApps;
          expose-animation-duration = cfg.dock.exposeAnimationDuration;
          expose-group-apps = cfg.dock.exposeGroupApps;
          mru-spaces = cfg.dock.mruSpaces;
          appswitcher-all-displays = cfg.dock.appswitcherAllDisplays;
          wvous-tl-corner = cfg.dock.hotCornerTopLeft;
          wvous-tr-corner = cfg.dock.hotCornerTopRight;
          wvous-bl-corner = cfg.dock.hotCornerBottomLeft;
          wvous-br-corner = cfg.dock.hotCornerBottomRight;
        };
      };
    };
}
