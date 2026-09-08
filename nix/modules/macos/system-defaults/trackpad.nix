{
  flake.darwinModules.macos-system-defaults-trackpad =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults.trackpad = {
        tapToClick = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable tap to click";
        };
        forceClick = lib.mkOption {
          type = lib.types.nullOr lib.types.bool;
          default = null;
          description = "Enable Force Click, or leave the current setting unmanaged";
        };
        naturalScrolling = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable natural scrolling";
        };
        threeFingerDrag = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Enable three-finger drag";
        };
        rightClick = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable two-finger right click";
        };
        swipeNavigateWithScrolls = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable two-finger page navigation";
        };
        actuationStrength = lib.mkOption {
          type = lib.types.int;
          default = 1;
          description = "Trackpad click actuation strength";
        };
        showAppExposeGesture = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the App Expose gesture";
        };
        showMissionControlGesture = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the Mission Control gesture";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults = {
          dock = {
            showAppExposeGestureEnabled = cfg.trackpad.showAppExposeGesture;
            showMissionControlGestureEnabled = cfg.trackpad.showMissionControlGesture;
          };

          trackpad = {
            Clicking = cfg.trackpad.tapToClick;
            TrackpadRightClick = cfg.trackpad.rightClick;
            TrackpadThreeFingerDrag = cfg.trackpad.threeFingerDrag;
          };

          NSGlobalDomain = {
            "com.apple.swipescrolldirection" = cfg.trackpad.naturalScrolling;
            "com.apple.trackpad.forceClick" = cfg.trackpad.forceClick;
            AppleEnableSwipeNavigateWithScrolls = cfg.trackpad.swipeNavigateWithScrolls;
          };

          CustomUserPreferences."com.apple.AppleMultitouchTrackpad" = {
            ActuationStrength = cfg.trackpad.actuationStrength;
          };
        };
      };
    };
}
