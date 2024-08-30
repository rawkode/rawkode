{
  lib,
  osConfig,
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.plasma;
in
{
  config = mkIf cfg.enable {
    home.packages = with pkgs; [
      materia-kde-theme
      nordic
    ];

    programs.plasma = {
      enable = true;

      spectacle.shortcuts = {
        captureRectangularRegion = "Print";
      };

      windows.allowWindowsToRememberPositions = true;

      configFile = {
        "kactivitymanagerdrc"."activities"."aad84731-74d6-49c4-bad5-ba1676b3d8cc" = "General";
        "kactivitymanagerdrc"."activities-icons"."aad84731-74d6-49c4-bad5-ba1676b3d8cc" = "vivaldi";

        "kactivitymanagerdrc"."activities"."29c39fef-8a07-4f0d-90f8-ae33d02881a1" = "Live Stream";
        "kactivitymanagerdrc"."activities-icons"."29c39fef-8a07-4f0d-90f8-ae33d02881a1" = "camera-video";

        "kdeglobals"."General"."AccentColor" = "146,110,228";
        "kdeglobals"."General"."AllowKDEAppsToRememberWindowPositions" = true;

        "kdeglobals"."General"."TerminalApplication" = "wezterm start --cwd .";
        "kdeglobals"."General"."TerminalService" = "org.wezfurlong.wezterm.desktop";

        "kwinrc"."Effect-wobblywindows"."Drag" = 90;
        "kwinrc"."Effect-wobblywindows"."Stiffness" = 6;
        "kwinrc"."Effect-wobblywindows"."WobblynessLevel" = 2;

        "kwinrc"."NightColor"."Active" = true;
        "kwinrc"."NightColor"."LatitudeFixed" = 54.383218315466216;
        "kwinrc"."NightColor"."LongitudeFixed" = "-4.322097870527756";
        "kwinrc"."NightColor"."Mode" = "Location";

        "kwinrc"."Plugins"."cubeEnabled" = true;
        "kwinrc"."Plugins"."diminactiveEnabled" = true;
        "kwinrc"."Plugins"."fadedesktopEnabled" = false;
        "kwinrc"."Plugins"."slideEnabled" = true;
        "kwinrc"."Plugins"."wobblywindowsEnabled" = true;

        "kwinrc"."Windows"."SeparateScreenFocus" = true;
        "kwinrc"."Windows"."TitlebarDoubleClickCommand" = "Shade";

        "kwinrc"."Xwayland"."Scale" = 1.5;
      };

      powerdevil = {
        AC = {
          powerButtonAction = "lockScreen";
          turnOffDisplay = {
            idleTimeout = "never";
          };
        };
      };

      workspace = {
        lookAndFeel = "org.kde.breezedark.desktop";
        colorScheme = "BreezeDark";
        theme = "breeze-dark";
        iconTheme = "breeze-dark";
      };

      kscreenlocker = {
        autoLock = true;
        passwordRequired = true;
        lockOnResume = true;
        timeout = 10;
      };

      hotkeys.commands = {
        "lock" = {
          name = "Activate Screen Locker";
          key = "Meta+L";
          command = "lock";
        };
      };

      fonts = {
        general = {
          family = "Monaspace Argon";
          pointSize = 12;
        };

        fixedWidth = {
          family = "Monaspace Argon";
          pointSize = 12;
        };

        menu = {
          family = "Monaspace Argon";
          pointSize = 12;
        };

        windowTitle = {
          family = "Monaspace Argon";
          pointSize = 12;
        };

        small = {
          family = "Monaspace Argon";
          pointSize = 8;
        };

        toolbar = {
          family = "Monaspace Argon";
          pointSize = 12;
        };
      };

      kwin = {
        titlebarButtons = {
          left = [ ];
          right = [ "close" ];
        };

        effects = {
          desktopSwitching.animation = "slide";
          wobblyWindows.enable = true;
        };

        virtualDesktops = {
          number = 4;
          rows = 4;
        };
      };

      shortcuts = {
        ksmserver = {
          "Lock Session" = [
            "Screensaver"
            "Meta+L"
          ];
        };

        "services/org.kde.krunner.desktop"."_launch" = [ "Meta+Space" ];

        plasmashell = {
          "manage activities" = [ "Meta+Shift+Return" ];
          "next activity" = "Meta+Shift+PgDown,none,Walk through activities";
          "previous activity" = "Meta+Shift+PgUp,none,Walk through activities (Reverse)";

          "Activate Application Launcher" = [ ];
          "Activate Task Manager Entry 1" = [ ];
          "Activate Task Manager Entry 2" = [ ];
          "Activate Task Manager Entry 3" = [ ];
          "Activate Task Manager Entry 4" = [ ];
        };

        kwin = {
          "Close Window" = "Meta+Q";
          "Kill Window" = "Meta+Shift+Q";

          "Window Maximize" = "Meta+Return";
          "Window Minimize" = "";

          "Quick Tile Window to the Top" = [ ];

          "Switch to Desktop 1" = "Meta+1";
          "Switch to Desktop 2" = "Meta+2";
          "Switch to Desktop 3" = "Meta+3";
          "Switch to Desktop 4" = "Meta+4";

          "Cube" = "Ctrl+Up";
          "Overview" = "Ctrl+Down";

          "Switch to Previous Screen" = "Meta+Left";
          "Switch to Next Screen" = "Meta+Right";

          "Switch to Previous Desktop" = "Meta+PgUp";
          "Switch to Next Desktop" = "Meta+PgDown";
        };
      };

      panels = [
        {
          location = "bottom";
          height = 42;
          widgets = [
            "org.kde.plasma.marginsseparator"
            "org.kde.plasma.panelspacer"
            "org.kde.plasma.systemtray"
            "org.kde.plasma.digitalclock"
          ];
        }
      ];
    };
  };
}
