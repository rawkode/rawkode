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
            AppleEnableSwipeNavigateWithScrolls = cfg.trackpad.swipeNavigateWithScrolls;
          };

          CustomUserPreferences."com.apple.AppleMultitouchTrackpad" = {
            ActuationStrength = cfg.trackpad.actuationStrength;
          };
        };
      };
    };
}
