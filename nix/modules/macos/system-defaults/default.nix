{ lib, ... }:
let
  boolOption =
    default: description:
    lib.mkOption {
      type = lib.types.bool;
      inherit default description;
    };

  intOption =
    default: description:
    lib.mkOption {
      type = lib.types.int;
      inherit default description;
    };

  floatOption =
    default: description:
    lib.mkOption {
      type = lib.types.float;
      inherit default description;
    };
in
{
  flake.darwinModules.macos-system-defaults =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults = {
        enable = lib.mkEnableOption "macOS system defaults configuration";

        dock = {
          autohide = boolOption true "Automatically hide the dock";
          autohideDelay = floatOption 0.0 "Delay before dock auto-hides (seconds)";
          autohideTimeModifier = floatOption 0.15 "Speed of dock hide/show animation";
          orientation = lib.mkOption {
            type = lib.types.enum [
              "bottom"
              "left"
              "right"
            ];
            default = "right";
            description = "Dock position on screen";
          };
          tilesize = intOption 44 "Dock icon size in pixels";
          launchanim = boolOption false "Animate opening applications";
          minimizeToApplication = boolOption true "Minimize windows into application icon";
          showProcessIndicators = boolOption true "Show indicator lights for open applications";
          showRecents = boolOption false "Show recent applications in dock";
          persistentApps = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "List of persistent dock application paths";
          };
          exposeAnimationDuration = floatOption 0.2 "Mission Control animation duration";
          exposeGroupApps = boolOption true "Group windows by application in Mission Control";
          mruSpaces = boolOption false "Automatically rearrange Spaces by recent use";
          appswitcherAllDisplays = boolOption false "Show the app switcher on all displays";
          hotCornerTopLeft = intOption 1 "Hot corner action for top-left";
          hotCornerTopRight = intOption 12 "Hot corner action for top-right";
          hotCornerBottomLeft = intOption 1 "Hot corner action for bottom-left";
          hotCornerBottomRight = intOption 4 "Hot corner action for bottom-right";
        };

        finder = {
          showExtensions = boolOption true "Show all filename extensions";
          showHiddenFiles = boolOption true "Show hidden files";
          showPathBar = boolOption true "Show the path bar";
          showStatusBar = boolOption true "Show the status bar";
          showPosixPath = boolOption true "Show the full POSIX path in Finder titles";
          defaultView = lib.mkOption {
            type = lib.types.enum [
              "icnv"
              "Nlsv"
              "clmv"
              "Flwv"
            ];
            default = "Nlsv";
            description = "Default Finder view style";
          };
          quitMenuItem = boolOption false "Allow quitting Finder with Cmd+Q";
        };

        trackpad = {
          tapToClick = boolOption true "Enable tap to click";
          naturalScrolling = boolOption true "Enable natural scrolling";
          threeFingerDrag = boolOption false "Enable three-finger drag";
          rightClick = boolOption true "Enable two-finger right click";
          swipeNavigateWithScrolls = boolOption true "Enable two-finger page navigation";
          actuationStrength = intOption 1 "Trackpad click actuation strength";
          showAppExposeGesture = boolOption true "Enable the App Expose gesture";
          showMissionControlGesture = boolOption true "Enable the Mission Control gesture";
        };

        keyboard = {
          keyRepeat = intOption 2 "Key repeat rate";
          initialKeyRepeat = intOption 15 "Delay before key repeat starts";
          disablePressAndHold = boolOption true "Use key repeat instead of accent selection";
          fnUsageType = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Function-key behavior, or null for the system default";
          };
        };

        screencapture = {
          format = lib.mkOption {
            type = lib.types.enum [
              "png"
              "jpg"
              "pdf"
              "tiff"
              "gif"
              "bmp"
            ];
            default = "png";
            description = "Screenshot file format";
          };
          location = lib.mkOption {
            type = lib.types.str;
            default = "~/Screenshots";
            description = "Screenshot save location";
          };
          disableShadow = boolOption true "Disable shadows in window screenshots";
          includeDate = boolOption true "Include the date in screenshot filenames";
        };

        global = {
          darkMode = boolOption true "Enable dark mode";
          autoSwitchTheme = boolOption false "Automatically switch between light and dark mode";
          reduceMotion = boolOption false "Reduce user-interface motion";
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults = {
          dock = {
            inherit (cfg.dock) autohide;
            autohide-delay = cfg.dock.autohideDelay;
            autohide-time-modifier = cfg.dock.autohideTimeModifier;
            inherit (cfg.dock) orientation;
            inherit (cfg.dock) tilesize;
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
            showAppExposeGestureEnabled = cfg.trackpad.showAppExposeGesture;
            showMissionControlGestureEnabled = cfg.trackpad.showMissionControlGesture;
          };

          finder = {
            AppleShowAllExtensions = cfg.finder.showExtensions;
            AppleShowAllFiles = cfg.finder.showHiddenFiles;
            ShowPathbar = cfg.finder.showPathBar;
            ShowStatusBar = cfg.finder.showStatusBar;
            _FXShowPosixPathInTitle = cfg.finder.showPosixPath;
            FXPreferredViewStyle = cfg.finder.defaultView;
            QuitMenuItem = cfg.finder.quitMenuItem;
          };

          trackpad = {
            Clicking = cfg.trackpad.tapToClick;
            TrackpadRightClick = cfg.trackpad.rightClick;
            TrackpadThreeFingerDrag = cfg.trackpad.threeFingerDrag;
          };

          NSGlobalDomain = {
            "com.apple.swipescrolldirection" = cfg.trackpad.naturalScrolling;
            AppleEnableSwipeNavigateWithScrolls = cfg.trackpad.swipeNavigateWithScrolls;
            KeyRepeat = cfg.keyboard.keyRepeat;
            InitialKeyRepeat = cfg.keyboard.initialKeyRepeat;
            ApplePressAndHoldEnabled = !cfg.keyboard.disablePressAndHold;
            AppleInterfaceStyle =
              if cfg.global.autoSwitchTheme then
                null
              else if cfg.global.darkMode then
                "Dark"
              else
                null;
            AppleInterfaceStyleSwitchesAutomatically = cfg.global.autoSwitchTheme;
            AppleShowAllExtensions = cfg.finder.showExtensions;
            AppleShowAllFiles = cfg.finder.showHiddenFiles;
            NSAutomaticWindowAnimationsEnabled = !cfg.global.reduceMotion;
          };

          screencapture = {
            type = cfg.screencapture.format;
            inherit (cfg.screencapture) location;
            disable-shadow = cfg.screencapture.disableShadow;
            include-date = cfg.screencapture.includeDate;
          };

          CustomUserPreferences."com.apple.AppleMultitouchTrackpad" = {
            ActuationStrength = cfg.trackpad.actuationStrength;
          };
        };
      };
    };
}
