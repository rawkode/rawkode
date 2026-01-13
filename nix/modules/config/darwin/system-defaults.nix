{
  flake.darwinModules.system-defaults =
    { config, lib, ... }:
    let
      cfg = config.rawkOS.darwin.systemDefaults;
    in
    {
      options.rawkOS.darwin.systemDefaults = {
        enable = lib.mkEnableOption "macOS system defaults configuration";

        dock = {
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
            description = "List of persistent dock applications (paths)";
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
            description = "Automatically rearrange Spaces based on most recent use";
          };

          appswitcherAllDisplays = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Show app switcher on all displays";
          };

          # Hot corners (1 = disabled, 2 = mission control, 3 = application windows,
          # 4 = desktop, 5 = start screen saver, 6 = disable screen saver,
          # 10 = put display to sleep, 11 = launchpad, 12 = notification center)
          hotCornerTopLeft = lib.mkOption {
            type = lib.types.int;
            default = 1;
            description = "Hot corner action for top-left";
          };

          hotCornerTopRight = lib.mkOption {
            type = lib.types.int;
            default = 12;
            description = "Hot corner action for top-right (12 = notification center)";
          };

          hotCornerBottomLeft = lib.mkOption {
            type = lib.types.int;
            default = 1;
            description = "Hot corner action for bottom-left";
          };

          hotCornerBottomRight = lib.mkOption {
            type = lib.types.int;
            default = 4;
            description = "Hot corner action for bottom-right (4 = desktop)";
          };
        };

        finder = {
          showExtensions = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show all filename extensions";
          };

          showHiddenFiles = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show hidden files";
          };

          showPathBar = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show path bar at bottom of Finder windows";
          };

          showStatusBar = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show status bar at bottom of Finder windows";
          };

          showPosixPath = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Show full POSIX path in Finder title bar";
          };

          defaultView = lib.mkOption {
            type = lib.types.enum [
              "icnv"
              "Nlsv"
              "clmv"
              "Flwv"
            ];
            default = "Nlsv";
            description = "Default Finder view (icnv=Icon, Nlsv=List, clmv=Column, Flwv=Gallery)";
          };

          quitMenuItem = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Allow quitting Finder via Cmd+Q";
          };
        };

        trackpad = {
          tapToClick = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable tap to click";
          };

          naturalScrolling = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable natural scrolling direction";
          };

          threeFingerDrag = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable three-finger drag";
          };

          rightClick = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable two-finger right click";
          };
        };

        keyboard = {
          keyRepeat = lib.mkOption {
            type = lib.types.int;
            default = 2;
            description = "Key repeat rate (lower = faster, 1-15)";
          };

          initialKeyRepeat = lib.mkOption {
            type = lib.types.int;
            default = 15;
            description = "Delay before key repeat starts (lower = faster, 10-120)";
          };

          disablePressAndHold = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Disable press-and-hold for character accents (enables key repeat)";
          };

          fnUsageType = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Function key behavior (null = default)";
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

          disableShadow = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Disable shadow in window screenshots";
          };

          includeDate = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Include date in screenshot filename";
          };
        };

        global = {
          darkMode = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable dark mode";
          };

          autoSwitchTheme = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Automatically switch between light and dark mode";
          };

          reduceMotion = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Reduce motion in UI animations";
          };
        };
      };

      config = lib.mkIf cfg.enable {
        system.defaults = {
          dock = {
            autohide = cfg.dock.autohide;
            autohide-delay = cfg.dock.autohideDelay;
            autohide-time-modifier = cfg.dock.autohideTimeModifier;
            orientation = cfg.dock.orientation;
            tilesize = cfg.dock.tilesize;
            launchanim = cfg.dock.launchanim;
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
            KeyRepeat = cfg.keyboard.keyRepeat;
            InitialKeyRepeat = cfg.keyboard.initialKeyRepeat;
            ApplePressAndHoldEnabled = !cfg.keyboard.disablePressAndHold;
            AppleInterfaceStyle = if cfg.global.darkMode then "Dark" else null;
            AppleInterfaceStyleSwitchesAutomatically = cfg.global.autoSwitchTheme;
            AppleShowAllExtensions = cfg.finder.showExtensions;
            AppleShowAllFiles = cfg.finder.showHiddenFiles;
            NSAutomaticWindowAnimationsEnabled = !cfg.global.reduceMotion;
          };

          screencapture = {
            type = cfg.screencapture.format;
            location = cfg.screencapture.location;
            disable-shadow = cfg.screencapture.disableShadow;
            include-date = cfg.screencapture.includeDate;
          };
        };
      };
    };
}
